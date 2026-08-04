// ext_player_grades feed — per-player process grades + WAR (NFL fusion §2a).
// INTERNAL-ONLY benchmark. week 0 = full-season row. player_id is a synthetic
// slug since no stable vendor id is captured. Position-specific snap counts and
// any extra columns ride jsonb so the schema tolerates the per-position column
// variance.

import { resolveTeamCode } from '../lib/nfl-teams.js';
import { num, int, bool, str, playerSlug } from '../lib/ext-parse.js';
import { loadStagingRows, resolveSeason } from './ext-shared.js';

const FEED = 'grades-player';

function normalizeRow(raw, { season, source }) {
  const name = str(raw.name);
  const position = str(raw.position);
  if (!name || !position) return null;
  // team is best-effort: external player rows always have it, but keep the row
  // even if it can't be resolved (player grades are useful team-agnostic too).
  const team = resolveTeamCode(raw.team);
  return {
    season,
    week: int(raw.week) ?? 0,
    player_id: playerSlug(name, team || raw.team, position),
    position,
    name,
    team,
    jersey: int(raw.jersey),
    age: int(raw.age),
    college: str(raw.college),
    draft_year: int(raw.draft_year),
    draft_round: int(raw.draft_round),
    draft_pick: int(raw.draft_pick),
    height: str(raw.height),
    weight: int(raw.weight),
    forty: num(raw.forty),
    rs_flag: bool(raw.rs),
    off: num(raw.off),
    pass: num(raw.pass),
    run: num(raw.run),
    recv: num(raw.recv),
    pblk: num(raw.pblk),
    rblk: num(raw.rblk),
    war: num(raw.war),
    war_rank: int(raw.war_rank),
    snaps: raw.snaps && typeof raw.snaps === 'object' ? raw.snaps : {},
    extra: raw.extra && typeof raw.extra === 'object' ? raw.extra : {},
    source: source || 'manual',
    // now() default fires on INSERT only — see dvoa-team.js / reliability doc §5.
    ingested_at: new Date().toISOString(),
  };
}

export function normalizePlayerGrades(rawRows, { season, source } = {}) {
  const out = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of rawRows || []) {
    const row = normalizeRow(raw, { season, source });
    if (!row) {
      dropped.push(raw.name || '(no name)');
      continue;
    }
    // Collapse intra-batch dupes on the unique key so the upsert doesn't throw
    // "ON CONFLICT ... cannot affect row a second time".
    const key = `${row.season}|${row.week}|${row.player_id}|${row.position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return { rows: out, dropped };
}

export function fetchOnce({ stagingPath, season, source } = {}) {
  const staged = loadStagingRows(FEED, stagingPath);
  const yr = resolveSeason(FEED, season, staged.season);
  return normalizePlayerGrades(staged.rows, { season: yr, source });
}
