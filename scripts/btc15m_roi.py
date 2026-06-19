#!/usr/bin/env python3
"""
KXBTC15M ROI — fee-realistic, raw vs recalibrated probs, regime-split.

Builds on btc15m_backtest.py / btc15m_calibrate.py. Answers the real question:
does the model (and the per-offset isotonic recalibration) produce edge that
SURVIVES Kalshi fees + the spread, and is it YES/NO-balanced (robust) or
NO-skewed (an Apr-Jun regime artifact)?

Discipline:
  - Taker fill at the touch (buy YES at yes_ask, buy NO at 1-yes_bid) -> spread
    cost already paid. Kalshi taker fee = 0.07 * P * (1-P) per contract on entry;
    settlement is free and we hold to settle -> one-sided fee.
  - Gate on EXPECTED NET edge after fees (the real trader's decision), not gross.
  - Recalibration (per-offset isotonic) fit on TRAIN ONLY; ROI reported on the
    held-out TEST period (no lookahead). TRAIN ROI shown only for regime contrast.
  - Reuses cached candles from btc15m_calibrate. Caches Kalshi quotes (resumable).

Pure stdlib. Offline; touches nothing live.
"""
import bisect, json, math, os, time, urllib.request, urllib.parse
from datetime import datetime, timezone

KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
SPY = 365 * 24 * 3600
TWAP_SEC = 60
VOL_LOOKBACK_MIN = 15
SIGMA_MIN, SIGMA_MAX, MU_CAP = 0.10, 5.0, 3.0
CACHE = "/tmp/btc15m_cache"
TRAIN_FRAC = 0.70
ROI_OFFSETS = [600, 300]        # T-10min (primary, realistic to act on), T-5min
STRIDE = 2                      # sample every Nth window for quote fetch (both periods)
FEE_COEFF = 0.07               # Kalshi taker fee coefficient
NET_FLOORS = [0.00, 0.01, 0.02]  # min expected net profit per contract ($) to trade
EPS = 1e-6


def http_json(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pmp-btc15m-roi"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            if i == tries - 1:
                return None
            time.sleep(1.2 * (i + 1))


def iso8601(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


# ---------- labels WITH ticker+open (own cache) + candle cache reuse ----------
def load_labels_full():
    p = f"{CACHE}/labels_full.json"
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    out, cursor = [], None
    for _ in range(6):
        q = {"series_ticker": "KXBTC15M", "limit": 1000, "status": "settled"}
        if cursor:
            q["cursor"] = cursor
        d = http_json(f"{KALSHI}/markets?{urllib.parse.urlencode(q)}")
        if not d:
            break
        for m in d.get("markets", []):
            res, ct, ot, k = m.get("result"), m.get("close_time"), m.get("open_time"), m.get("floor_strike")
            if res not in ("yes", "no") or not ct or not ot or k is None:
                continue
            out.append({"ticker": m["ticker"], "open_ts": parse_iso(ot), "close_ts": parse_iso(ct),
                        "target": float(k), "up": 1 if res == "yes" else 0})
        cursor = d.get("cursor")
        if not cursor:
            break
    out.sort(key=lambda r: r["close_ts"])
    with open(p, "w") as f:
        json.dump(out, f)
    return out


def load_candles():
    with open(f"{CACHE}/candles.json") as f:
        return {int(k): v for k, v in json.load(f).items()}


def fetch_quotes(labels):
    """Per-window per-minute (bid,ask). Resumable cache keyed by ticker."""
    p = f"{CACHE}/quotes.json"
    cache = {}
    if os.path.exists(p):
        with open(p) as f:
            cache = json.load(f)
    todo = [l for l in labels if l["ticker"] not in cache]
    print(f"quotes: {len(cache)} cached, {len(todo)} to fetch")
    for i, lab in enumerate(todo):
        q = {"start_ts": int(lab["open_ts"]), "end_ts": int(lab["close_ts"]) + 60, "period_interval": 1}
        d = http_json(f"{KALSHI}/series/KXBTC15M/markets/{lab['ticker']}/candlesticks?{urllib.parse.urlencode(q)}")
        row = {}
        if d:
            for c in d.get("candlesticks", []):
                ts = int(c.get("end_period_ts", 0))
                yb = (c.get("yes_bid") or {}).get("close_dollars")
                ya = (c.get("yes_ask") or {}).get("close_dollars")
                try:
                    bid, ask = float(yb), float(ya)
                except (TypeError, ValueError):
                    continue
                if 0 < bid <= ask < 1:
                    row[str(int(ts // 60 * 60))] = [bid, ask]
        cache[lab["ticker"]] = row
        if i % 300 == 0:
            print(f"  {i}/{len(todo)} ...")
            with open(p, "w") as f:
                json.dump(cache, f)
        time.sleep(0.07)
    with open(p, "w") as f:
        json.dump(cache, f)
    return cache


# ---------- model (identical to backtest/production) ----------
def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def prob_above_twap(S, K, T, mu, sigma):
    if T <= 0:
        return 1.0 if S > K else 0.0
    tau_yr = TWAP_SEC / SPY
    drift_t = max(T - tau_yr / 2, 0.0)
    var_t = max(T - (2 / 3) * tau_yr, T / 3)
    if sigma <= 0:
        return 1.0 if S * math.exp(mu * drift_t) > K else 0.0
    d2 = (math.log(S / K) + (mu - 0.5 * sigma * sigma) * drift_t) / (sigma * math.sqrt(var_t))
    return norm_cdf(d2)


def spot_at(closes, ts):
    m = int(ts // 60 * 60)
    for bk in range(4):
        v = closes.get(m - bk * 60)
        if v is not None:
            return v
    return None


def realized_stats(closes, ts):
    prices, m = [], int(ts // 60 * 60)
    for i in range(VOL_LOOKBACK_MIN + 1):
        v = closes.get(m - i * 60)
        if v is not None:
            prices.append(v)
    if len(prices) < 6:
        return None
    prices = prices[::-1]
    rets = [math.log(prices[i] / prices[i - 1]) for i in range(1, len(prices)) if prices[i - 1] > 0]
    if len(rets) < 5:
        return None
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    sigma = max(SIGMA_MIN, min(SIGMA_MAX, math.sqrt(var) * math.sqrt(365 * 24 * 60)))
    mu = max(-MU_CAP, min(MU_CAP, mean * 365 * 24 * 60))
    return sigma, mu


def quote_at(qrow, ts):
    m = int(ts // 60 * 60)
    for bk in range(5):
        v = qrow.get(str(m - bk * 60))
        if v is not None:
            return v[0], v[1]
    return None


# ---------- isotonic (PAV), fit on train ----------
def isotonic_fit(xy):
    xy = sorted(xy)
    xs = [x for x, _ in xy]
    val, wt, cnt = [], [], []
    for _, yi in xy:
        val.append(float(yi)); wt.append(1.0); cnt.append(1)
        while len(val) > 1 and val[-2] > val[-1]:
            nv = (val[-1] * wt[-1] + val[-2] * wt[-2]) / (wt[-1] + wt[-2])
            nw = wt[-1] + wt[-2]; nc = cnt[-1] + cnt[-2]
            val.pop(); wt.pop(); cnt.pop()
            val[-1] = nv; wt[-1] = nw; cnt[-1] = nc
    fitted = []
    for v, c in zip(val, cnt):
        fitted += [v] * c
    return xs, fitted


def iso_predict(model, x):
    xs, fitted = model
    i = bisect.bisect_left(xs, x)
    if i <= 0:
        return fitted[0]
    if i >= len(xs):
        return fitted[-1]
    x0, x1 = xs[i - 1], xs[i]
    if x1 == x0:
        return fitted[i]
    w = (x - x0) / (x1 - x0)
    return fitted[i - 1] * (1 - w) + fitted[i] * w


def fee(price):
    return FEE_COEFF * price * (1 - price)


def main():
    labels = load_labels_full()
    closes = load_candles()
    cut = int(len(labels) * TRAIN_FRAC)
    train_cut_ts = labels[cut]["close_ts"]
    sample = labels[::STRIDE]
    print(f"{len(labels)} windows; sampling every {STRIDE} -> {len(sample)}; "
          f"train/test split @ {iso8601(train_cut_ts)}")
    quotes = fetch_quotes(sample)

    # build decision rows: model + outcome + best quote at decision time
    rows = []
    for lab in sample:
        period = "train" if lab["close_ts"] < train_cut_ts else "test"
        qrow = quotes.get(lab["ticker"], {})
        for off in ROI_OFFSETS:
            dt = lab["close_ts"] - off
            S = spot_at(closes, dt)
            st = realized_stats(closes, dt)
            q = quote_at(qrow, dt)
            if S is None or st is None or q is None:
                continue
            sigma, mu = st
            p = prob_above_twap(S, lab["target"], off / SPY, mu, sigma)
            rows.append({"period": period, "off": off, "p": p, "bid": q[0], "ask": q[1], "up": lab["up"]})

    # fit per-offset isotonic on TRAIN baseline probs only
    iso_by_off = {off: isotonic_fit([(r["p"], r["up"]) for r in rows if r["period"] == "train" and r["off"] == off])
                  for off in ROI_OFFSETS}

    def recal(r):
        return min(1 - EPS, max(EPS, iso_predict(iso_by_off[r["off"]], r["p"])))

    print(f"\nFee model: Kalshi taker {FEE_COEFF:.0%}*P*(1-P)/contract on entry, settle free.")
    print("Gate: take the side with positive EXPECTED NET edge (after fee) >= floor.\n")

    def run(period, off, source, floor):
        prob = (lambda r: r["p"]) if source == "raw" else recal
        trades = []
        for r in rows:
            if r["period"] != period or r["off"] != off:
                continue
            p = prob(r)
            A, bid = r["ask"], r["bid"]
            yes_net = p - A - fee(A)              # expected net profit/contract, YES
            no_net = bid - p - fee(1 - bid)       # expected net profit/contract, NO
            if yes_net >= floor and yes_net >= no_net:
                cost = A + fee(A)
                realized = r["up"] - A - fee(A)
                trades.append(("YES", cost, realized))
            elif no_net >= floor:
                cost = (1 - bid) + fee(1 - bid)
                realized = (1 - r["up"]) - (1 - bid) - fee(1 - bid)
                trades.append(("NO", cost, realized))
        if not trades:
            return None
        n = len(trades)
        prof = sum(t[2] for t in trades)
        cost = sum(t[1] for t in trades)
        wins = sum(1 for t in trades if t[2] > 0)
        yes = sum(1 for t in trades if t[0] == "YES")
        return dict(n=n, yes=yes, no=n - yes, win=wins / n, roi=prof / cost,
                    cpc=100 * prof / n)

    for off in ROI_OFFSETS:
        print(f"================= DECISION T-{off//60}min =================")
        print(f"  {'period/source':20s} {'floor':>5s} {'trades':>7s} {'YES/NO':>9s} {'win':>6s} {'netROI':>8s} {'net c/contract':>14s}")
        for period in ("test", "train"):
            for source in ("raw", "recal"):
                tag = f"{period}/{source}" + ("*" if (period == "train" and source == "recal") else "")
                for floor in NET_FLOORS:
                    res = run(period, off, source, floor)
                    if res:
                        print(f"  {tag:20s} {floor:>5.2f} {res['n']:>7d} {res['yes']:>4d}/{res['no']:<4d} "
                              f"{res['win']:>6.1%} {res['roi']:>+8.1%} {res['cpc']:>+13.2f}c")
                    else:
                        print(f"  {tag:20s} {floor:>5.2f}     no trades")
        print("  (* train/recal is IN-SAMPLE — recal fit on train; judge recal on test rows only)")
        print()


if __name__ == "__main__":
    main()
