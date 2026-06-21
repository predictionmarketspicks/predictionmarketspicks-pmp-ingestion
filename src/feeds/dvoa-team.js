// ext_team_dvoa feed — opponent-adjusted efficiency + variance benchmark
// (NFL fusion §2e). INTERNAL-ONLY; the gold-standard partner our DAEPA model
// ensembles against, plus the variance/consistency dimension we don't compute.
// DVOA/VOA values stored as fractions (pct() coerces "18.2%" → 0.182). week 0 =
// full-season row.

import { resolveTeamCode } from '../lib/nfl-teams.js';
import { num, int, pct } from '../lib/ext-parse.js';
import { loadStagingRows } from './ext-shared.js';

const FEED = 'dvoa-team';

function normalizeRow(raw, { season, source }) {
  const team = resolveTeamCode(raw.team);
  if (!team) return null;
  return {
    season,
    week: int(raw.week) ?? 0,
    team,
    tot_dvoa: pct(raw.tot_dvoa),
    tot_dvoa_rank: int(raw.tot_dvoa_rank),
    non_adj_voa: pct(raw.non_adj_voa),
    wins: int(raw.wins),
    losses: int(raw.losses),
    last_year_rank: int(raw.last_year_rank),
    off_dvoa: pct(raw.off_dvoa),
    off_dvoa_rank: int(raw.off_dvoa_rank),
    def_dvoa: pct(raw.def_dvoa),
    def_dvoa_rank: int(raw.def_dvoa_rank),
    st_dvoa: pct(raw.st_dvoa),
    st_dvoa_rank: int(raw.st_dvoa_rank),
    off_voa: pct(raw.off_voa),
    def_voa: pct(raw.def_voa),
    st_voa: pct(raw.st_voa),
    est_wins: num(raw.est_wins),
    est_wins_rank: int(raw.est_wins_rank),
    wei_dvoa: pct(raw.wei_dvoa),
    wei_dvoa_rank: int(raw.wei_dvoa_rank),
    sched_past: pct(raw.sched_past),
    sched_past_rank: int(raw.sched_past_rank),
    sched_future: pct(raw.sched_future),
    sched_future_rank: int(raw.sched_future_rank),
    variance: pct(raw.variance),
    variance_rank: int(raw.variance_rank),
    source: source || 'manual',
  };
}

export function normalizeTeamDvoa(rawRows, { season, source } = {}) {
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
  return normalizeTeamDvoa(staged.rows, { season: yr, source });
}
