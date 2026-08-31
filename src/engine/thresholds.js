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

// NO-side post-spread floor (bitcoin only — BITCOIN_EDGE_NO_SIDE_FIX_2026-06-16).
// The symmetric MIN_EDGE_PP gate plus sign-only side selection emitted a BUY NO
// on every negative-edge strike, which on hourly KXBTCD is a ~coin-flip that
// bleeds: those are expensive favorites (NO at ~60-66c) where the optProb model
// runs biased low, so "YES overpriced -> BUY NO" is often a model artifact, not
// a market mispricing. Until the IBIT-chain -> BTC TWAP prob is recalibrated, the
// NO side must clear a stricter POST-SPREAD edge (yesBid - chosenProb) before we
// emit it. Bitcoin-only via config.minEdgePpNoSide; silver/gold/oil never read
// this (they keep the symmetric path — config.postSpreadGate is unset for them).
export const MIN_EDGE_PP_NO = 0.1;

// YES-side favorite floor (BITCOIN — TOOL_RECALIBRATION_ROUND2_2026-07-21).
// Settled record: YES picks at >=70c ran model 89.8% vs realized 75.7% (n=37,
// 60% of all flow) — the optProb model saturates faster than Kalshi's book
// keeps tail premium near the hourly close, printing phantom 5-7pp edges on
// 85-92c contracts. Same disease the 6/16 NO-side fix treated; same medicine:
// a YES BUY at/above the favorite price line must clear the stricter
// post-spread floor. Mid-band (20-70c) YES keeps the 5pp floor — that band is
// the tool's entire realized profit (+$2.20 on 11 picks). Bitcoin-only via
// config.postSpreadGate + config.yesFavoritePrice; silver/gold/oil never read these.
export const YES_FAVORITE_PRICE = 0.70;   // yesAsk at/above this = favorite
export const MIN_EDGE_PP_YES_FAVORITE = 0.10;

// Longshot side, same logic smaller leak (YES <=20c went 2/14): reuse the
// mispricing scanner's 7/4 band — no YES BUYs under 15c, full stop.
export const YES_LONGSHOT_PRICE_MIN = 0.15;

// Physical-measure mu for the BTC TWAP path (BITCOIN_V2_CUTOVER_2026-07-27).
// short-horizon-vol.js clamps its mu_annual to +/-3.0/yr — right for 60d-drift
// sanity, useless intra-hour: +/-300%/yr over a 30-min horizon moves log-spot
// ~1.7bp while real BTC momentum bursts annualize to thousands of %. The TWAP
// path therefore consumes the RAW short-horizon mu, shrunk by BTC_MU_SCALE
// (lambda) and clamped to +/-BTC_MU_CAP_ANNUAL.
//
// V2.2 (2026-08-13): lambda 0.4 -> 0. The momentum term is OFF; the TWAP path is
// now a pure vol model. This is the third and final step of a trajectory that only
// ever moved one way (1.0/50 on 7/27 -> 0.4/12 on 8/05 -> 0/12 today), and each
// step was taken for the same reason: the drift term never carried information,
// only displacement.
//
// What 8/05 missed is a UNIT error, not an arithmetic one. Its own note argued
// 0.4/12 "caps a full-tilt burst at ~0.07% expected move per 30min" and called
// that a small tilt. The arithmetic is right (12/yr x 30min = 6.85e-4) but 0.07%
// is only small in PRICE units. BTC sigma-to-close over that horizon is ~0.27%,
// so the cap was displacing the entire model CDF by ~0.26 sigma — and sigma is
// the unit that sets probabilities, which is all this engine emits.
//
// Measured on the live board (BITCOIN_EDGE_MU_CAP_SATURATION_2026-08-13.md):
// fitting a lognormal to all 12 strikes of KXBTCD-26AUG1313 put the market median
// on spot (+$6) and the model median $104 BELOW it = -0.49 sigma, of which
// mu -12 x T contributed -$74.6 (~70%). The cap was not a guardrail: it BOUND on
// 57% of persisted rows on a median day and 99% on 8/13, and its sign flipped
// day to day (avg mu +5.72 on 8/11, -4.05 on 8/13). A clamp that fires on the
// majority of observations is the estimator, and this one was a two-valued square
// wave driven by a 15-minute momentum read — a horizon at which BTC log returns
// carry no exploitable autocorrelation, so its sampling error dwarfs any real
// drift. Its net negative tilt is a sufficient explanation for the NO side going
// 1-for-15 live without any story about smile bias.
//
// A directional edge at EVERY strike at once is one location error observed N
// times, not N mispricings — both curves integrate to a single distribution each.
// That is the signature this change targets.
//
// BTC_MU_CAP_ANNUAL is now inert (0 x anything is 0) and kept only so a future
// re-enable has a horizon-appropriate bound to reach for. Do not raise the scale
// off 0 without re-running the acceptance test in the handoff's section 6:
// median shift within +/-0.10 sigma and width ratio 0.95-1.05, on three snapshots.
// Residual known error this does NOT fix: model sigma ran 1.20x the market's, so
// fake tail edges are still possible. That is the next item.
// Per-commodity override: config.shortHorizonMuScale / config.shortHorizonMuCapAnnual.
export const BTC_MU_SCALE = 0;
export const BTC_MU_CAP_ANNUAL = 12;

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

// --- Bitcoin-only knobs (2026-06-10 strike-band + 15s cadence handoff) ---
// hourly contract — daily commodities keep wider band. KXBTCD is HOURLY with
// $100 strike spacing: ±15% of ~$62K spot = ~188 strikes/snapshot, ~85% of them
// dead (zero vol / no book / prob saturated at 0 or 1). Hourly BTC σ ≈ 0.4–0.7%
// (1–2% in violent hours), so anything past ±6% is unreachable within the
// contract's life. Keep a strike iff |strike/spot − 1| ≤ this OR it has a live
// two-sided book (Benny call 2026-06-10: BTC can move 5%+ in an hour; cascade
// hours need the wider book-based capture). Bitcoin-only via config.strikeBandPct;
// silver/gold/oil leave it unset and keep the full ladder.
export const BTC_STRIKE_BAND_PCT = 0.06;

// Bitcoin pass cadence — every 15s during the market window (down from the 5min
// shared market cadence). The WHOLE pass stays atomic: Databento IBIT NBBO (in-
// memory sidecar read) + Kalshi book refetch (one with_nested_markets call) +
// Pyth spot (in-memory) all advance together each pass. NOT a per-leg fast timer
// — that's the leg-skew bug fixed in BITCOIN_EDGE_STALE_KALSHI_2026-06-10. The
// scheduler chains the next pass only after the current one resolves, so passes
// can't overlap; a skip-if-running guard in index.js is the belt-and-suspenders.
export const BTC_SNAPSHOT_INTERVAL_MARKET_MS = 15 * 1000; // 15s

// WATCH tier (2026-06-10) — mirrors the sports-arb WATCH 3pp / signal-locked
// convention. Bitcoin rows with WATCH_EDGE_PP ≤ |edge| < MIN_EDGE_PP are a
// directional LEAN, not a BUY (those stay ≥5pp). Surfaced as confidence='watch'
// so the public board stays alive in calm hours (0–4pp gaps) without faking
// signals. Bitcoin-only via config.watchTierEnabled.
export const WATCH_EDGE_PP = 0.03;

// Post-band sanity ceiling. A banded bitcoin snapshot runs ~75–90 strikes; more
// than this means the band filter regressed (or spot went null) and we're back
// to writing the full dead ladder — warn to #bot-logs.
export const BTC_STRIKE_COUNT_WARN = 150;

// --- Kalshi leg-skew guards (2026-06-10 stale-Kalshi-leg fix) ---
// The Kalshi book is now refetched atomically per snapshot (one
// with_nested_markets call → kalshi_quoted_at), so legs normally agree within
// a couple seconds. If the refetch failed and we fell back to the discovery
// snapshot, snapshot_at - kalshi_quoted_at exceeds this and the row is flagged
// quality_flag='kalshi_stale' (suppressed on the read side, same as
// kalshi_no_book) — any edge against a book this far behind live spot is a
// leg-skew artifact, not a tradeable signal.
export const KALSHI_MAX_SKEW_SECONDS = 90;

// Sanity cap / defense-in-depth — T-SCALED, ALL HORIZONS (EDGE_MARKETS §1.1,
// 2026-08-31). Supersedes the fixed 2026-06-10 form (arm only ≤30min to close,
// suppress only >25pp), which was blind to the Friday-afternoon metals disease:
// at T=2h, gold σ_blend ≈0.14 → σ√τ ≈0.21%, so a strike just 0.5% OTM prints
// d₂=2.37 → model 99.1% vs a 79¢ book → a +20pp "edge" → STRONG (observed live
// 2026-08-28 in edge_alerts). 20pp cleared the old 25pp bar and 120min cleared
// the old 30min arm, so the guard never fired. Bitcoin's measured version of
// the same disease: claimed 0.794, realized 0.481.
//
// Threshold: suppress when |edge| > max(15pp, 6·σ√τ·100pp), where σ is the
// annualized vol driving the model prob and τ the years to close.
//
// DERIVATION OF THE 6·σ√τ FORM. σ√τ is the model's own one-standard-deviation
// log-price move over the contract's remaining life — the total uncertainty
// BOTH the model and the book are pricing the same terminal event against. As
// τ → 0 that uncertainty collapses and Φ(d₂) saturates: model and market are
// then pinned by the same near-certain outcome, and any large residual gap can
// only be the book's tail/fee premium or a stale quote — never information the
// model has. So the ceiling must SHRINK toward a fixed floor near expiry and
// may RELAX proportionally to remaining vol far from it (long-dated or
// high-vol regimes, e.g. crypto cascade hours, where honest model-vs-order-
// flow dispersion really can be large). Scaling linearly in σ√τ at 6pp of
// probability per 1% of remaining vol keeps the ceiling: (a) inert for every
// historically-validated edge — typical weekly-metals σ√τ ≈1-2% puts 6·σ√τ at
// 6-12pp, below the 15pp floor, so the floor governs and sits safely above the
// 12pp STRONG cutoff; (b) decisive against both observed phantom shapes — the
// Aug 28 gold +20pp at σ√τ=0.21% (ceiling 15pp) and the 2026-06-10 BTC
// 25pp+ near-close artifacts (ceiling 15pp at BTC's sub-hour σ√τ ≈0.3-0.9%).
// Flagged 'edge_implausible' + hard-suppressed rather than published.
export const EDGE_IMPLAUSIBLE_FLOOR_PP = 0.15; // 15pp absolute floor (fraction units)
export const EDGE_IMPLAUSIBLE_SIGMA_MULT = 6;

// Pure. sigmaAnnual = the annualized σ that produced the model prob (blend
// preferred); tYears = years to close. Non-finite/non-positive inputs degrade
// the σ√τ term to 0, leaving the 15pp floor — fail-SAFE (tightest ceiling),
// since an edge with no honest σ behind it deserves the least benefit of doubt.
export function edgeImplausibleThreshold(sigmaAnnual, tYears) {
  const s = Number(sigmaAnnual);
  const t = Number(tYears);
  const sigmaSqrtTau = Number.isFinite(s) && s > 0 && Number.isFinite(t) && t > 0
    ? s * Math.sqrt(t)
    : 0;
  return Math.max(EDGE_IMPLAUSIBLE_FLOOR_PP, EDGE_IMPLAUSIBLE_SIGMA_MULT * sigmaSqrtTau);
}

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
