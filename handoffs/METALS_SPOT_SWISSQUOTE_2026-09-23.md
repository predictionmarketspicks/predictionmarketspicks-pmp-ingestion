# Gold/silver spot → Swissquote (Pythnet XAU/XAG dead) — 2026-09-23

**Status**: SHIPPED — see the commit that adds `src/feeds/swissquote.js`; site-repo monitor `scripts/check-metals-spot-proxy.mjs` + `metals-spot-proxy.yml` + table `metals_spot_marks`.

## What broke
- Pythnet XAU/USD + XAG/USD price accounts stopped updating ~2026-09-22 13:18 UTC. `pythnet.rpcpool.com` → 403; `api2.pythnet.pyth.network` → serves a price a day old (the feed's age gate refused it, correctly).
- The engines kept writing rows carrying the last good spot: gold 4,338.347 / silver 65.9469, flagged by `commodity-spot-freshness.yml`. On 2026-09-22 the 17:00 ET settle was gold 4,358.47 / silver 67.06 — our frozen spot was −$20.12 / −$1.11 off.
- Every free Pyth path is closed: Hermes 401 (since 2026-08-26), Benchmarks `/v1/updates/price/latest` 401.

## What Kalshi actually settles on (verify: `curl -s https://api.elections.kalshi.com/trade-api/v2/series/KXGOLDD | jq .series.settlement_sources`)
- KXGOLDD / KXGOLD15M → `Metal.Index.1OZGOLD/USD` (Pyth Pro id 3712, "Pyth price in USD for 1-ounce gold 24/7").
- KXSILVERD / KXSILVER15M → `Metal.Index.SILVER/USD` (id 3154).
- Both `is_gated: true` (`curl -s 'https://app.pyth.com/api/price-feeds/Metal.Index.1OZGOLD%2FUSD' | jq .is_gated`), single publisher (Douro Labs). **Not readable without a paid Pyth Pro key.** The Pythnet XAU/USD we read until today was itself a proxy, not the settlement feed.
- 15m rule (`rules_primary`): YES iff the 1-minute candle close at the boundary ≥ the previous boundary's close (`strike_type: greater_or_equal`). Dailies settle 17:00 ET (21:00Z).

## Options measured
| Candidate | Verdict |
|---|---|
| Pyth Pro / Hermes (exact) | $500/mo — not bought |
| **Swissquote public quote** (`forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD`) | **chosen** — 3 servers, sub-second, two-sided, 24/5 |
| Yahoo GC=F / SI=F | rejected — ~10 min delayed and futures (+≈$34 vs spot on gold, 2026-09-23) |
| Databento GLD/SLV (OPRA put-call parity) | rejected as primary — ETF not metal, market hours only, internal-only licence |
| Stooq | bot-challenge wall — not used |

## Evidence
FX-spot mid (Dukascopy tick data, last tick ≤ boundary) vs Kalshi's own `expiration_value` / `result`, last 4 days of 15m windows:

| Series | Windows | Verdict agreement | Median abs err | p90 | Max |
|---|---|---|---|---|---|
| KXGOLD15M | 244 | **100.0%** | $0.115 | $0.42 | $1.32 |
| KXSILVER15M | 256 | **98.8%** | $0.003 | $0.0105 | $0.142 |

Daily 17:00 ET (spot at 20:59:59Z vs settle): gold −3.20 / −0.42 / −0.18 / −1.32; silver +0.083 / −0.005 / −0.009 / +0.141 (9/15, 9/16, 9/17, 9/22).

Swissquote itself, live, 2026-09-23 16:45Z: gold **4,286.50 vs settle 4,286.51**; silver **64.5866 vs 64.587** — both verdicts agree.

## What shipped
- `src/feeds/swissquote.js`: per server the tightest-profile mid; price = median of fresh servers; refuses when servers disagree by > 4× spread; confidence = half-spread (so the existing 1% wide-print rule applies); closed market → last print + real timestamp + `trading:false` (engines' `maxSpotAgeMs` decides, as with Pythnet). Tests `test/feeds.swissquote.test.js`.
- `src/feeds/pyth.js`: XAU/USD + XAG/USD route to Swissquote; `spot_source` rows now say `swissquote_xau_usd` / `swissquote_xag_usd`. Health-feed keys stay `pyth_xau_usd` / `pyth_xag_usd` (slot names wired into the readiness gate). BTC / SPY / WTI untouched.
- Settle-boundary marks → `metals_spot_marks`; scored every 3h by the site repo's checker (alert: < 95% agreement, or median error > $0.50 gold / $0.015 silver).

## Open
- Weekends: Kalshi's index is 24/7; spot is 24/5. Weekend/holiday windows run on a stale print that the engines' age gates refuse — measure before trusting any weekend market.
- If the checker ever breaches, the fallback is Pyth Pro ($500/mo), not another proxy.
