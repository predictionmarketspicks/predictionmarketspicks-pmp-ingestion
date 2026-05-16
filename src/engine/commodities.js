// Per-commodity static config — single registry consumed by every engine
// (silver/gold/oil/copper) and by the multi-engine bootstrap in src/index.js.
//
// Each entry is plan §10 input. Adding a commodity = one entry here + one thin
// wrapper file in src/engine/. The shared compute fn in commodity-base.js
// reads the rest from the row passed in.
//
// Spot/chain feed source per commodity (May 16 2026):
//   silver  Pyth XAG/USD  + Databento SLV.OPT  (real-time, default provider)
//   gold    Pyth XAU/USD  + Databento GLD.OPT  (real-time)
//   oil     Yahoo CL=F /  + Databento USO.OPT  (hybrid: Yahoo spot for
//           CLM26.NYM                           contract-aware WTI accuracy,
//                                               Databento for real-time IV chain)
//   copper  Pyth XCU/USD  — UNVERIFIED, no Pyth feed ID configured. Engine
//                           fails open when getPrice() returns null.
//
// Per-commodity `useYahooSpot` flag flips the spot source in commodity-base.js
// from Pyth to src/feeds/yahoo-oil.js. Chain always comes from the active
// options provider (Databento default; Massive fallback via OPTIONS_PROVIDER).
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
    // FRED skip: no clean daily silver spot equivalent on FRED (LBMA silver
    // is monthly only). Revisit if a daily series surfaces. See handoffs/
    // BATCH_FRED_P5_AND_TRACKER_P2_2026-05-10.md.
    fredSeriesId: null,
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
    // OPRA is dark off-hours and the SLV options book doesn't move, so
    // writing snapshots overnight just upserts duplicate rows into
    // commodity_edge_signals. Engine sleeps the snapshot loop off-hours
    // and resumes at 9:30 AM ET. Pairs with requiredOffHours:false on the
    // databento_slv readiness gate (src/index.js).
    pauseSnapshotsOffHours: true,
  },
  gold: {
    commodity: 'gold',
    seriesTicker: 'KXGOLDW',
    underlyingEtf: 'GLD',
    pythSymbol: 'XAU/USD',
    spotUnit: '$/oz',
    spotLabel: 'Pyth XAU/USD',
    enabled: true,
    // FRED Phase 5: London Bullion Market PM fix, daily.
    fredSeriesId: 'GOLDPMGBD228NLBM',
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
    // Same as silver — OPRA dark off-hours, GLD book frozen, no new info to
    // surface. See commodities.silver.pauseSnapshotsOffHours.
    pauseSnapshotsOffHours: true,
  },
  oil: {
    commodity: 'oil',
    seriesTicker: 'KXWTI',
    underlyingEtf: 'USO',
    pythSymbol: 'WTI', // not used when useYahooSpot is true; kept for shape parity
    spotUnit: '$/bbl',
    spotLabel: 'Yahoo CL=F / CLM26.NYM (contract-aware)',
    enabled: true,
    useYahooSpot: true,
    bypassWriterTag: true,
    // Contract-aware spot (Part B of OIL_EDGE_WTI_ROLLOVER_FIX_2026-05-13).
    // When true, resolve the active settle contract from Kalshi series
    // metadata and pull the matching Yahoo specific-month spot
    // (CLM26.NYM etc.) instead of CL=F continuous. Falls back to CL=F
    // continuous if Kalshi or Yahoo declines.
    // Flipped ON 2026-05-13 immediately after Part B landed — operator
    // accepts the small live-bake risk. Once Fly logs show
    // `using contract-aware spot ...` and commodity_edge_signals.spot_source
    // reads `yahoo_clm26_nym` (or current contract), the page-side rollover
    // guard in lib/tools/oil-edge.ts becomes structurally redundant.
    useContractAwareSpot: true,
    // FRED Phase 5: WTI Cushing daily close. Critical given the Yahoo CL=F
    // path is the most fragile of the four feeds.
    fredSeriesId: 'DCOILWTICO',
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
    // OPRA dark off-hours: USO chain stops updating overnight even though
    // Yahoo CL=F continues to print on Globex/Asia. Writing snapshots with
    // a frozen IV smile + a moving spot would just upsert misleading rows.
    // Pairs with requiredOffHours:false on the databento_uso readiness gate.
    pauseSnapshotsOffHours: true,
  },
  copper: {
    commodity: 'copper',
    seriesTicker: 'KXCOPPERMON',
    underlyingEtf: 'CPER',
    pythSymbol: 'XCU/USD',
    spotUnit: '$/lb',
    spotLabel: 'Pyth XCU/USD (unverified)',
    enabled: false, // flip true once a copper spot feed is wired
    // FRED skip: same constraint as silver — no daily FRED copper series.
    fredSeriesId: null,
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
