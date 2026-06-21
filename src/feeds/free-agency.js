// ext_free_agents feed — roster-delta: WAR + signing destinations + contracts
// (NFL fusion §2d). INTERNAL-ONLY benchmark. season = the FA class year (2026).
// The 3-season snaps/grade/rank/war history rides jsonb `history` (variable
// length/shape). team_from / team_to resolve to gridiron codes when present;
// unsigned players have a null destination by design.

import { resolveTeamCode } from '../lib/nfl-teams.js';
import { num, int, dollars, str, playerSlug } from '../lib/ext-parse.js';
import { loadStagingRows } from './ext-shared.js';

const FEED = 'free-agency';

function normalizeRow(raw, { season, source }) {
  const name = str(raw.name);
  const position = str(raw.position);
  if (!name) return null;
  const team_from = raw.team_from ? resolveTeamCode(raw.team_from) : null;
  const team_to = raw.team_to ? resolveTeamCode(raw.team_to) : null;
  return {
    season,
    player_id: playerSlug(name, team_from || raw.team_from || 'fa', position),
    name,
    position,
    age: int(raw.age),
    status: str(raw.status),
    team_from,
    team_to,
    contract_avg_yr: dollars(raw.contract_avg_yr),
    contract_guaranteed: dollars(raw.contract_guaranteed),
    contract_total: dollars(raw.contract_total),
    contract_proj_avg_yr: dollars(raw.contract_proj_avg_yr),
    war: num(raw.war),
    war_rank: int(raw.war_rank),
    history: Array.isArray(raw.history) ? raw.history : [],
    source: source || 'manual',
  };
}

export function normalizeFreeAgents(rawRows, { season, source } = {}) {
  const out = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of rawRows || []) {
    const row = normalizeRow(raw, { season, source });
    if (!row) {
      dropped.push(raw.name || '(no name)');
      continue;
    }
    const key = `${row.season}|${row.player_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return { rows: out, dropped };
}

export function fetchOnce({ stagingPath, season, source } = {}) {
  const staged = loadStagingRows(FEED, stagingPath);
  const yr = season ?? staged.season;
  if (!yr) throw new Error(`[${FEED}] season is required (pass --season or set "season" in the staging file)`);
  return normalizeFreeAgents(staged.rows, { season: yr, source });
}
