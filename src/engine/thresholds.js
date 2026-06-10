// All edge / volume / dedup thresholds in one place.
// Mirrors commodity_edge/src/edge.py constants and the BUILD_PLAN §9 tier ladder.
//
// Two confidence vocabularies coexist on commodity_edge_signals:
//   - legacy `confidence` ('high' | 'medium' | 'low' | 'skip') — front-end uses this
//   - fused `fused_confidence` ('STRONG' | 'MODERATE' | 'SPECULATIVE' | 'NO_EDGE')
//     — Phase A COT/gamma fusion column, populated by the Python nightly job
// Phase 1 engine writes both the legacy `confidence` column AND
// `fused_confidence` / `fused_edge_pp`. The nightly Python redundancy job was
// retired 2026-05-04; this engine is now the sole writer. `cot_*` and
// `gamma_*` fusion columns remain NULL — see
// handoffs/FUSED_CONFIDENCE_WIRE_UP_2026-05-19.md.

// Minimum |edge| (in fraction, not pp) we'll surface as actionable.
export const MIN_EDGE_PP = 0.05;

// Minimum 24h Kalshi volume to trust last_price as fair (else stale print).
export const MIN_VOL_FOR_LIVE_PRICE = 50;

// V2 Phase 2 liquidity gates (handoffs/COMMODITY_EDGE_V2_PHYSICAL_MEASURE_REBUILD_2026-05-19.md
// Layer 4). Enforced on every actionable (high/medium) confidence assignment
// in commodity-base.js — wider spread or staler quote demotes to 'low' with
// rationale append. May 2026 backtest found 26 silver alerts shipped on
// markets with kalshi_volume_24h=0; this is the source-of-truth gate that
// would have suppressed them.
export const MAX_BID_ASK_SPREAD = 0.15;   // 15 cents on a $1 contract
export const MAX_QUOTE_AGE_SEC = 30 * 60; // 30 minutes

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

// FRED Phase 5: tier downgrade applied when Pyth/Yahoo spot diverges from FRED
// daily close beyond FRED_DIVERGENCE_BP_THRESHOLD. STRONG→MODERATE,
// MODERATE→SPECULATIVE, SPECULATIVE→NO_EDGE (suppress).
export function downgradeFusedTier(tier) {
  if (tier === 'STRONG') return 'MODERATE';
  if (tier === 'MODERATE') return 'SPECULATIVE';
  if (tier === 'SPECULATIVE') return 'NO_EDGE';
  return tier;
}

// Legacy confidence vocabulary downgrade — same one-notch demotion the
// front-end reads. 'skip' is terminal (already non-actionable).
export function downgradeLegacyConfidence(c) {
  if (c === 'high') return 'medium';
  if (c === 'medium') return 'low';
  return c;
}

// 150bp = 1.5%. Conservative threshold — normal intraday drift between Pyth
// realtime and FRED daily close is well under 100bp. Re-tune after 30 days
// if alert fatigue appears.
export const FRED_DIVERGENCE_BP_THRESHOLD = 150;

// FRED publishes daily; allow up to 30h to absorb one missed publish before
// suppressing the cross-check entirely. Older than that we treat the FRED
// feed itself as stale and fail open.
export const FRED_MAX_AGE_HOURS = 30;

// Snapshot cadence — engine writes this often during market hours, less when
// the options market is closed. Phase 2A renamed from SILVER_* to commodity-
// agnostic; back-compat aliases kept for any external imports.
export const SNAPSHOT_INTERVAL_MARKET_MS = 5 * 60 * 1000; // 5 min
export const SNAPSHOT_INTERVAL_OFF_MS = 30 * 60 * 1000; // 30 min

// Expiration-day burst — last 60 min before a commodity event closes is when
// implied probability and Kalshi's quoted price diverge fastest as time decay
// accelerates. 5-min cadence misses 10pp edges that open at 4:32 ET and close
// by 4:45 ET. Burst overrides both market and off-hours cadences when active.
export const SNAPSHOT_INTERVAL_EXPIRATION_MS = 60 * 1000; // 1 min
export const EXPIRATION_BURST_WINDOW_MS = 60 * 60 * 1000; // 60 min before close

export const SILVER_SNAPSHOT_INTERVAL_MARKET_MS = SNAPSHOT_INTERVAL_MARKET_MS;
export const SILVER_SNAPSHOT_INTERVAL_OFF_MS = SNAPSHOT_INTERVAL_OFF_MS;

// --- Kalshi leg-skew guards (2026-06-10 stale-Kalshi-leg fix) ---
// The Kalshi book is now refetched atomically per snapshot (one
// with_nested_markets call → kalshi_quoted_at), so legs normally agree within
// a couple seconds. If the refetch failed and we fell back to the discovery
// snapshot, snapshot_at - kalshi_quoted_at exceeds this and the row is flagged
// quality_flag='kalshi_stale' (suppressed on the read side, same as
// kalshi_no_book) — any edge against a book this far behind live spot is a
// leg-skew artifact, not a tradeable signal.
export const KALSHI_MAX_SKEW_SECONDS = 90;

// Sanity cap / defense-in-depth. Within EDGE_IMPLAUSIBLE_MINUTES_TO_CLOSE of an
// event close, a genuine edge on a liquid hourly book is never this large —
// anything above EDGE_IMPLAUSIBLE_PP is a data fault by construction (a stale
// quote the freshness guards above didn't catch). Flagged 'edge_implausible'
// and suppressed rather than published as a phantom BUY.
export const EDGE_IMPLAUSIBLE_MINUTES_TO_CLOSE = 30;
export const EDGE_IMPLAUSIBLE_PP = 0.25; // 25pp

// Massive chain delta filter (plan §10) — keeps the in-memory map under control
// across four ETFs. `null` delta passes through, so Phase 1 bridge-week traffic
// (15-min delayed tier returns greeks: {} on weekends and off-hours) still
// produces snapshots. After the Mon May 4 / Tue May 5 real-time cutover greeks
// populate live and the filter starts pruning to ~0.15 ≤ |Δ| ≤ 0.85.
export const DELTA_FILTER_MIN = 0.15;
export const DELTA_FILTER_MAX = 0.85;

// Options chain quality filters (handoff §2.3, May 4 2026). Applied at the
// Massive feed layer so consumers (silver/gold/oil/copper engines, future IV
// HTTP endpoint) all see the same clean chain. Kills the "options imply 0%"
// phantom-edge rows that show up when an illiquid strike with $0 bid feeds the
// smile interpolation.
//
// Null-field passthrough mirrors the delta filter — off-hours / cold-start the
// fields are missing, not zero, and we don't want to zero out the whole chain.
export const OPTION_QUALITY_MIN_VOLUME = 50;        // drop strike if 24h vol < 50
export const OPTION_QUALITY_MIN_OI = 100;            // drop strike if OI < 100
export const OPTION_QUALITY_MAX_SPREAD_RATIO = 0.25; // drop strike if (ask-bid)/mid > 25%

// Speculative band: passes the min-volume filter but thin enough that the
// engine should demote the resulting commodity_edge row to 'low' confidence
// even if the edge magnitude would normally qualify higher. Site can render
// these as advisory rather than actionable.
export const OPTION_VOLUME_SPECULATIVE_MAX = 150;
