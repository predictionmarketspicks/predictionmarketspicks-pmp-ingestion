// Oil Edge engine — Pyth WTI spot + Massive USO chain + Kalshi KXWTI.
// Same compute path as silver via commodity-base.js.
//
// SPOT FEED CAVEAT — see docs/COMMODITY_FEEDS.md for full notes:
//   - Pyth Hermes serves per-expiry WTI futures (WTIM6, …), not a continuous
//     feed. The placeholder ID inherited from commodity_edge/src/pyth.py is
//     unverified and will likely 404 against the live API.
//   - The Python pipeline punts to yfinance CL=F. The engine fails open: when
//     getPrice('WTI') returns null, the snapshot is skipped (logged warn, no
//     DB write).
//   - COMMODITIES.oil.enabled is false until the spot path is resolved. The
//     engine still imports cleanly and tests run against fixtures.

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
