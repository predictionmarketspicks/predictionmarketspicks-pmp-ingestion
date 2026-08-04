// ext_team_grades feed — phase-level team process grades (NFL fusion §2b).
// INTERNAL-ONLY benchmark; see ext-shared.js + the migration header. Swappable
// fetch layer: staging JSON today → CSV/API once licensed.

import { resolveTeamCode } from '../lib/nfl-teams.js';
import { num, int, str } from '../lib/ext-parse.js';
import { loadStagingRows, resolveSeason } from './ext-shared.js';

const FEED = 'grades-team';

// raw row → ext_team_grades row, or null if the team can't be resolved.
function normalizeRow(raw, { season, source }) {
  const team = resolveTeamCode(raw.team);
  if (!team) return null;
  return {
    season,
    week_scope: str(raw.week_scope) || 'REGPO',
    team,
    pf: int(raw.pf),
    pa: int(raw.pa),
    record: str(raw.record),
    overall: num(raw.overall),
    off: num(raw.off),
    pass: num(raw.pass),
    pblk: num(raw.pblk),
    recv: num(raw.recv),
    run: num(raw.run),
    rblk: num(raw.rblk),
    def: num(raw.def),
    rdef: num(raw.rdef),
    tack: num(raw.tack),
    prsh: num(raw.prsh),
    cov: num(raw.cov),
    spec: num(raw.spec),
    source: source || 'manual',
    // now() default fires on INSERT only — see dvoa-team.js / reliability doc §5.
    ingested_at: new Date().toISOString(),
  };
}

export function normalizeTeamGrades(rawRows, { season, source } = {}) {
  const out = [];
  const dropped = [];
  for (const raw of rawRows || []) {
    const row = normalizeRow(raw, { season, source });
    if (row) out.push(row);
    else dropped.push(raw.team);
  }
  return { rows: out, dropped };
}

export function fetchOnce({ stagingPath, season, source } = {}) {
  const staged = loadStagingRows(FEED, stagingPath);
  const yr = resolveSeason(FEED, season, staged.season);
  return normalizeTeamGrades(staged.rows, { season: yr, source });
}
