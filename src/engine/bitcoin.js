// Bitcoin Edge engine — Pyth BTC/USD spot + Databento IBIT.OPT chain
// + Kalshi KXBTCD (HOURLY strike events, BRTI 60-sec TWAP at top of hour).
// Same compute path as silver/gold/oil via commodity-base.js — Phase 4 of
// the Databento rollout. Pyth BTC/USD is the canonical 24/7 spot; IBIT
// chain is OPRA-hours only, so commodities.js sets pauseSnapshotsOffHours
// to keep stale-smile + moving-spot artifacts off the public surface.
// commodities.js bitcoin.eventFilter further restricts the engine to the
// 7 hourly settles per weekday (10 AM – 4 PM ET) that are covered by a
// live IBIT chain. Other 17 daily settles + weekends are correctly dark.

import { computeSnapshot, discoverEvent } from './commodity-base.js';
import { COMMODITIES } from './commodities.js';

const CONFIG = COMMODITIES.bitcoin;

export const BITCOIN_SERIES = CONFIG.seriesTicker;
export const BITCOIN_UNDERLYING_ETF = CONFIG.underlyingEtf;
export const BITCOIN_PYTH_SYMBOL = CONFIG.pythSymbol;

export function discoverBitcoinEvent() {
  return discoverEvent(CONFIG);
}

export function computeBitcoinSnapshot(event, opts) {
  return computeSnapshot(CONFIG, event, opts);
}
