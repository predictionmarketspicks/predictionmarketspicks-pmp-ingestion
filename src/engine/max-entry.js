// Max entry price — "Buy YES up to 62¢" (prediction-marketspicks MAX_ENTRY, 2026-10-23).
//
// A published pick is a side and a price. A reader who arrives later sees a new
// price and needs to know whether the edge still holds there. The answer is the
// highest price at which THIS engine's own BUY rule still passes:
//
//   max_entry = the largest P (whole cents, rounded DOWN) with
//               prob_side − P − fee(P) ≥ minEdge(side, P)
//
// It is the same post-spread, net-of-fee gate postSpreadSideGate runs, solved
// for the price instead of evaluated at one. Every input is read from this repo's
// own config (thresholds.js + COMMODITIES[c]) at call time, so a floor that moves
// there moves the range with it — nothing here is a copy of a number.
//
// The range is [min_entry, max_entry]. min_entry is the engine's hard entry
// floor (ENTRY_COST_FLOOR, and the YES longshot band) — a cheaper fill is a
// different, off-record trade, not "a better price".
//
// NO is expressed in the NO price (1 − yesBid), the price the reader pays. The
// NO net edge is yesBid − prob − fee(yesBid); with Q = 1 − yesBid that is
// (1 − prob) − Q − fee(Q), because the fee is symmetric. So both sides run the
// same solver on (prob_side, price_of_side).
//
// Derived signal only (an edge threshold): no quote, strike-level price or IV
// leaves through here — OPRA-safe by construction.

import {
  ENTRY_COST_FLOOR,
  MIN_EDGE_PP,
  MIN_EDGE_PP_NO,
  YES_FAVORITE_PRICE,
  MIN_EDGE_PP_YES_FAVORITE,
  YES_LONGSHOT_PRICE_MIN,
} from './thresholds.js';

/**
 * Pure solver over a predicate. Highest whole cent c in [1, capCents] where
 * passesAt(c) holds — evaluated with the SAME float arithmetic as the gate it
 * mirrors, so the range and the gate can never disagree at a boundary cent.
 * Returns { maxCents, minCents } — maxCents may sit BELOW minCents (the edge is
 * gone everywhere inside the band) — or null when no price clears at all.
 */
export function maxEntryFrom(passesAt, { floorCents = null, capCents = null } = {}) {
  const hi = Math.min(99, capCents == null ? 99 : Math.floor(capCents));
  for (let c = hi; c >= 1; c--) {
    if (passesAt(c)) return { maxCents: c, minCents: floorCents == null ? null : Math.max(1, Math.ceil(floorCents)) };
  }
  return null;
}

/**
 * The generic form: probSide − c/100 − feeAt(c/100) ≥ minEdgeAt(c).
 *   probSide   P(the picked side wins), 0–1
 *   minEdgeAt  (cents) => the tool's minimum net edge at that price, as a fraction
 *   feeAt      (priceFraction) => the tool's per-contract fee, as a fraction
 *   floorCents / capCents  the tool's hard entry floor / cap (null = none)
 */
export function maxEntryRange({ probSide, minEdgeAt, feeAt, floorCents = null, capCents = null }) {
  const p = Number(probSide);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return maxEntryFrom((c) => p - c / 100 - feeAt(c / 100) >= minEdgeAt(c), { floorCents, capCents });
}

/** True when the range is non-empty (some price inside [min, max] still passes). */
export function rangeOpen(r) {
  return r != null && r.maxCents != null && (r.minCents == null || r.maxCents >= r.minCents);
}

/**
 * The commodity engines' range for one BUY row (bitcoin, gold, silver, oil).
 * Mirrors postSpreadSideGate + resolveYesFloor + applyEntryFloor exactly:
 *   YES  minEdge = config.minEdgePpYesFavorite (≥ config.yesFavoritePrice) else MIN_EDGE_PP;
 *        floor   = max(ENTRY_COST_FLOOR, YES_LONGSHOT_PRICE_MIN) when the post-spread gate runs
 *   NO   minEdge = config.minEdgePpNoSide ?? MIN_EDGE_PP_NO;  floor = ENTRY_COST_FLOOR
 *   fee  = feeFraction when config.chargeFees, else 0 (the gate's own choice)
 * Returns null for a row with no side or no probability.
 */
export function commodityEntryRange(config, { side, probYes, feeFraction }) {
  if (side !== 'YES' && side !== 'NO') return null;
  const py = Number(probYes);
  if (!Number.isFinite(py)) return null;
  const feeAt = config.chargeFees === true ? feeFraction : () => 0;
  const gated = config.postSpreadGate === true;
  const fl = Math.round(ENTRY_COST_FLOOR * 100);
  if (side === 'YES') {
    // postSpreadSideGate: yesNet = chosenProb − yesAsk − fee(yesAsk) ≥ minEdgeYes(yesAsk)
    const favOn = gated && (config.yesFavoriteEnabled ?? true);
    const favPrice = config.yesFavoritePrice ?? YES_FAVORITE_PRICE;
    const favFloor = config.minEdgePpYesFavorite ?? MIN_EDGE_PP_YES_FAVORITE;
    const floor = Math.max(fl, gated ? Math.round(YES_LONGSHOT_PRICE_MIN * 100) : 0);
    return maxEntryFrom((c) => {
      const ask = c / 100;
      const minEdge = favOn && ask >= favPrice ? favFloor : MIN_EDGE_PP;
      return py - ask - feeAt(ask) >= minEdge;
    }, { floorCents: floor });
  }
  // postSpreadSideGate: noNet = yesBid − chosenProb − fee(yesBid) ≥ minEdgeNo, NO price = 1 − yesBid
  const minNo = gated ? (config.minEdgePpNoSide ?? MIN_EDGE_PP_NO) : MIN_EDGE_PP;
  return maxEntryFrom((c) => {
    const yesBid = (100 - c) / 100;
    return yesBid - py - feeAt(yesBid) >= minNo;
  }, { floorCents: fl });
}

/** "Buy YES up to 62¢" / "Buy NO 45–62¢" — the published wording (Benny's). */
export function entryRangeLabel(side, r) {
  if (!r || r.maxCents == null) return null;
  const s = side === 'NO' ? 'NO' : 'YES';
  if (!rangeOpen(r)) return `Past range: the edge is gone above ${r.maxCents}¢`;
  if (r.minCents != null && r.minCents === r.maxCents) return `Buy ${s} at ${r.maxCents}¢`;
  if (r.minCents != null) return `Buy ${s} ${r.minCents}–${r.maxCents}¢`;
  return `Buy ${s} up to ${r.maxCents}¢`;
}

/**
 * The one-line reader copy, with its reason clause: "Buy YES up to 62¢ · edge holds to 62¢".
 * currentCents (the side's live price, optional) above max_entry ⇒ the pick is past its
 * range and says so plainly — the pick itself is never hidden or changed.
 */
export function entryRangeText(side, r, currentCents = null) {
  const label = entryRangeLabel(side, r);
  if (!label) return null;
  if (!rangeOpen(r)) return label;
  if (Number.isFinite(currentCents) && currentCents > r.maxCents) {
    return `Past range: the edge is gone above ${r.maxCents}¢`;
  }
  return `${label} · edge holds to ${r.maxCents}¢`;
}
