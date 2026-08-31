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

// ── run-level heartbeat (F8) ────────────────────────────────────────────────
//
// One row per ingest run into ext_capture_runs (SITE migration
// 20260831230000_ext_capture_runs.sql — same shape as nfl_price_capture_runs).
// Exists because the table-level freshness workflow can only see ROWS ARRIVING;
// it cannot distinguish "run never happened" from "run happened and legitimately
// wrote nothing" (frozen off-season data upserts in place, so ingested_at moves
// but nothing else does — and a run killed before the upsert leaves no trace at
// all). The heartbeat records what the run actually SAW, per feed, so the
// Mon/Wed in-season check in ext-feeds-freshness.yml has something to read.
export async function recordExtCaptureRun({ summary, source }) {
  const sb = getClient();
  const feedCounts = {};
  let received = 0;
  let inserted = 0;
  let skipped = 0;
  let batchesFailed = 0;
  for (const r of summary) {
    feedCounts[r.name] = {
      normalized: r.normalized ?? 0,
      written: r.written ?? 0,
      dropped: r.dropped ?? 0,
      ...(r.blocked ? { blocked: true } : {}),
      ...(r.skipped ? { skipped: true } : {}),
    };
    received += r.normalized ?? 0;
    inserted += r.written ?? 0;
    skipped += r.dropped ?? 0;
    if (r.blocked || r.skipped) batchesFailed += 1;
  }
  const row = {
    captured_at: new Date().toISOString(),
    received,
    inserted,
    skipped,
    batches_failed: batchesFailed,
    feed_counts: feedCounts,
    source: source ?? null,
  };
  const { error } = await sb
    .from('ext_capture_runs')
    .upsert(row, { onConflict: 'captured_at' });
  if (error) throw new Error(`ext_capture_runs upsert: ${error.message}`);
  return row;
}
