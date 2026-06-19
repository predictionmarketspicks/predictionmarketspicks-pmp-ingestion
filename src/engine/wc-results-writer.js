// World Cup 2026 result autofeed — persist completed ESPN games + trigger sim.
// handoffs/WC_RESULT_AUTOFEED_2026-06-18.md (Phases 2 + 3).
//
// Rides the existing 30-min runWcSnapshotOnce() ESPN fetch (no new scan, no new
// schedule). Native fetch + AbortController only — NO axios (house rule).
//
// Flow:
//   1. Filter the ESPN games to completed (state==='post') rows that carry a
//      resolved match_id + finite scores.
//   2. Diff against the table to find NEWLY-settled matches (debounce).
//   3. Upsert all FT rows (idempotent on match_id).
//   4. If anything is newly settled, fire a repository_dispatch so the WC sim
//      re-runs near-real-time (collapses Lag B). Dispatch no-ops without
//      GH_DISPATCH_TOKEN, so this is safe to ship before the secret is set.

import { upsertWcResults, fetchExistingWcFtIds } from '../delivery/supabase.js';

const DISPATCH_REPO =
  process.env.GH_DISPATCH_REPO ||
  'predictionmarketspicks/predictionmarketspicks-pmp-ingestion';

// Persist completed ESPN games to world_cup_results. Returns the list of
// NEWLY-settled match_ids (not already FT in the table) so the caller can
// decide whether to fire a sim re-run.
export async function persistWcFtResults(espnGames) {
  const ft = (espnGames || []).filter(
    (g) =>
      g.state === 'post' &&
      g.match_id &&
      Number.isFinite(g.home_score) &&
      Number.isFinite(g.away_score),
  );
  if (ft.length === 0) return { upserted: 0, newlySettled: [] };

  // Which of these are already FT in the table? (debounce the dispatch).
  const ids = ft.map((g) => g.match_id);
  const existing = await fetchExistingWcFtIds(ids);
  const newlySettled = ft.filter((g) => !existing.has(g.match_id)).map((g) => g.match_id);

  const rows = ft.map((g) => ({
    match_id: g.match_id,
    home_slug: g.home_slug,
    away_slug: g.away_slug,
    home_score: g.home_score,
    away_score: g.away_score,
    status: 'FT',
    source: 'espn',
    espn_event_id: g.espn_event_id || null,
    updated_at: new Date().toISOString(),
    // settled_at intentionally omitted — keeps its insert default on re-upsert.
  }));

  const { count } = await upsertWcResults(rows);
  return { upserted: count, newlySettled };
}

// Fire a repository_dispatch to re-run the WC sim. Native fetch + AbortController.
// No-op (warn only) when GH_DISPATCH_TOKEN is unset, so the engine ships safely
// before Benny creates the PAT. The workflow's concurrency group collapses
// rapid-fire settlements, so an occasional extra dispatch is harmless.
export async function dispatchSimRerun(matchIds) {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    console.warn('[wc-dispatch] no GH_DISPATCH_TOKEN — skipping sim trigger');
    return { dispatched: false, reason: 'no-token' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://api.github.com/repos/${DISPATCH_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: 'wc-result-settled',
        client_payload: { matchIds },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[wc-dispatch] HTTP ${res.status}: ${body.slice(0, 240)}`);
      return { dispatched: false, reason: `http-${res.status}` };
    }
    console.log(`[wc-dispatch] sim re-run dispatched for ${matchIds.join(', ')}`);
    return { dispatched: true };
  } catch (err) {
    console.warn('[wc-dispatch] failed:', err?.message || err);
    return { dispatched: false, reason: 'fetch-error' };
  } finally {
    clearTimeout(timer);
  }
}
