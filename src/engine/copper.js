// Copper Edge engine — Pyth XCU/USD spot (unverified) + Massive CPER chain +
// Kalshi KXCOPPERMON.
//
// SPOT FEED CAVEAT — see docs/COMMODITY_FEEDS.md:
//   - No Pyth feed ID is configured for XCU/USD. pyth.js will throw on poll;
//     getPrice('XCU/USD') returns null. The engine fails open: snapshot is
//     skipped, no DB write.
//   - COMMODITIES.copper.enabled is false until a spot feed is wired in. The
//     engine ships as scaffolding so adding the feed = one config change.

import { computeSnapshot, discoverEvent } from './commodity-base.js';
import { COMMODITIES } from './commodities.js';

const CONFIG = COMMODITIES.copper;

export const COPPER_SERIES = CONFIG.seriesTicker;
export const COPPER_UNDERLYING_ETF = CONFIG.underlyingEtf;
export const COPPER_PYTH_SYMBOL = CONFIG.pythSymbol;

export function discoverCopperEvent() {
  return discoverEvent(CONFIG);
}

export function computeCopperSnapshot(event, opts) {
  return computeSnapshot(CONFIG, event, opts);
}
