// ext_player_status feed — per-player availability, depth order and snap share
// from the PFF Developer API roster endpoint.
//
// WHY IT EXISTS. The projection engine's only availability input was nflverse's
// injury report, which 404s for the current season until Week 1 and even then is
// thin — 5 designations league-wide on 2026-09-09 against PFF's 172. On that
// date NE ruled TreVeyon Henderson out, the engine defaulted him to PROBABLE,
// and a wrong-side STRONG prop call published against Rhamondre Stevenson.
//
// This feed also carries the two things the engine has NO source for at all:
// `depth_order` (a real 1,2,3… ordering — nflverse only marks rank-1) and
// `snap_pct`. Both are inputs the usage machinery needs and has never had.
//
// ⛔ INTERNAL-ONLY, same posture as the other ext_* feeds. RLS service-role-only,
// never wired to a renderer or public route, name banned in the site repo by
// lint:source-mask.
//
// IDENTITY: rows keep PFF's own `pff_player_id`. That is deliberate and is the
// first vendor id persisted in an ext_* table — resolving it to a gsis id ONCE
// via ext_player_xwalk beats name-matching on every run, and survives trades and
// name-spelling drift. See the migration header.

import { resolveTeamCode } from '../lib/nfl-teams.js';
import { num, int, str } from '../lib/ext-parse.js';
import { loadStagingRows, resolveSeason } from './ext-shared.js';

const FEED = 'roster-status';

// raw staging row → ext_player_status row, or null if it can't be keyed.
function normalizeRow(raw, { season, source }) {
  const pffId = str(raw.pff_player_id);
  if (!pffId) return null;
  const name = str(raw.name);
  if (!name) return null;
  return {
    season,
    // PFF serves TODAY's roster with no week of its own, so the week is stamped
    // at capture time. A status row without it is not interpretable later.
    week: int(raw.week) ?? 0,
    pff_player_id: pffId,
    player_name: name,
    // Best-effort: an unresolved team leaves null rather than dropping the row —
    // the status is still true even if the code is unfamiliar (grades-player.js
    // takes the same line for player-keyed feeds).
    team: resolveTeamCode(raw.team) || null,
    position: str(raw.position),
    alignment: str(raw.alignment),
    unit: str(raw.unit),
    // A real ordering, unlike nflverse's rank-1-only mark.
    depth_order: int(raw.depth_order),
    // The vendor's own word, passed through unmapped. Normalising to the
    // engine's OUT/DOUBTFUL/QUESTIONABLE vocabulary happens at READ time, where
    // the mapping table already lives — doing it here would fork the vocabulary
    // into two places and lose the vendor's original.
    status: str(raw.status),
    snap_pct: num(raw.snap_pct),
    snap_counts: int(raw.snap_counts),
    jersey: int(raw.jersey),
    source: source || 'manual',
    // now() default fires on INSERT only — see dvoa-team.js / the reliability
    // doc §5. An upsert that omits this leaves the first capture's timestamp.
    ingested_at: new Date().toISOString(),
  };
}

export function normalizeRosterStatus(rawRows, { season, source } = {}) {
  const out = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of rawRows || []) {
    const row = normalizeRow(raw, { season, source });
    if (!row) {
      dropped.push(raw?.name || raw?.pff_player_id || '(unkeyable)');
      continue;
    }
    // Collapse intra-batch dupes on the exact unique key, or the upsert throws
    // "ON CONFLICT ... cannot affect row a second time".
    const key = `${row.season}|${row.week}|${row.pff_player_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return { rows: out, dropped };
}

// ⛔ SYNCHRONOUS. scripts/ingest-ext-feeds.js calls fetchOnce WITHOUT await; an
// async version returns a Promise and the runner destructures undefined.
export function fetchOnce({ stagingPath, season, source } = {}) {
  const staged = loadStagingRows(FEED, stagingPath);
  const yr = resolveSeason(FEED, season, staged.season);
  return normalizeRosterStatus(staged.rows, { season: yr, source });
}
