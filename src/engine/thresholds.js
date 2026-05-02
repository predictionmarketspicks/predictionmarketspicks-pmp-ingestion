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

// Phase 1 cadence — engine writes this often during market hours.
export const SILVER_SNAPSHOT_INTERVAL_MARKET_MS = 5 * 60 * 1000; // 5 min
export const SILVER_SNAPSHOT_INTERVAL_OFF_MS = 30 * 60 * 1000; // 30 min
