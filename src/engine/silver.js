// Silver Edge engine — Pyth XAG/USD spot + Massive SLV chain + Kalshi KXSILVERW.
// Phase 2A reduced this file to a thin wrapper around commodity-base.js. The
// shared compute path is identical to what shipped in Phase 1 — refactor only,
// no methodology change.

import { computeSnapshot, discoverEvent } from './commodity-base.js';
import { COMMODITIES } from './commodities.js';

const CONFIG = COMMODITIES.silver;

export const SILVER_SERIES = CONFIG.seriesTicker;
export const SILVER_UNDERLYING_ETF = CONFIG.underlyingEtf;
export const SILVER_PYTH_SYMBOL = CONFIG.pythSymbol;

export function discoverSilverEvent() {
  return discoverEvent(CONFIG);
}

export function computeSilverSnapshot(event, opts) {
  return computeSnapshot(CONFIG, event, opts);
}
