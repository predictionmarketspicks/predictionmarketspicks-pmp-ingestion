// Oil Edge engine — Yahoo CL=F / CLM26.NYM spot + Databento USO.OPT chain
// + Kalshi KXWTI. Same compute path as silver/gold via commodity-base.js;
// only the spot source differs (useYahooSpot flag in commodities.js).
//
// Pyth Hermes serves WTI as per-expiry futures (WTIM6, ...), not a continuous
// feed, so it's not viable for our 24/5 spot loop. Yahoo CL=F covers
// Globex/Asia overnight; contract-aware CLM26.NYM pins the IV smile to the
// specific CME contract Kalshi KXWTI markets settle on. Chain moved off
// Yahoo onto Databento USO.OPT on 2026-05-16 (hybrid migration).

import { computeSnapshot, discoverEvent } from './commodity-base.js';
import { COMMODITIES } from './commodities.js';

const CONFIG = COMMODITIES.oil;

export const OIL_SERIES = CONFIG.seriesTicker;
export const OIL_UNDERLYING_ETF = CONFIG.underlyingEtf;
export const OIL_PYTH_SYMBOL = CONFIG.pythSymbol;

export function discoverOilEvent() {
  return discoverEvent(CONFIG);
}

export function computeOilSnapshot(event, opts) {
  return computeSnapshot(CONFIG, event, opts);
}
