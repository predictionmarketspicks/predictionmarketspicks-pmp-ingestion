// ext_power_ranks feed — point-spread / QB ratings + 10k-sim probabilities
// (NFL fusion §2c). INTERNAL-ONLY benchmark. Probabilities are stored as
// fractions (pct() coerces "62%" → 0.62). week 0 = preseason / to-date.

import { resolveTeamCode } from '../lib/nfl-teams.js';
import { num, int, pct } from '../lib/ext-parse.js';
import { loadStagingRows } from './ext-shared.js';

const FEED = 'power-ranks';

function normalizeRow(raw, { season, source }) {
  const team = resolveTeamCode(raw.team);
  if (!team) return null;
  return {
    season,
    week: int(raw.week) ?? 0,
    team,
    point_spread_rating: num(raw.point_spread_rating),
    qb_rating: num(raw.qb_rating),
    sos_to_date: num(raw.sos_to_date),
    sos_remaining: num(raw.sos_remaining),
    sim_avg_wins: num(raw.sim_avg_wins),
    make_playoffs_pct: pct(raw.make_playoffs_pct),
    win_division_pct: pct(raw.win_division_pct),
    win_conference_pct: pct(raw.win_conference_pct),
    win_super_bowl_pct: pct(raw.win_super_bowl_pct),
    source: source || 'manual',
  };
}

export function normalizePowerRanks(rawRows, { season, source } = {}) {
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
  const yr = season ?? staged.season;
  if (!yr) throw new Error(`[${FEED}] season is required (pass --season or set "season" in the staging file)`);
  return normalizePowerRanks(staged.rows, { season: yr, source });
}
