# Commodity feed verification

Status of every spot feed the engine reads from. The Phase 2A engines for oil
and copper are scaffolded but `enabled: false` in `src/engine/commodities.js`
until the spot path is resolved. Engines fail open — when `getPrice()` returns
null, the snapshot is skipped (logged warn, no DB write).

| Commodity | Kalshi series | ETF | Pyth symbol | Feed ID verified | `enabled` | Notes |
|-----------|---------------|-----|-------------|------------------|-----------|-------|
| silver    | `KXSILVERW`   | SLV | `XAG/USD`   | ✅ verified       | `true`    | Kalshi `series.settlement_sources` confirmed |
| gold      | `KXGOLDW`     | GLD | `XAU/USD`   | ✅ verified       | `true`    | Kalshi `series.settlement_sources` confirmed |
| oil       | `KXWTI`       | USO | `WTI`       | ❌ unverified     | `false`   | See "Oil spot path" below |
| copper    | `KXCOPPERMON` | CPER | `XCU/USD`  | ❌ unconfigured   | `false`   | See "Copper spot path" below |

## Oil spot path — known gap

Pyth Hermes serves crude oil as **per-expiry futures** (e.g. `WTIM6`, `WTIN6`),
not a continuous front-month feed. The placeholder ID inherited from
`commodity_edge/src/pyth.py` is unverified and will likely 404 against the live
Hermes API.

The retired Python pipeline (`commodity_edge/scripts/run_oil_edge.py`, removed
2026-05-04) used `yfinance CL=F` (NYMEX continuous front-month) as a workaround.
That's not portable to a Node service on Fly without Python, so the Node engine
keeps oil disabled until one of the resolutions below ships.

**Resolution options** (pick one before flipping `oil.enabled = true`):

1. **Verify a continuous Pyth WTI feed.** Curl `https://hermes.pyth.network/v2/price_feeds`
   and grep for "WTI" or "Crude". If a continuous feed exists, drop its ID into
   `FEED_IDS` in `src/feeds/pyth.js`.
2. **Roll a per-expiry strategy.** The engine could pick the front-month Pyth
   feed each Monday and roll on expiry. Adds ~30 LOC + a calendar; matches what
   CL=F does conceptually.
3. **Massive futures endpoint.** If Massive (rebrand of Polygon) has a futures
   endpoint that surfaces CL=F or `I:WTI`, use it like `fetchPrevClose` already
   does for ETFs. Needs API plan verification.
4. **Alternative oracle.** ChainLink's Crude feed, an OilPriceAPI-style HTTP
   endpoint, etc. Each adds a new auth surface.

Option 1 is cheapest if a feed exists; option 3 is cleanest if Massive serves
it (one less provider).

## Copper spot path — known gap

No `XCU/USD` Pyth feed is configured. Pyth has historically not published a
continuous copper feed; COMEX HG futures are the dominant venue and Pyth ships
HG per-expiry only.

**Resolution options:**

1. **Verify Pyth XCU/USD or copper continuous.** Same `/v2/price_feeds` lookup
   as oil. If a feed exists, add to `FEED_IDS`.
2. **Roll HG per-expiry.** Same pattern as oil option 2.
3. **CPER NAV-derived spot.** CPER tracks the CME copper futures index
   (SPGSCITR). If a Massive endpoint serves SPGSCI we can read it directly.
4. **External oracle** (ChainLink, LBMA-style fix, etc.).

Until a feed lands, copper engine boots, registers feed slots, and produces
no rows. Discord receives no copper alerts. Mature graceful degradation.

## How to flip a commodity to enabled

1. Add a verified Pyth feed ID (or an alternative spot path) for the commodity.
2. Update `src/engine/commodities.js`:
   ```js
   oil: { ..., enabled: true }
   ```
3. Drop the unverified caveat from the commodity engine file's header.
4. Run `npm test` (the registry test will need its expectations updated).
5. Smoke locally: `MASSIVE_API_KEY=… node src/index.js`, `curl /dev/snapshot?commodity=oil`,
   confirm a row lands in `commodity_edge_signals` with `commodity='oil'`.

## Bridge week vs. real-time cutover

These notes are independent of `WRITER_TAG`. The Mon/Tue 2026-05-04/05 cutover
flips `WRITER_TAG=delayed_test → intraday`, lighting up Discord + ISR
revalidation for **enabled** commodities. Disabled commodities stay invisible
either way until their spot path is resolved.

The delta filter `0.15 ≤ |Δ| ≤ 0.85` is currently a no-op for the bridge-week
delayed tier (greeks: {} on weekends and off-hours; missing-delta passthrough).
After cutover, greeks populate live and the filter activates — chain shrinks
from ~250 contracts → ~50–80 per ETF, keeping the in-memory map manageable
across multiple commodities.
