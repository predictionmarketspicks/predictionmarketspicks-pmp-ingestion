// alert-key.js — dedup keys and pick→alert mapping for commodity edge alerts.
// handoffs/BITCOIN_EDGE_ALERT_IS_THE_PICK_2026-09-22.md §4–§5 (site repo).
//
// Pure functions only, so they can be tested without booting the engine.

import { applyCalibrationTierCeiling } from './tier-ceiling.js';

// Event in the key: KXBTCD is hourly, and a strike is a DIFFERENT contract
// every hour. Without it the 6h cooldown suppressed the next hour's contract
// (2026-09-22: the 12 PM pick never alerted) and edge_alerts' upsert on
// alert_key overwrote another day's row. PUBLISHED tier (post-ceiling), not
// raw: a raw flip that publishes the same tier must not re-post.
// Position [1] stays `commodity` — discord-potd-candidate reads split(':')[1].
export function commodityAlertKey(commodity, eventTicker, publishedTier, edge) {
  return `commodity_edge:${commodity}:${eventTicker}:${publishedTier}:${edge.direction}:${edge.strike.toFixed(2)}`;
}

export function publishedTierFor(commodity, rawTier, meta) {
  return applyCalibrationTierCeiling(commodity, rawTier, meta);
}

// Bitcoin (alertOnPickOnly): the alert IS the graded pick, one per pick_id.
export function pickAlertKey(commodity, pickId) {
  return `commodity_pick:${commodity}:${pickId}`;
}

// tool_picks.source_row_id = '<commodity>:<event_ticker>:<strike>:<date>'.
export function pickSourcePrefix(commodity, eventTicker) {
  return `${commodity}:${eventTicker}:`;
}

const TIER_BY_INT = { 1: 'SPECULATIVE', 2: 'MODERATE', 3: 'STRONG' };

export function tierFromPick(pick) {
  return TIER_BY_INT[Number(pick?.confidence_tier)] ?? 'SPECULATIVE';
}

export function pickStrike(pick) {
  const s = Number(pick?.regime_tags?.strike ?? String(pick?.source_row_id ?? '').split(':')[2]);
  return Number.isFinite(s) ? s : null;
}

// The snapshot row the pick was minted from (same strike), or null.
export function findPickRow(rows, pick) {
  const strike = pickStrike(pick);
  if (strike == null) return null;
  return (rows ?? []).find((r) => Math.abs(Number(r.strike) - strike) < 0.005) ?? null;
}

// Rebuild a topEdge-shaped object from the pick itself, for a pick minted on an
// earlier pass whose post failed (its strike may be gone from this snapshot).
// tool_picks units: market_price_at_pick + predicted_prob in dollars/0–1 for the
// PICKED side; edge_pp in percentage points.
export function topEdgeFromPick(pick) {
  const strike = pickStrike(pick);
  if (strike == null) return null;
  const yesSide = String(pick.predicted_side ?? '').toUpperCase() !== 'NO';
  const price = Number(pick.market_price_at_pick);
  const prob = Number(pick.predicted_prob);
  const edge = Number(pick.edge_pp) / 100;
  if (!Number.isFinite(price) || !Number.isFinite(prob)) return null;
  const signed = Number.isFinite(edge) ? (yesSide ? Math.abs(edge) : -Math.abs(edge)) : 0;
  return {
    direction: yesSide ? 'BUY YES' : 'BUY NO',
    strike,
    kalshi_yes: yesSide ? price : 1 - price,
    prob_physical: yesSide ? prob : 1 - prob,
    options_prob: yesSide ? prob : 1 - prob,
    model_version: 'v2_physical',
    edge_pp: signed,
    fused_edge_pp: signed,
    rationale: '',
  };
}

// "2:00 PM ET" from an ISO close time; null on a bad input.
export function settleTimeEt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`;
}
