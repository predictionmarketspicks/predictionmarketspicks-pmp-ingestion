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
SHORT-HORIZON realized-vol model (the Phase-3 path) — NOT the N(d2) options
engine. This backtest mirrors the production probAboveTwap() from
src/engine/options.js exactly, fed with realized vol from 1-min BTC candles
instead of the live Pyth tick buffer (src/engine/short-horizon-vol.js).

Labels: Kalshi settled KXBTC15M markets (result yes/no).
Spot/vol: Coinbase free 1-min BTC-USD candles (no key, no new deps).

Pure stdlib (urllib) — honors the repo "no axios / native fetch" spirit and
adds zero dependencies. Offline/analysis only; touches nothing live.
"""
import json, math, time, urllib.request, urllib.parse
from datetime import datetime, timezone

KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
COINBASE = "https://api.exchange.coinbase.com/products/BTC-USD/candles"
SECONDS_PER_YEAR = 365 * 24 * 3600
TWAP_WINDOW_SEC = 60
MINUTES_PER_YEAR = 365 * 24 * 60
VOL_LOOKBACK_MIN = 15          # trailing minutes for realized-vol estimate
DECISION_OFFSETS_SEC = [600, 300, 120]  # decision points before close (T-10, T-5, T-2)
SIGMA_MIN, SIGMA_MAX = 0.10, 5.0        # annualized clamps (mirror short-horizon-vol.js)


def http_json(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pmp-btc15m-backtest"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


# ---------- labels ----------
def fetch_labels(max_pages=6):
    """Page settled KXBTC15M markets -> list of {close_ts, target, up}."""
    out, cursor = [], None
    for _ in range(max_pages):
        params = {"series_ticker": "KXBTC15M", "limit": 1000, "status": "settled"}
        if cursor:
            params["cursor"] = cursor
        d = http_json(f"{KALSHI}/markets?{urllib.parse.urlencode(params)}")
        for m in d.get("markets", []):
            res = m.get("result")
            ct = m.get("close_time")
            k = m.get("floor_strike")
            if res not in ("yes", "no") or not ct or k is None:
                continue
            out.append({"close_ts": parse_iso(ct), "target": float(k), "up": 1 if res == "yes" else 0})
        cursor = d.get("cursor")
        if not cursor:
            break
    out.sort(key=lambda r: r["close_ts"])
    return out


# ---------- price series ----------
def fetch_candles(start_ts, end_ts):
    """Coinbase 1-min candles -> dict{minute_ts: close}. Pages in 300-min chunks."""
    closes = {}
    cur = start_ts
    while cur < end_ts:
        chunk_end = min(cur + 300 * 60, end_ts)
        url = f"{COINBASE}?{urllib.parse.urlencode({'granularity':60,'start':iso(cur),'end':iso(chunk_end)})}"
        rows = http_json(url)
        for row in rows:  # [time, low, high, open, close, volume]
            closes[int(row[0])] = float(row[4])
        cur = chunk_end
        time.sleep(0.25)  # be polite to the public endpoint
    return closes


def spot_at(closes, ts):
    """Nearest 1-min close at or before ts, within 3 min."""
    m = int(ts // 60 * 60)
    for back in range(0, 4):
        v = closes.get(m - back * 60)
        if v is not None:
            return v
    return None


def realized_sigma(closes, ts, lookback_min):
    """Annualized vol from trailing 1-min log returns."""
    prices = []
    m = int(ts // 60 * 60)
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
    sigma_min = math.sqrt(var)
    sigma_ann = sigma_min * math.sqrt(MINUTES_PER_YEAR)
    return max(SIGMA_MIN, min(SIGMA_MAX, sigma_ann))


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
    vol_t = sigma * math.sqrt(var_t)
    d2 = (math.log(S / K) + (mu - 0.5 * sigma * sigma) * drift_t) / vol_t
    return norm_cdf(d2)


# ---------- backtest ----------
def calibration_report(rows, offset):
    buckets = {}  # decile -> [n, sum_outcome, sum_prob]
    briers, n = 0.0, 0
    correct = 0
    for r in rows:
        p = r["prob"]
        o = r["up"]
        b = min(9, int(p * 10))
        agg = buckets.setdefault(b, [0, 0, 0.0])
        agg[0] += 1; agg[1] += o; agg[2] += p
        briers += (p - o) ** 2
        if (p >= 0.5) == (o == 1):
            correct += 1
        n += 1
    print(f"\n=== decision T-{offset//60}min · n={n} · "
          f"Brier={briers/n:.4f} · directional_acc={correct/n:.1%} ===")
    print("  prob_bucket   n   model_avg   realized_up")
    for b in sorted(buckets):
        cnt, up, sp = buckets[b]
        print(f"   {b/10:.1f}-{b/10+0.1:.1f}   {cnt:4d}    {sp/cnt:.3f}      {up/cnt:.3f}")


def main():
    print("Fetching KXBTC15M settled labels ...")
    labels = fetch_labels()
    print(f"  {len(labels)} labeled windows, {iso(labels[0]['close_ts'])} -> {iso(labels[-1]['close_ts'])}")
    start = labels[0]["close_ts"] - VOL_LOOKBACK_MIN * 60 - max(DECISION_OFFSETS_SEC) - 120
    end = labels[-1]["close_ts"] + 120
    print(f"Fetching Coinbase 1-min candles {iso(start)} -> {iso(end)} ...")
    closes = fetch_candles(start, end)
    print(f"  {len(closes)} candles")

    for offset in DECISION_OFFSETS_SEC:
        rows = []
        for lab in labels:
            dt = lab["close_ts"] - offset
            S = spot_at(closes, dt)
            sigma = realized_sigma(closes, dt, VOL_LOOKBACK_MIN)
            if S is None or sigma is None:
                continue
            T = offset / SECONDS_PER_YEAR
            p = prob_above_twap(S, lab["target"], T, 0.0, sigma)
            rows.append({"prob": p, "up": lab["up"]})
        if rows:
            calibration_report(rows, offset)
        else:
            print(f"\n=== T-{offset//60}min: no aligned rows ===")


if __name__ == "__main__":
    main()
