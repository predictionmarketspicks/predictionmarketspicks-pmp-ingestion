// Cross-platform arb tier ladder (BUILD_PLAN §10).
// Different from commodity edge thresholds: arb spreads are typically tighter,
// so cutoffs are lower across the board.
//
//   STRONG    ≥ 10pp
//   MODERATE  ≥  7pp
//   SPECULATIVE ≥ 5pp
//
// `confidence_tier` mirrors feed_performance.confidence_tier (1/2/3).

export const ARB_TIER_CUTOFFS = {
  STRONG: 0.10,
  MODERATE: 0.07,
  SPECULATIVE: 0.05,
};

export function arbTier(spreadAbs) {
  if (spreadAbs >= ARB_TIER_CUTOFFS.STRONG) return 'STRONG';
  if (spreadAbs >= ARB_TIER_CUTOFFS.MODERATE) return 'MODERATE';
  if (spreadAbs >= ARB_TIER_CUTOFFS.SPECULATIVE) return 'SPECULATIVE';
  return 'NO_EDGE';
}

export function arbConfidenceTierInt(tier) {
  return tier === 'STRONG' ? 3 : tier === 'MODERATE' ? 2 : tier === 'SPECULATIVE' ? 1 : 0;
}

// Comparator runs every ARB_COMPARE_INTERVAL_MS. Don't write more than one row
// per pair within ARB_MIN_INTERVAL_PER_PAIR_MS unless tier changes.
export const ARB_COMPARE_INTERVAL_MS = 30 * 1000; // 30s
export const ARB_MIN_INTERVAL_PER_PAIR_MS = 60 * 1000; // 60s

// Skip writes where spread changed by less than this since the last write,
// unless the tier classification changed.
export const ARB_DEDUP_SPREAD_PP = 0.005; // 0.5pp
