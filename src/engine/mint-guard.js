// Mint-timing guard for the daily oil engine (site repo
// handoffs/OIL_EDGE_DEEP_DIVE_2026-11-09.md §4 U3).
//
// The mint is a DB trigger on commodity_edge_signals
// (_leaderboard_commodity_pick_insert): it mints a tool_picks row from the FIRST
// BUY row it sees per (commodity, event, ET day) with a MODERATE+ fused tier and
// no quality flag. The engine therefore controls WHEN a mint can happen only by
// what it upserts — a BUY row written at 9:36 ET is a pick, full stop.
//
// Two gates, oil only:
//   1. No oil BUY before 10:00 ET. The 9:36 tick is the worst-informed minute of
//      the session: the first Yahoo print of the day is the pre-open, the USO
//      chain has just opened, and the measured record splits 9 AM mints −$6.28
//      over 219 picks vs 10 AM +$8.06 over 39 (§3; batch-day caveat noted there).
//   2. No oil BUY when the spot is older than 60 s. With the U1 delta-bridge the
//      spot is as-of the proxy's last print, so > 60 s means the bridge fell back
//      to the raw delayed quote. Belt behind U1's 120 s tier demotion.
//
// A guarded row becomes PASS / skip / NO_EDGE with pass_reason 'fused_no_edge'
// (the vocabulary is a DB CHECK — "cleared every gate, then a cap collapsed it"
// is exactly this case) and the reason appended to its rationale. entry_floor
// WATCH rows are left alone: they are off-record by construction. Pure; no I/O.

import { etClock } from './engine-rules.js';

export const OIL_MINT_OPEN_HOUR_ET = 10;
export const OIL_MINT_MAX_SPOT_AGE_MS = 60_000;

/**
 * Decide whether the oil mint is open right now. Returns null when it is, or a
 * short reason string when it is not. `meta` is snap.meta (spotPublishTimeMs).
 */
export function oilMintBlockReason(meta, { nowMs = Date.now(), openHourEt = OIL_MINT_OPEN_HOUR_ET, maxSpotAgeMs = OIL_MINT_MAX_SPOT_AGE_MS } = {}) {
  const { hourEt } = etClock(new Date(nowMs));
  if (hourEt < openHourEt) return `before ${String(openHourEt).padStart(2, '0')}:00 ET (${hourEt}h)`;
  const published = meta?.spotPublishTimeMs;
  if (!Number.isFinite(published)) return 'spot age unknown';
  const ageMs = nowMs - published;
  if (ageMs > maxSpotAgeMs) return `spot ${Math.round(ageMs / 1000)}s old (max ${maxSpotAgeMs / 1000}s)`;
  return null;
}

/**
 * Apply the guard to a snapshot IN PLACE. Oil only — every other commodity is
 * returned untouched. Returns { blocked: reason | null, demoted: n }.
 */
export function applyOilMintGuard(config, snap, opts = {}) {
  if (!snap || config?.commodity !== 'oil') return { blocked: null, demoted: 0 };
  const reason = oilMintBlockReason(snap.meta, opts);
  if (!reason) return { blocked: null, demoted: 0 };
  let demoted = 0;
  for (const r of snap.rows ?? []) {
    if (r.direction !== 'BUY YES' && r.direction !== 'BUY NO') continue;
    r.direction = 'PASS';
    r.confidence = 'skip';
    r.fused_confidence = 'NO_EDGE';
    r.pass_reason = 'fused_no_edge';
    r.rationale = `${r.rationale ?? ''} (mint guard: ${reason} — no oil pick is minted here)`.trim();
    demoted += 1;
  }
  if (snap.meta) {
    snap.meta.topEdge = null;
    snap.meta.topTier = 'NO_EDGE';
    snap.meta.mintGuard = reason;
  }
  return { blocked: reason, demoted };
}
