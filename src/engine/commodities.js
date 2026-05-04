// Per-commodity static config — single registry consumed by every engine
// (silver/gold/oil/copper) and by the multi-engine bootstrap in src/index.js.
//
// Each entry is plan §10 input. Adding a commodity = one entry here + one thin
// wrapper file in src/engine/. The shared compute fn in commodity-base.js
// reads the rest from the row passed in.
//
// Pyth feed verification status (May 2 2026):
//   silver  XAG/USD  — verified (Kalshi settlement source)
//   gold    XAU/USD  — verified (Kalshi settlement source)
//   oil     WTI      — UNVERIFIED placeholder ID. Pyth Hermes serves per-expiry
//                      WTI futures (WTIM6, WTIN6, …), not a continuous feed.
//                      Engine fails open: when Pyth WTI returns null, oil
//                      snapshot is skipped (logged warn, no DB write). TODO:
//                      validate the ID via /v2/price_feeds, or add a Massive
//                      futures path. See docs/COMMODITY_FEEDS.md.
//   copper  XCU/USD  — UNVERIFIED, no Pyth feed ID configured. Same fail-open
//                      pattern as oil. Pre-launch verification required.
//
// `enabled` flag: false = engine bootstraps but no-ops. Lets the multi-engine
// scheduler ship without a real feed source for oil/copper. Flip to true once
// the Pyth feed (or a substitute) is verified for that commodity.

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
    pythSymbol: 'WTI',
    spotUnit: '$/bbl',
    spotLabel: 'Pyth WTI (unverified)',
    enabled: false, // flip true once Pyth WTI feed ID is verified
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
