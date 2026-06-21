// Supabase writer for the INTERNAL-ONLY external-benchmark tables (NFL
// grades/DVOA fusion Phase 1). Reuses the service-role client from supabase.js
// (RLS-bypass) — these ext_* tables have NO anon/authenticated grant, so only
// this path can write them. Idempotent batch upserts on each table's UNIQUE key,
// so a re-run of the same season's staging file updates in place.
//
// CONTAINMENT: nothing here ever reads back to a public surface. These rows feed
// the Phase 2 fusion module only. See handoffs/NFL_GRADES_DVOA_FUSION_2026-06-20.md.

import { getClient } from './supabase.js';

async function upsert(table, rows, onConflict) {
  if (!rows || rows.length === 0) return { count: 0 };
  const sb = getClient();
  const { data, error } = await sb
    .from(table)
    .upsert(rows, { onConflict })
    .select('season');
  if (error) throw new Error(`${table} upsert: ${error.message}`);
  return { count: data?.length ?? 0 };
}

export function upsertTeamGrades(rows) {
  return upsert('ext_team_grades', rows, 'season,week_scope,team');
}

export function upsertPlayerGrades(rows) {
  return upsert('ext_player_grades', rows, 'season,week,player_id,position');
}

export function upsertPowerRanks(rows) {
  return upsert('ext_power_ranks', rows, 'season,week,team');
}

export function upsertFreeAgents(rows) {
  return upsert('ext_free_agents', rows, 'season,player_id');
}

export function upsertTeamDvoa(rows) {
  return upsert('ext_team_dvoa', rows, 'season,week,team');
}

// feed name → { fetch module export, upsert fn }. The runner walks this.
export const EXT_FEED_WRITERS = {
  'grades-team': upsertTeamGrades,
  'grades-player': upsertPlayerGrades,
  'power-ranks': upsertPowerRanks,
  'free-agency': upsertFreeAgents,
  'dvoa-team': upsertTeamDvoa,
};
