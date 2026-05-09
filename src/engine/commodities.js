// Per-commodity static config — single registry consumed by every engine
// (silver/gold/oil/copper) and by the multi-engine bootstrap in src/index.js.
//
// Each entry is plan §10 input. Adding a commodity = one entry here + one thin
// wrapper file in src/engine/. The shared compute fn in commodity-base.js
// reads the rest from the row passed in.
//
// Spot/chain feed source per commodity (May 9 2026):
//   silver  Pyth XAG/USD  + Massive SLV chain   (verified, real-time)
//   gold    Pyth XAU/USD  + Massive GLD chain   (verified, real-time)
//   oil     Yahoo CL=F    + Yahoo USO chain     (15-min delayed, free, fragile —
//                                                see src/feeds/yahoo-oil.js)
//   copper  Pyth XCU/USD  — UNVERIFIED, no Pyth feed ID configured. Engine
//                           fails open when getPrice() returns null.
//
// Per-commodity `useYahooOil` flag flips the compute path in commodity-base.js
// to source spot + chain from src/feeds/yahoo-oil.js instead of pyth + massive.
// Per-commodity `bypassWriterTag` flag exempts a feed from the WRITER_TAG
// gate that suppresses Discord posts + Vercel revalidation. Used for oil so
// it can post normally while silver/gold remain gated under delayed_test
// awaiting their replacement real-time source.
//
// `enabled` flag: false = engine bootstraps but no-ops. Lets the multi-engine
// scheduler ship without a real feed source for copper. Flip to true once
// the spot feed is wired.

import {
  SNAPSHOT_INTERVAL_MARKET_MS,
  SNAPSHOT_INTERVAL_OFF_MS,
  SNAPSHOT_INTERVAL_EXPIRATION_MS,
} from './thresholds.js';

export const COMMODITIES = {
  silver: {
    commodity: 'silver',
    seriesTicker: 'KXSILVERW',
    underlyingEtf: 'SLV',
    pythSymbol: 'XAG/USD',
    spotUnit: '$/oz',
    spotLabel: 'Pyth XAG/USD',
    enabled: true,
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
  },
  gold: {
    commodity: 'gold',
    seriesTicker: 'KXGOLDW',
    underlyingEtf: 'GLD',
    pythSymbol: 'XAU/USD',
    spotUnit: '$/oz',
    spotLabel: 'Pyth XAU/USD',
    enabled: true,
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
  },
  oil: {
    commodity: 'oil',
    seriesTicker: 'KXWTI',
    underlyingEtf: 'USO',
    pythSymbol: 'WTI', // not used when useYahooOil is true; kept for shape parity
    spotUnit: '$/bbl',
    spotLabel: 'Yahoo CL=F (15-min delayed)',
    enabled: true,
    useYahooOil: true,
    bypassWriterTag: true,
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
  },
  copper: {
    commodity: 'copper',
    seriesTicker: 'KXCOPPERMON',
    underlyingEtf: 'CPER',
    pythSymbol: 'XCU/USD',
    spotUnit: '$/lb',
    spotLabel: 'Pyth XCU/USD (unverified)',
    enabled: false, // flip true once a copper spot feed is wired
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
  },
};

export function getCommodityConfig(name) {
  const c = COMMODITIES[name];
  if (!c) throw new Error(`unknown commodity: ${name}`);
  return c;
}

export function listEnabledCommodities() {
  return Object.values(COMMODITIES).filter((c) => c.enabled);
}

export function listAllCommodities() {
  return Object.values(COMMODITIES);
}
