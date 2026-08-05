// Stopgap alert-tier ceiling for uncalibrated bitcoin signals.
// BITCOIN_EDGE_V21_CALIBRATED_RELAUNCH_2026-08-05.md §2.4.
//
// Era C (7/28-8/4) shipped STRONG bitcoin alerts claiming up to 32pp of edge
// to paying subscribers while the model's average claimed prob was 0.794
// against an average market price of 0.498 and realized hit was 48.1%. The
// momentum shrink in PR A fixes the cause; this caps the blast radius of
// whatever error survives it.
//
// The ceiling is deliberately DELIVERY-side only: it changes what we tell
// people, never the stored signal, the decision prob, or the graded record.
// It is also self-retiring — once PR C writes an interior `calibrated_prob`
// on the row, the row has been scored against our own settled record and the
// ceiling lifts with no code change.

const CEILINGED_COMMODITIES = new Set(['bitcoin']);

// Interior = strictly inside (0,1). A null/0/1 calibrated_prob is not a
// calibration result — it's an absent or degenerate one — and must not lift
// the ceiling. Mirrors the modelProbOf interiority rule the bot uses (PR D).
function isInterior(p) {
  const n = Number(p);
  return Number.isFinite(n) && n > 0 && n < 1;
}

// Returns the tier that may be PUBLISHED for this signal.
// Non-ceilinged commodities and calibrated rows pass through untouched.
export function applyCalibrationTierCeiling(commodity, tier, row) {
  if (!CEILINGED_COMMODITIES.has(String(commodity || '').toLowerCase())) return tier;
  if (isInterior(row?.calibrated_prob)) return tier;
  return tier === 'STRONG' ? 'MODERATE' : tier;
}
