// Alert-tier ceiling for bitcoin signals that no calibration is standing behind.
// BITCOIN_EDGE_V21_CALIBRATED_RELAUNCH_2026-08-05.md §2.4, revised by §4.5.
//
// Era C (7/28-8/4) shipped STRONG bitcoin alerts claiming up to 32pp of edge to
// paying subscribers while the model averaged a claimed 0.794 against a market
// price of 0.498 and realized 48.1%. PR A shrank the cause; this caps the blast
// radius of whatever error survives it.
//
// The ceiling is delivery-side only: it changes what we TELL people, never the
// stored signal, the decision prob, or the graded record.
//
// WHAT LIFTS IT — read this before changing the condition.
// §4.5 says the ceiling "applies only when calibrated_prob is null", i.e. that
// it self-retires the moment a map exists. Taken together with §4.2 — which
// stores calibrated_prob in SHADOW mode too — that would lift the ceiling while
// decisions are still being made on the raw, uncalibrated prob. STRONG alerts
// would resume on exactly the numbers the ceiling exists to contain, and
// nothing would fail.
//
// So the ceiling lifts on GOVERNANCE, not on presence: only when a calibration
// map is ACTIVE for the commodity, meaning calibrated_prob is what drove the
// direction, the edge and the tier. That flag rides on meta.calibrationActive
// (set in commodity-base from isCalibrationActive) and promotion is gated on
// out-of-sample Brier in scripts/promote-btc-calibration.js.

const CEILINGED_COMMODITIES = new Set(['bitcoin']);

// Returns the tier that may be PUBLISHED for this signal.
// `meta` is the snapshot meta object; a missing/false calibrationActive means
// the ceiling applies (fail-safe default).
export function applyCalibrationTierCeiling(commodity, tier, meta) {
  if (!CEILINGED_COMMODITIES.has(String(commodity || '').toLowerCase())) return tier;
  if (meta?.calibrationActive === true) return tier;
  return tier === 'STRONG' ? 'MODERATE' : tier;
}
