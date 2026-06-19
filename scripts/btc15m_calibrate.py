#!/usr/bin/env python3
"""
KXBTC15M vol-side calibration — fixes the near-close under-confidence.

DIAGNOSIS (from btc15m_backtest.py): the model is well-calibrated at T-10min
but UNDER-confident as tau->0 (T-2min: model 0.85 -> realized 0.98; model 0.15
-> realized 0.05). Probabilities pulled toward 0.5 == effective volatility too
high (d2 = ln(S/K)/(sigma*sqrt(varT)) too small). The mu drift term did not fix
it, confirming the cause is sigma, not drift.

WHY sigma is overstated at short horizons:
  1. single-exchange 1-min close-to-close vol carries microstructure noise the
     smoothed CF Benchmarks BRTI settle does not;
  2. sqrt-time annualization assumes i.i.d. minute returns, but sub-minute BTC
     has negative autocorrelation (bid-ask bounce) -> multi-step variance grows
     SLOWER than linear -> projecting 1-min vol to a 2-10 min horizon overstates.
Both are captured by the variance ratio VR(h) = Var(h-min)/(h*Var(1-min)) < 1.

FIX: scale sigma by k(tau) = sqrt(VR(tau)). Validated two independent ways that
must agree, or it's overfitting:
  (A) model-free: measure VR(h) directly from the candles;
  (B) data-fit: fit the sigma multiplier minimizing log-loss on a CHRONOLOGICAL
      train split, evaluate OUT-OF-SAMPLE on the held-out test split.

Pure stdlib. Caches labels+candles to /tmp so iteration is instant/free.
Offline analysis; touches nothing live.
"""
import bisect, json, math, os, time, urllib.request, urllib.parse
from datetime import datetime, timezone

KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
COINBASE = "https://api.exchange.coinbase.com/products/BTC-USD/candles"
SPY = 365 * 24 * 3600
MIN_PER_YEAR = 365 * 24 * 60
TWAP_SEC = 60
VOL_LOOKBACK_MIN = 15
SIGMA_MIN, SIGMA_MAX, MU_CAP = 0.10, 5.0, 3.0
# Decision points across the 15-min window (sec before close). All >= 90s so the
# 60-sec averaging window [close-60, close] is still in the future -> the TWAP
# correction and the vol shrink stay cleanly separable.
OFFSETS = [120, 180, 240, 300, 420, 540, 660, 780]
TRAIN_FRAC = 0.70
EPS = 1e-6
CACHE = "/tmp/btc15m_cache"


def http_json(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pmp-btc15m-cal"})
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


# ---------- cached data ----------
def fetch_labels():
    out, cursor = [], None
    for _ in range(6):
        p = {"series_ticker": "KXBTC15M", "limit": 1000, "status": "settled"}
        if cursor:
            p["cursor"] = cursor
        d = http_json(f"{KALSHI}/markets?{urllib.parse.urlencode(p)}")
        if not d:
            break
        for m in d.get("markets", []):
            res, ct, k = m.get("result"), m.get("close_time"), m.get("floor_strike")
            if res not in ("yes", "no") or not ct or k is None:
                continue
            out.append({"close_ts": parse_iso(ct), "target": float(k), "up": 1 if res == "yes" else 0})
        cursor = d.get("cursor")
        if not cursor:
            break
    out.sort(key=lambda r: r["close_ts"])
    return out


def fetch_candles(a, b):
    closes, cur = {}, a
    while cur < b:
        ce = min(cur + 300 * 60, b)
        rows = http_json(f"{COINBASE}?{urllib.parse.urlencode({'granularity':60,'start':iso(cur),'end':iso(ce)})}")
        if rows:
            for r in rows:
                closes[int(r[0])] = float(r[4])
        cur = ce
        time.sleep(0.25)
    return closes


def load_data():
    os.makedirs(CACHE, exist_ok=True)
    lp, cp = f"{CACHE}/labels.json", f"{CACHE}/candles.json"
    if os.path.exists(lp) and os.path.exists(cp):
        with open(lp) as f:
            labels = json.load(f)
        with open(cp) as f:
            closes = {int(k): v for k, v in json.load(f).items()}
        print(f"[cache] {len(labels)} labels, {len(closes)} candles")
        return labels, closes
    print("Fetching labels ...")
    labels = fetch_labels()
    a = labels[0]["close_ts"] - VOL_LOOKBACK_MIN * 60 - max(OFFSETS) - 120
    b = labels[-1]["close_ts"] + 120
    print(f"Fetching candles {iso(a)} -> {iso(b)} ...")
    closes = fetch_candles(a, b)
    with open(lp, "w") as f:
        json.dump(labels, f)
    with open(cp, "w") as f:
        json.dump(closes, f)
    print(f"[fetched+cached] {len(labels)} labels, {len(closes)} candles")
    return labels, closes


# ---------- model (identical to btc15m_backtest.py / production probAboveTwap) ----------
def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def prob_above_twap(S, K, T, mu, sigma, twap_sec=TWAP_SEC):
    if T <= 0:
        return 1.0 if S > K else 0.0
    tau_yr = twap_sec / SPY
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


def realized_stats(closes, ts, lookback_min=VOL_LOOKBACK_MIN):
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
    sigma = max(SIGMA_MIN, min(SIGMA_MAX, math.sqrt(var) * math.sqrt(MIN_PER_YEAR)))
    mu = max(-MU_CAP, min(MU_CAP, mean * MIN_PER_YEAR))
    return sigma, mu


# ---------- variance ratio (model-free diagnostic A) ----------
def variance_ratio(closes, horizons_min):
    ts_sorted = sorted(closes)
    # 1-min log returns over contiguous minutes
    r1 = []
    for i in range(1, len(ts_sorted)):
        if ts_sorted[i] - ts_sorted[i - 1] == 60:
            a, b = closes[ts_sorted[i - 1]], closes[ts_sorted[i]]
            if a > 0 and b > 0:
                r1.append(math.log(b / a))
    v1 = sum((x - sum(r1) / len(r1)) ** 2 for x in r1) / (len(r1) - 1)
    out = {}
    cl = closes
    for h in horizons_min:
        rh = []
        for t in ts_sorted:
            t2 = t + h * 60
            if t2 in cl and cl[t] > 0 and cl[t2] > 0:
                # require the full h-minute span to be contiguous
                if all((t + j * 60) in cl for j in range(h + 1)):
                    rh.append(math.log(cl[t2] / cl[t]))
        if len(rh) > 30:
            mh = sum(rh) / len(rh)
            vh = sum((x - mh) ** 2 for x in rh) / (len(rh) - 1)
            out[h] = (vh / (h * v1), len(rh))
    return v1, out


# ---------- build calibration rows ----------
def build_rows(labels, closes):
    rows = []
    for lab in labels:
        for off in OFFSETS:
            dt = lab["close_ts"] - off
            S = spot_at(closes, dt)
            st = realized_stats(closes, dt)
            if S is None or st is None:
                continue
            sigma, mu = st
            rows.append({"close_ts": lab["close_ts"], "off": off, "S": S, "K": lab["target"],
                         "T": off / SPY, "sigma": sigma, "mu": mu, "up": lab["up"]})
    rows.sort(key=lambda r: r["close_ts"])
    return rows


def logloss(rows, k):
    s = 0.0
    for r in rows:
        p = prob_above_twap(r["S"], r["K"], r["T"], r["mu"], r["sigma"] * k)
        p = min(1 - EPS, max(EPS, p))
        s += -(r["up"] * math.log(p) + (1 - r["up"]) * math.log(1 - p))
    return s / len(rows)


def brier(rows, kfunc):
    s = 0.0
    for r in rows:
        p = prob_above_twap(r["S"], r["K"], r["T"], r["mu"], r["sigma"] * kfunc(r["off"]))
        s += (p - r["up"]) ** 2
    return s / len(rows)


def calib_table(rows, kfunc):
    b = {}
    for r in rows:
        p = prob_above_twap(r["S"], r["K"], r["T"], r["mu"], r["sigma"] * kfunc(r["off"]))
        agg = b.setdefault(min(9, int(p * 10)), [0, 0, 0.0])
        agg[0] += 1; agg[1] += r["up"]; agg[2] += p
    return b


def fit_k_grid(rows):
    best, bk = 1e9, 1.0
    k = 0.20
    while k <= 1.40001:
        ll = logloss(rows, k)
        if ll < best:
            best, bk = ll, k
        k += 0.01
    return round(bk, 3), best


# ---------- proper scoring + isotonic recalibration (the shape fix) ----------
def clip(p):
    return min(1 - EPS, max(EPS, p))


def LL(rows, pf):
    return sum(-(r["up"] * math.log(clip(pf(r))) + (1 - r["up"]) * math.log(1 - clip(pf(r)))) for r in rows) / len(rows)


def BR(rows, pf):
    return sum((clip(pf(r)) - r["up"]) ** 2 for r in rows) / len(rows)


def isotonic_fit(xy):
    """Pool-adjacent-violators: returns (sorted_xs, fitted_ys) monotone step fn."""
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


def calib_pf(rows, pf):
    b = {}
    for r in rows:
        p = pf(r)
        agg = b.setdefault(min(9, int(p * 10)), [0, 0, 0.0])
        agg[0] += 1; agg[1] += r["up"]; agg[2] += p
    return b


def main():
    labels, closes = load_data()
    print(f"  span {iso(labels[0]['close_ts'])} -> {iso(labels[-1]['close_ts'])}")

    print("\n########## DIAGNOSTIC A: variance ratio VR(h)=Var(h)/(h*Var(1)) ##########")
    v1, vr = variance_ratio(closes, [1, 2, 3, 5, 8, 10, 15])
    print(f"  1-min variance = {v1:.3e}  (sigma_1min_annual = {math.sqrt(v1*MIN_PER_YEAR):.2f})")
    print("   h(min)   VR(h)   sqrt(VR)=k_model_free   n")
    for h in sorted(vr):
        ratio, n = vr[h]
        print(f"    {h:5d}   {ratio:.3f}        {math.sqrt(ratio):.3f}            {n}")

    rows = build_rows(labels, closes)
    cut = int(len(rows) * TRAIN_FRAC)
    train, test = rows[:cut], rows[cut:]
    print(f"\nrows={len(rows)} (train={len(train)} test={len(test)}) "
          f"chronological split @ {iso(train[-1]['close_ts'])}")

    print("\n########## DIAGNOSTIC B: per-offset log-loss-optimal k (TRAIN only) ##########")
    print("  offset(s)  k_fit(train)   vs sqrt(VR) for nearest h")
    k_by_off = {}
    for off in OFFSETS:
        tr = [r for r in train if r["off"] == off]
        k, _ = fit_k_grid(tr)
        k_by_off[off] = k
        hmin = round(off / 60)
        ref = math.sqrt(vr.get(hmin, vr.get(min(vr, key=lambda x: abs(x - hmin))))[0])
        print(f"    {off:6d}      {k:.3f}          {ref:.3f}")

    # proposed k(tau): interpolation table from the TRAIN fits (robust, no form risk)
    grid = sorted(k_by_off)

    def k_of(off):
        if off <= grid[0]:
            return k_by_off[grid[0]]
        if off >= grid[-1]:
            return min(1.0, k_by_off[grid[-1]])
        for i in range(1, len(grid)):
            if off <= grid[i]:
                a, b = grid[i - 1], grid[i]
                w = (off - a) / (b - a)
                return k_by_off[a] * (1 - w) + k_by_off[b] * w
        return 1.0

    # candidate probability functions
    def base_p(r):
        return prob_above_twap(r["S"], r["K"], r["T"], r["mu"], r["sigma"])

    def shr_p(r):
        return prob_above_twap(r["S"], r["K"], r["T"], r["mu"], r["sigma"] * k_of(r["off"]))

    # isotonic recalibration: fit baseline_prob -> outcome on TRAIN, apply to TEST.
    # POOLED (one map) and PER-OFFSET (one map per horizon, since miscalib is tau-dependent).
    iso_pool = isotonic_fit([(base_p(r), r["up"]) for r in train])
    iso_by_off = {off: isotonic_fit([(base_p(r), r["up"]) for r in train if r["off"] == off]) for off in OFFSETS}

    def isop_pool(r):
        return clip(iso_predict(iso_pool, base_p(r)))

    def isop_off(r):
        return clip(iso_predict(iso_by_off[r["off"]], base_p(r)))

    print("\n########## OUT-OF-SAMPLE (TEST) — proper log-loss + Brier (sign-bug fixed) ##########")
    print("  method                 log-loss   Brier   dir_acc")
    for name, pf in [("baseline (k=1)", base_p), ("sigma-shrink k(tau)", shr_p),
                     ("isotonic pooled", isop_pool), ("isotonic per-offset", isop_off)]:
        acc = sum((pf(r) >= 0.5) == (r["up"] == 1) for r in test) / len(test)
        print(f"  {name:22s} {LL(test, pf):.4f}   {BR(test, pf):.4f}   {acc:.1%}")

    for name, pf in [("BASELINE", base_p), ("ISOTONIC per-offset", isop_off)]:
        b = calib_pf(test, pf)
        print(f"\n  -- TEST calibration: {name} --")
        print("   bucket    n   model_avg  realized_up  gap")
        for bb in sorted(b):
            c, up, sp = b[bb]
            print(f"    {bb/10:.1f}-{bb/10+0.1:.1f} {c:5d}   {sp/c:.3f}     {up/c:.3f}    {sp/c-up/c:+.3f}")

    # stationarity check: does the TRAIN-fit miscalibration hold in TEST?
    print("\n########## STATIONARITY: mid-bucket gap (model-realized), TRAIN vs TEST, baseline ##########")
    for split_name, rs in [("TRAIN", train), ("TEST", test)]:
        b = calib_pf(rs, base_p)
        midn = sum(b[k][0] for k in b if 5 <= k <= 8)
        midup = sum(b[k][1] for k in b if 5 <= k <= 8)
        midp = sum(b[k][2] for k in b if 5 <= k <= 8)
        print(f"  {split_name}: mid-bucket(0.5-0.9) n={midn} model_avg={midp/midn:.3f} realized={midup/midn:.3f} gap={midp/midn-midup/midn:+.3f}")


if __name__ == "__main__":
    main()
