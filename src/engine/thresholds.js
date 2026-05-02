// All edge / volume / dedup thresholds in one place.
// Mirrors commodity_edge/src/edge.py constants and the BUILD_PLAN §9 tier ladder.
//
// Two confidence vocabularies coexist on commodity_edge_signals:
//   - legacy `confidence` ('high' | 'medium' | 'low' | 'skip') — front-end uses this
//   - fused `fused_confidence` ('STRONG' | 'MODERATE' | 'SPECULATIVE' | 'NO_EDGE')
//     — Phase A COT/gamma fusion column, populated by the Python nightly job
// Phase 1 engine writes the legacy column. Fusion fields stay NULL until the
// nightly redundancy job runs (preserves Python pipeline invariant).

// Minimum |edge| (in fraction, not pp) we'll surface as actionable.
export const MIN_EDGE_PP = 0.05;

// Minimum 24h Kalshi volume to trust last_price as fair (else stale print).
export const MIN_VOL_FOR_LIVE_PRICE = 50;

// Risk-free rate + dividend yield used in BS pricing. ETF carries ~zero divs.
export const RISK_FREE_RATE = 0.045;
export const DIVIDEND_YIELD = 0.0;

// Fused-tier cutoffs (Phase A spec — used for Discord routing on Phase 1).
//   STRONG    ≥ 12pp  → #oracle-picks (premium)
//   MODERATE  ≥  7pp  → #premium-alerts
//   SPECULATIVE ≥ 4pp → #cmdty-edge (free tier)
export const FUSED_TIER_CUTOFFS = {
  STRONG: 0.12,
  MODERATE: 0.07,
  SPECULATIVE: 0.04,
};

export function fusedTier(edgeAbs) {
  if (edgeAbs >= FUSED_TIER_CUTOFFS.STRONG) return 'STRONG';
  if (edgeAbs >= FUSED_TIER_CUTOFFS.MODERATE) return 'MODERATE';
  if (edgeAbs >= FUSED_TIER_CUTOFFS.SPECULATIVE) return 'SPECULATIVE';
  return 'NO_EDGE';
}

// Map fused tier → feed_performance.confidence_tier integer.
export function confidenceTierInt(tier) {
  return tier === 'STRONG' ? 3 : tier === 'MODERATE' ? 2 : tier === 'SPECULATIVE' ? 1 : 0;
}

// Snapshot cadence — engine writes this often during market hours, less when
// the options market is closed. Phase 2A renamed from SILVER_* to commodity-
// agnostic; back-compat aliases kept for any external imports.
export const SNAPSHOT_INTERVAL_MARKET_MS = 5 * 60 * 1000; // 5 min
export const SNAPSHOT_INTERVAL_OFF_MS = 30 * 60 * 1000; // 30 min

export const SILVER_SNAPSHOT_INTERVAL_MARKET_MS = SNAPSHOT_INTERVAL_MARKET_MS;
export const SILVER_SNAPSHOT_INTERVAL_OFF_MS = SNAPSHOT_INTERVAL_OFF_MS;

// Massive chain delta filter (plan §10) — keeps the in-memory map under control
// across four ETFs. `null` delta passes through, so Phase 1 bridge-week traffic
// (15-min delayed tier returns greeks: {} on weekends and off-hours) still
// produces snapshots. After the Mon May 4 / Tue May 5 real-time cutover greeks
// populate live and the filter starts pruning to ~0.15 ≤ |Δ| ≤ 0.85.
export const DELTA_FILTER_MIN = 0.15;
export const DELTA_FILTER_MAX = 0.85;
