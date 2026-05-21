// SPX Edge engine — Pyth SPY/USD spot + Databento SPY.OPT chain + Kalshi
// KXINXU (HOURLY strike events, 7 settles/weekday 10am–4pm ET, .INX cash
// settlement with Kalshi as Source Agency per contract terms).
//
// Same compute path as silver/gold/oil/bitcoin via commodity-base.js. The
// Pyth SPY/USD feed is RTH-gated by Pyth (0930–1600 ET) — exact match to
// the KXINXU trading window, so the off-hours basis-mismatch concern that
// motivates pauseSnapshotsOffHours on bitcoin doesn't even apply here:
// every feed in the stack converges on the same window. The pause flag is
// still set in commodities.js for weekend safety.
//
// commodities.js spx.eventFilter restricts the engine to the 7 hourly
// settles per weekday (H1000–H1600). Pre-launch checklist lives at
// handoffs/SP500_EDGE_ENGINE_2026-05-21.md; do not flip
// commodities.spx.enabled to true until Phase 0 (Fly DATABENTO_SYMBOLS
// soak with SPY added) passes.

import { computeSnapshot, discoverEvent } from './commodity-base.js';
import { COMMODITIES } from './commodities.js';

const CONFIG = COMMODITIES.spx;

export const SPX_SERIES = CONFIG.seriesTicker;
export const SPX_UNDERLYING_ETF = CONFIG.underlyingEtf;
export const SPX_PYTH_SYMBOL = CONFIG.pythSymbol;

export function discoverSpxEvent() {
  return discoverEvent(CONFIG);
}

export function computeSpxSnapshot(event, opts) {
  return computeSnapshot(CONFIG, event, opts);
}
