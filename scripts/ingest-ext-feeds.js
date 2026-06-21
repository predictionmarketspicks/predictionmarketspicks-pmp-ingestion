#!/usr/bin/env node
// Ingest the external-benchmark staging files into the INTERNAL-ONLY ext_*
// tables (NFL grades/DVOA fusion Phase 1).
//
//   node scripts/ingest-ext-feeds.js [feed] --season=2025 [--source=manual] [--dry]
//
//   feed   one of: grades-team | grades-player | power-ranks | free-agency |
//          dvoa-team | all   (default: all)
//   --season   season year; falls back to "season" inside each staging file
//   --source   row source tag (manual | export | api), default manual
//   --dry      normalize + report counts, skip the Supabase upsert
//
// Each feed reads data/ext-staging/<feed>.json (a Claude-in-Chrome capture or a
// licensed export). Missing staging files are reported and skipped, not fatal,
// so a partial backfill run still lands the feeds you have. Requires
// SUPABASE_URL + SUPABASE_SERVICE_KEY in the env for a non-dry run.

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

const FEEDS = {
  'grades-team': { fetch: fetchTeamGrades, upsert: upsertTeamGrades },
  'grades-player': { fetch: fetchPlayerGrades, upsert: upsertPlayerGrades },
  'power-ranks': { fetch: fetchPowerRanks, upsert: upsertPowerRanks },
  'free-agency': { fetch: fetchFreeAgents, upsert: upsertFreeAgents },
  'dvoa-team': { fetch: fetchTeamDvoa, upsert: upsertTeamDvoa },
};

function parseArgs(argv) {
  const opts = { feed: 'all', season: undefined, source: 'manual', dry: false };
  for (const a of argv) {
    if (a === '--dry') opts.dry = true;
    else if (a.startsWith('--season=')) opts.season = Number(a.slice('--season='.length));
    else if (a.startsWith('--source=')) opts.source = a.slice('--source='.length);
    else if (!a.startsWith('--')) opts.feed = a;
  }
  return opts;
}

async function runFeed(name, { season, source, dry }) {
  const { fetch, upsert } = FEEDS[name];
  let result;
  try {
    result = fetch({ season, source });
  } catch (err) {
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
  console.log(`ext-feeds ingest — feed=${opts.feed} season=${opts.season ?? '(from file)'} source=${opts.source}${opts.dry ? ' [DRY]' : ''}`);
  const summary = [];
  for (const n of names) {
    summary.push(await runFeed(n, opts));
  }
  const written = summary.reduce((s, r) => s + (r.written || 0), 0);
  console.log(`done — ${written} total rows ${opts.dry ? 'would be written' : 'written'} across ${names.length} feed(s).`);
}

main().catch((err) => {
  console.error('ext-feeds ingest failed:', err.message);
  process.exit(1);
});
