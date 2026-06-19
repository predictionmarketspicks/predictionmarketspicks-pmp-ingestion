# Bitcoin Edge Phase 2 — Live Kalshi taxonomy verification (BLOCKER findings)

**Date:** 2026-06-18 (BTC off-hours) · **Branch:** `bitcoin-edge-phase2-horizons`
**Verifies/corrects:** `prediction-marketspicks/handoffs/BITCOIN_EDGE_FREQUENCY_SEO_EXPANSION_2026-06-18.md` Phase 2.

## What the handoff assumed
Phase 2 = "Daily/Weekly/Monthly KXBTC ... same N(d₂) options model, different IBIT expiry."
Guessed tickers `KXBTC` (daily), `KXBTCW` (weekly), `KXBTCM` (monthly).

## What the live Kalshi API actually shows (`/series?category=Crypto`, authoritative)
- `KXBTCW`, `KXBTCM` **do not exist** (0 markets). `KXBTC` is **hourly** (range), not daily.
- The clean **above/below-at-strike** structure that maps to vanilla IBIT N(d₂) exists **only hourly**: `KXBTCD` (above/below) + `KXBTC` (range). No KX daily/weekly/monthly above/below series.
- Longer-horizon BTC series that DO exist are mostly **one-touch max/min barrier** markets, NOT European above/below:
  - weekly: `KXBTCMAXW` ("how high this week"), `KXBTCVSETH/SOL/HYPE`
  - monthly: `KXBTCMAXM`, `KXBTCMAXMON`, `KXBTCMINMON`
  - quarterly: `KXBTCQ` (EOQ range — European), `KXBTCMAXQ` (one-touch)
  - annual: `KXBTCY` (EOY range — European), `KXBTCMAXY`, `KXBTCMINY`, `KXBTCMINMAXY`
- **Pricing-model consequence:** one-touch max/min ≠ vanilla European. They need a **barrier-option model** (running-max distribution / reflection principle), NOT the existing N(d₂) back-solve. That is Phase-3-grade R&D, not the "cheap reuse" the handoff promised. Only the **range/EOQ/EOY** series (`KXBTCQ`, `KXBTCY`) are true European reuse — and `KXBTCY` is already referenced in `engine/lib/kalshi.ts`.

## Liquidity reality at probe time (BTC off-hours, 2026-06-18)
| series | open mkts | 24h vol |
|---|---|---|
| KXBTCY (annual range) | 28 | **0** |
| KXBTCMAXY (annual max) | 7 | **0** |
| KXBTCQ / KXBTCMAXQ / KXBTCMAXW / KXBTCMAXM / KXBTCMAXMON / KXBTCMINMON / KXBTCMAXD | **0 open** | 0 |

Every weekly/monthly/quarterly series had **zero open markets** at this hour, and the only open longer-dated (annual) series had **zero 24h volume**. Per `feedback_kalshi_stale_series` (validate `volume_24h>0` before building) there is **no liquid longer-horizon BTC market to point an engine at right now.**

## Recommendation
Do **not** build the Phase 2 engine blind against closed / 0-volume markets. Re-probe during US market hours (when weekly/monthly events list live) and confirm `volume_24h > 0` before writing engine code. The genuine "cheap N(d₂) reuse" win is narrow (annual/quarterly **range**, `KXBTCY`/`KXBTCQ`); the weekly/monthly SEO demand maps to **one-touch barrier** markets = real R&D.

## Engine wiring notes (for whenever a liquid target is confirmed)
- Config lives in `src/engine/commodities.js` → `COMMODITIES.bitcoin`. A horizon variant = a sibling config entry reusing `commodity-base.js` `computeSnapshot`/`discoverEvent`, with its own `seriesTicker`, `eventFilter`, and **slower cadence** (Benny's Phase 2 rule: longer-dated IV is stable — write a few times/day, do NOT poll the 15s hourly tick; `snapshotIntervalMarketMs` must be large).
- `bitcoin.js` is a thin wrapper over the config — add `bitcoin-<horizon>.js` siblings, do NOT touch the live hourly path.
- Storage: add a `horizon` discriminator to `commodity_edge_signals` rows; keep hourly byte-identical.
- One-touch series would need a NEW pricing fn (not `optProb`/N(d₂)) — out of scope for "cheap reuse."
