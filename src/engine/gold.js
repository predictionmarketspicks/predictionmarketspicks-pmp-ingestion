// Gold Edge engine — Pyth XAU/USD spot + Massive GLD chain + Kalshi KXGOLDW.
// Same compute path as silver via commodity-base.js. Pyth XAU/USD is verified
// against KXGOLDW's settlement_sources (Phase B Python pipeline confirmed).

import { computeSnapshot, discoverEvent } from './commodity-base.js';
import { COMMODITIES } from './commodities.js';

const CONFIG = COMMODITIES.gold;

export const GOLD_SERIES = CONFIG.seriesTicker;
export const GOLD_UNDERLYING_ETF = CONFIG.underlyingEtf;
export const GOLD_PYTH_SYMBOL = CONFIG.pythSymbol;

export function discoverGoldEvent() {
  return discoverEvent(CONFIG);
}

export function computeGoldSnapshot(event, opts) {
  return computeSnapshot(CONFIG, event, opts);
}
