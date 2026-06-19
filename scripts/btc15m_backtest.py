#!/usr/bin/env python3
"""
KXBTC15M 15-minute up/down — short-horizon fair-value backtest.

Contract (verified via Kalshi API 2026-06-18):
  Each KXBTC15M market = "BTC price up in next 15 mins?" YES settles if the
  60-second average of CF Benchmarks BRTI before window close >= target price,
  where target (floor_strike) == the prior window's settle (i.e. the price at
  window OPEN). So it is effectively P(BTC_close >= BTC_open) over a 15-min
  window with a 60-sec averaging tail.

No IBIT option is short-dated enough to price this, so the fair value is a
SHORT-HORIZON realized-vol + drift model (the Phase-3 path) — NOT the N(d2)
options engine. This backtest mirrors production probAboveTwap()
(src/engine/options.js) and the realized sigma/mu estimator
(src/engine/short-horizon-vol.js), fed with 1-min Coinbase BTC-USD candles
instead of the live Pyth tick buffer.

Two legs:
  (1) CALIBRATION  — model prob vs realized up/down outcome (full history).
  (2) ROI / EDGE   — model prob vs the live Kalshi market price (yes_bid/
      yes_ask from /candlesticks), side-aware post-spread, on a recent
      sample. Mirrors the production postSpreadGate: take YES when
      p_model - yes_ask >= edge floor, NO when yes_bid - p_model >= floor.

Pure stdlib (urllib) — no new deps. Offline/analysis only; touches nothing live.

Usage:  python3 scripts/btc15m_backtest.py [roi_sample_n]   (default 1500)
"""
import json, math, sys, time, urllib.request, urllib.parse
from datetime import datetime, timezone

KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
COINBASE = "https://api.exchange.coinbase.com/products/BTC-USD/candles"
SECONDS_PER_YEAR = 365 * 24 * 3600
MINUTES_PER_YEAR = 365 * 24 * 60
TWAP_WINDOW_SEC = 60
VOL_LOOKBACK_MIN = 15
DECISION_OFFSETS_SEC = [600, 300, 120]      # T-10, T-5, T-2 before close
SIGMA_MIN, SIGMA_MAX, MU_CAP = 0.10, 5.0, 3.0   # mirror short-horizon-vol.js
EDGE_FLOORS = [0.03, 0.05, 0.08]            # min model-vs-market edge to trade


def http_json(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pmp-btc15m-backtest"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            if i == tries - 1:
                return None
            time.sleep(1.2 * (i + 1))


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


# ---------- labels ----------
def fetch_labels(max_pages=6):
    out, cursor = [], None
    for _ in range(max_pages):
        p = {"series_ticker": "KXBTC15M", "limit": 1000, "status": "settled"}
        if cursor:
            p["cursor"] = cursor
        d = http_json(f"{KALSHI}/markets?{urllib.parse.urlencode(p)}")
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
    return out


# ---------- BTC price series (vol + spot) ----------
def fetch_candles(start_ts, end_ts):
    closes, cur = {}, start_ts
    while cur < end_ts:
        ce = min(cur + 300 * 60, end_ts)
        rows = http_json(f"{COINBASE}?{urllib.parse.urlencode({'granularity':60,'start':iso(cur),'end':iso(ce)})}")
        if rows:
            for r in rows:  # [time, low, high, open, close, volume]
                closes[int(r[0])] = float(r[4])
        cur = ce
        time.sleep(0.25)
    return closes


def spot_at(closes, ts):
    m = int(ts // 60 * 60)
    for b in range(4):
        v = closes.get(m - b * 60)
        if v is not None:
            return v
    return None


def realized_stats(closes, ts, lookback_min):
    """Annualized (sigma, mu) from trailing 1-min log returns — mirrors short-horizon-vol.js."""
    prices, m = [], int(ts // 60 * 60)
    for i in range(lookback_min + 1):
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
    sigma = max(SIGMA_MIN, min(SIGMA_MAX, math.sqrt(var) * math.sqrt(MINUTES_PER_YEAR)))
    mu = max(-MU_CAP, min(MU_CAP, mean * MINUTES_PER_YEAR))
    return sigma, mu


def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def prob_above_twap(S, K, T, mu, sigma, twap_sec=TWAP_WINDOW_SEC):
    """Faithful port of src/engine/options.js probAboveTwap (scale=1)."""
    if T <= 0:
        return 1.0 if S > K else 0.0
    tau_yr = twap_sec / SECONDS_PER_YEAR
    drift_t = max(T - tau_yr / 2, 0.0)
    var_t = max(T - (2 / 3) * tau_yr, T / 3)
    if sigma <= 0:
        return 1.0 if S * math.exp(mu * drift_t) > K else 0.0
    d2 = (math.log(S / K) + (mu - 0.5 * sigma * sigma) * drift_t) / (sigma * math.sqrt(var_t))
    return norm_cdf(d2)


# ---------- Kalshi market price (ROI leg) ----------
def fetch_market_quotes(lab):
    """Per-minute yes_bid/yes_ask within the market window -> {minute_ts:(bid,ask)}."""
    p = {"start_ts": int(lab["open_ts"]), "end_ts": int(lab["close_ts"]) + 60, "period_interval": 1}
    d = http_json(f"{KALSHI}/series/KXBTC15M/markets/{lab['ticker']}/candlesticks?{urllib.parse.urlencode(p)}")
    if not d:
        return {}
    q = {}
    for c in d.get("candlesticks", []):
        ts = int(c.get("end_period_ts", 0))
        yb = (c.get("yes_bid") or {}).get("close_dollars")
        ya = (c.get("yes_ask") or {}).get("close_dollars")
        try:
            bid, ask = float(yb), float(ya)
        except (TypeError, ValueError):
            continue
        if 0 < bid <= ask < 1:
            q[int(ts // 60 * 60)] = (bid, ask)
    return q


def quote_at(quotes, ts):
    m = int(ts // 60 * 60)
    for b in range(5):
        v = quotes.get(m - b * 60)
        if v is not None:
            return v
    return None


# ---------- reports ----------
def calibration_report(rows, offset):
    buckets, brier, correct = {}, 0.0, 0
    for r in rows:
        p, o = r["prob"], r["up"]
        agg = buckets.setdefault(min(9, int(p * 10)), [0, 0, 0.0])
        agg[0] += 1; agg[1] += o; agg[2] += p
        brier += (p - o) ** 2
        correct += (p >= 0.5) == (o == 1)
    n = len(rows)
    print(f"\n=== CALIBRATION T-{offset//60}min · n={n} · Brier={brier/n:.4f} · dir_acc={correct/n:.1%} ===")
    print("  bucket    n   model_avg  realized_up")
    for b in sorted(buckets):
        c, up, sp = buckets[b]
        print(f"   {b/10:.1f}-{b/10+0.1:.1f} {c:4d}    {sp/c:.3f}      {up/c:.3f}")


def roi_report(trades, offset, floor):
    if not trades:
        print(f"\n  ROI T-{offset//60}min floor={floor:.0%}: no trades")
        return
    n = len(trades)
    profit = sum(t["profit"] for t in trades)      # dollars per $1-notional contract
    cost = sum(t["cost"] for t in trades)
    wins = sum(1 for t in trades if t["profit"] > 0)
    yes_n = sum(1 for t in trades if t["side"] == "YES")
    print(f"  ROI T-{offset//60}min floor={floor:.0%}: trades={n} "
          f"(YES {yes_n}/NO {n-yes_n}) · win={wins/n:.1%} · "
          f"avg_edge={sum(t['edge'] for t in trades)/n:+.3f} · "
          f"profit/contract={100*profit/n:+.2f}c · ROI_on_cost={profit/cost:+.1%}")


def main():
    roi_n = int(sys.argv[1]) if len(sys.argv) > 1 else 1500
    print("Fetching KXBTC15M settled labels ...")
    labels = fetch_labels()
    print(f"  {len(labels)} windows, {iso(labels[0]['close_ts'])} -> {iso(labels[-1]['close_ts'])}")
    start = labels[0]["close_ts"] - VOL_LOOKBACK_MIN * 60 - max(DECISION_OFFSETS_SEC) - 120
    end = labels[-1]["close_ts"] + 120
    print(f"Fetching Coinbase 1-min candles ...")
    closes = fetch_candles(start, end)
    print(f"  {len(closes)} candles")

    # attach model prob (with mu drift) at each decision offset
    for lab in labels:
        lab["model"] = {}
        for off in DECISION_OFFSETS_SEC:
            dt = lab["close_ts"] - off
            S = spot_at(closes, dt)
            st = realized_stats(closes, dt, VOL_LOOKBACK_MIN)
            if S is None or st is None:
                continue
            sigma, mu = st
            lab["model"][off] = prob_above_twap(S, lab["target"], off / SECONDS_PER_YEAR, mu, sigma)

    # (1) calibration — full history
    print("\n########## LEG 1: CALIBRATION (model vs realized, mu drift ON) ##########")
    for off in DECISION_OFFSETS_SEC:
        rows = [{"prob": lab["model"][off], "up": lab["up"]} for lab in labels if off in lab["model"]]
        if rows:
            calibration_report(rows, off)

    # (2) ROI vs Kalshi market price — recent sample
    sample = labels[-roi_n:]
    print(f"\n########## LEG 2: ROI vs KALSHI PRICE (last {len(sample)} windows) ##########")
    print("Fetching per-market candlesticks ...")
    for i, lab in enumerate(sample):
        lab["quotes"] = fetch_market_quotes(lab)
        if i % 250 == 0:
            print(f"  {i}/{len(sample)} ...")
        time.sleep(0.08)
    for off in DECISION_OFFSETS_SEC:
        for floor in EDGE_FLOORS:
            trades = []
            for lab in sample:
                if off not in lab["model"] or not lab.get("quotes"):
                    continue
                q = quote_at(lab["quotes"], lab["close_ts"] - off)
                if not q:
                    continue
                bid, ask = q
                p, o = lab["model"][off], lab["up"]
                if p - ask >= floor:                       # buy YES at ask
                    trades.append({"side": "YES", "edge": p - ask, "cost": ask,
                                   "profit": o - ask})
                elif bid - p >= floor:                     # buy NO at (1-bid)
                    trades.append({"side": "NO", "edge": bid - p, "cost": 1 - bid,
                                   "profit": (1 - o) - (1 - bid)})
            roi_report(trades, off, floor)


if __name__ == "__main__":
    main()
