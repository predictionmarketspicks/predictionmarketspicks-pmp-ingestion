#!/usr/bin/env node
// Ingest the external-benchmark staging files into the INTERNAL-ONLY ext_*
// tables (NFL grades/DVOA fusion Phase 1).
//
//   node scripts/ingest-ext-feeds.js [feed] [--season=2025] [--source=manual] [--dry]
//
//   feed   one of: grades-team | grades-player | power-ranks | free-agency |
//          dvoa-team | all   (default: all)
//   --season   season year; the staging file's own "season" WINS and a
//              disagreement is a hard error (see resolveSeason)
//   --source   row source tag (manual | export | api), default manual
//   --dry      normalize + report counts, skip the Supabase upsert
//   --allow-stale        ingest even when the staging file is stale
//   --max-age-hours=N    use a rolling N-hour window instead of the day boundary
//
// Each feed reads data/ext-staging/<feed>.json (a Claude-in-Chrome capture or a
// licensed export). Missing staging files are reported and skipped, not fatal,
// so a partial backfill run still lands the feeds you have. Requires
// SUPABASE_URL + SUPABASE_SERVICE_KEY in the env for a non-dry run.
//
// STALENESS: staging files are never cleared, so a capture that failed outright
// leaves the previous run's file in place — it then normalizes to exactly the
// expected row count and every check passes. That is how a dead PFF session went
// six weeks unnoticed. A file not written TODAY is BLOCKED in both dry and real
// runs (the misleading COUNT is the trap, so a dry run must not print one either)
// and the process exits non-zero. Deliberate backfills pass --allow-stale.
// The day boundary mirrors SKILL.md §5's `find -daystart -mtime +0` on purpose —
// see stalenessOf() for why a rolling window is the wrong shape here.
// handoffs/NFL_EXT_FEEDS_RELIABILITY_FIXES_2026-08-03.md §3.

import { fetchOnce as fetchTeamGrades } from '../src/feeds/grades-team.js';
import { fetchOnce as fetchPlayerGrades } from '../src/feeds/grades-player.js';
import { fetchOnce as fetchPowerRanks } from '../src/feeds/power-ranks.js';
import { fetchOnce as fetchFreeAgents } from '../src/feeds/free-agency.js';
import { fetchOnce as fetchTeamDvoa } from '../src/feeds/dvoa-team.js';
import {
  upsertTeamGrades,
  upsertPlayerGrades,
  upsertPowerRanks,
  upsertFreeAgents,
  upsertTeamDvoa,
} from '../src/delivery/ext-feeds.js';
import { stagingAgeHours, isCapturedToday, stagingPathFor } from '../src/feeds/ext-shared.js';

function formatAge(hours) {
  return hours >= 48 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;
}

// Stale = "not captured by this run". Default is the calendar-DAY boundary, the
// same rule as SKILL.md §5's `find -daystart -mtime +0`; --max-age-hours=N opts
// into a rolling window instead. Day-boundary is the default on purpose: a
// capture session runs for hours, and a rolling window flags files that same
// session wrote (8/3: a 60-min gate flagged that morning's own dvoa-team.json).
function stalenessOf(feed, maxAgeHours) {
  const ageHours = stagingAgeHours(feed);
  if (ageHours == null) return { missing: true };
  const stale = maxAgeHours == null ? isCapturedToday(feed) === false : ageHours > maxAgeHours;
  const limit = maxAgeHours == null ? 'not captured today' : `limit ${maxAgeHours}h`;
  return { stale, age: formatAge(ageHours), limit };
}

const FEEDS = {
  'grades-team': { fetch: fetchTeamGrades, upsert: upsertTeamGrades },
  'grades-player': { fetch: fetchPlayerGrades, upsert: upsertPlayerGrades },
  'power-ranks': { fetch: fetchPowerRanks, upsert: upsertPowerRanks },
  'free-agency': { fetch: fetchFreeAgents, upsert: upsertFreeAgents },
  'dvoa-team': { fetch: fetchTeamDvoa, upsert: upsertTeamDvoa },
};

function parseArgs(argv) {
  const opts = {
    feed: 'all',
    season: undefined,
    source: 'manual',
    dry: false,
    allowStale: false,
    maxAgeHours: undefined, // undefined = day boundary; a number = rolling window
  };
  for (const a of argv) {
    if (a === '--dry') opts.dry = true;
    else if (a === '--allow-stale') opts.allowStale = true;
    else if (a.startsWith('--season=')) opts.season = Number(a.slice('--season='.length));
    else if (a.startsWith('--source=')) opts.source = a.slice('--source='.length);
    else if (a.startsWith('--max-age-hours=')) opts.maxAgeHours = Number(a.slice('--max-age-hours='.length));
    else if (!a.startsWith('--')) opts.feed = a;
  }
  return opts;
}

async function runFeed(name, { season, source, dry, allowStale, maxAgeHours }) {
  const { fetch, upsert } = FEEDS[name];
  // Staleness first: a fossil file normalizes cleanly and reports a healthy
  // count, so the count can never be the thing that catches it.
  const { stale, age, limit } = stalenessOf(name, maxAgeHours);
  if (stale) {
    if (!allowStale) {
      console.warn(
        `  ${name}: BLOCKED — staging file is ${age} old (${limit}): ${stagingPathFor(name)}\n` +
          `      A failed capture leaves the PREVIOUS file on disk and it still counts correct. ` +
          `Re-capture it, or pass --allow-stale for a deliberate backfill.`,
      );
      return { name, blocked: true };
    }
    console.warn(`  ${name}: STALE ${age} — proceeding anyway (--allow-stale).`);
  }
  let result;
  try {
    result = fetch({ season, source });
  } catch (err) {
    if (err.code === 'SEASON_MISMATCH') {
      console.warn(`  ${name}: BLOCKED — ${err.message}`);
      return { name, blocked: true };
    }
    console.warn(`  ${name}: SKIP — ${err.message}`);
    return { name, skipped: true };
  }
  const { rows, dropped } = result;
  const dropNote = dropped.length ? `, ${dropped.length} dropped (unresolved: ${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? '…' : ''})` : '';
  if (dry) {
    console.log(`  ${name}: ${rows.length} rows normalized${dropNote} (dry — not written)`);
    return { name, normalized: rows.length, dropped: dropped.length, written: 0 };
  }
  const { count } = await upsert(rows);
  console.log(`  ${name}: ${count} rows upserted${dropNote}`);
  return { name, normalized: rows.length, dropped: dropped.length, written: count };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const names = opts.feed === 'all' ? Object.keys(FEEDS) : [opts.feed];
  for (const n of names) {
    if (!FEEDS[n]) {
      console.error(`unknown feed "${n}". valid: ${Object.keys(FEEDS).join(', ')}, all`);
      process.exit(2);
    }
  }
  if (!opts.dry && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for a non-dry run (or pass --dry).');
    process.exit(2);
  }
  if (opts.maxAgeHours !== undefined && (!Number.isFinite(opts.maxAgeHours) || opts.maxAgeHours < 0)) {
    console.error(`--max-age-hours must be a non-negative number (got "${opts.maxAgeHours}").`);
    process.exit(2);
  }
  console.log(
    `ext-feeds ingest — feed=${opts.feed} season=${opts.season ?? '(from file)'} source=${opts.source}` +
      ` freshness=${opts.maxAgeHours === undefined ? 'captured-today' : `${opts.maxAgeHours}h`}` +
      `${opts.allowStale ? ' [ALLOW-STALE]' : ''}${opts.dry ? ' [DRY]' : ''}`,
  );
  const summary = [];
  for (const n of names) {
    summary.push(await runFeed(n, opts));
  }
  const written = summary.reduce((s, r) => s + (r.written || 0), 0);
  const blocked = summary.filter((r) => r.blocked).map((r) => r.name);
  console.log(`done — ${written} total rows ${opts.dry ? 'would be written' : 'written'} across ${names.length} feed(s).`);
  if (blocked.length) {
    // Non-zero so an unattended run can't report success while feeds were
    // refused. A missing staging file stays a soft skip (documented above);
    // only stale-file and season-mismatch refusals fail the run.
    console.error(`BLOCKED: ${blocked.join(', ')} — nothing was written for these. See the lines above.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('ext-feeds ingest failed:', err.message);
  process.exit(1);
});
