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
//   --allow-sparse="<reason>"  ingest even when a required column is mostly null
//   --self-test          prove the null-density gate sees a blank column, no DB
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
//
// NULL DENSITY: a paywall does not thin the table, it blanks it. FTN logged out
// renders all 32 DVOA rows and all 27 columns with team/total/rank/week/year
// filled and the other 22 empty — a perfect 32 that upserts cleanly (25 of the
// table's 30 columns accept NULL) and turns every count-based check green. On
// 2026-09-21 Run A a human noticed. Now a required column null on more than
// NULL_TOLERANCE of the normalized rows is BLOCKED in both dry and real runs;
// a deliberate sparse ingest passes --allow-sparse="<reason>". The threshold is
// not zero: FTN's LAST YEAR column is "x" on all 32 rows in week 1 and that is
// correct, so REQUIRED_COLUMNS names only the columns a paywall blanks.
// handoffs/NFL_EXT_FEEDS_HALF_CAPTURE_GATE_2026-09-21.md §1.

import { fetchOnce as fetchTeamGrades } from '../src/feeds/grades-team.js';
import { fetchOnce as fetchPlayerGrades } from '../src/feeds/grades-player.js';
import { fetchOnce as fetchRosterStatus } from '../src/feeds/roster-status.js';
import { fetchOnce as fetchPowerRanks } from '../src/feeds/power-ranks.js';
import { fetchOnce as fetchFreeAgents } from '../src/feeds/free-agency.js';
import { fetchOnce as fetchTeamDvoa } from '../src/feeds/dvoa-team.js';
import {
  upsertTeamGrades,
  upsertPlayerGrades,
  upsertRosterStatus,
  upsertPowerRanks,
  upsertFreeAgents,
  upsertTeamDvoa,
  recordExtCaptureRun,
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

// Per-feed columns that MUST carry a value on most rows, in the normalized row
// shape (src/feeds/<feed>.js). A logged-out or paywalled capture blanks exactly
// these while leaving identity columns and the row count intact.
//   grades-player is position-dependent twice over: a QB has no `recv`, a WR no
//   `pass` — so the rule is "at least one grade per row" (`anyOf`) — AND the
//   table carries NO defensive or kicking grade columns at all, so a DI/ED/CB/
//   S/LB/K row has all four null BY CONSTRUCTION (measured on prod 2026-09-21:
//   season 2026 week 1 holds 1,228 rows, 648 of them defenders/kickers with
//   off/pass/run/recv all null, 0 no-grade rows among the offensive
//   positions). The rule is therefore scoped by `positions`: rows outside the
//   set are not in the denominator, so a broad capture (the 09-18 one, 15
//   positions) passes and a blanked offensive capture still blocks. K is
//   deliberately NOT in the set even though FACETS captures kickers — their
//   grade is field_goal, which this table does not store.
// free-agency and roster-status carry no gate: neither sits behind a login that
// blanks cells, and roster-status is legitimately sparse (injury columns).
export const REQUIRED_COLUMNS = {
  'dvoa-team': { all: ['off_dvoa', 'def_dvoa', 'st_dvoa', 'est_wins', 'wei_dvoa'] },
  'power-ranks': { all: ['point_spread_rating', 'sim_avg_wins', 'make_playoffs_pct'] },
  'grades-team': { all: ['overall', 'off', 'def'] },
  'grades-player': {
    anyOf: ['off', 'pass', 'run', 'recv'],
    positions: ['QB', 'HB', 'RB', 'WR', 'TE', 'FB', 'T', 'G', 'C'],
  },
};

// Share of rows a required column may be null on before the feed is BLOCKED.
// 0.10 = "≥90% populated" — catches a paywall (100% blank), tolerates a
// genuinely missing cell or a bye-week team.
export const NULL_TOLERANCE = 0.10;

function isNullish(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

// Pure: returns [] when the feed passes, else one message per offending column
// (or one message for the anyOf rule), each in the `<col> null on N/M rows`
// shape the BLOCKED line prints. No I/O so --self-test can drive it.
export function nullDensityViolations(feed, rows, tolerance = NULL_TOLERANCE) {
  const rule = REQUIRED_COLUMNS[feed];
  if (!rule || rows.length === 0) return [];
  const out = [];
  if (rule.all) {
    for (const col of rule.all) {
      const nulls = rows.filter((r) => isNullish(r[col])).length;
      if (nulls / rows.length > tolerance) out.push(`${col} null on ${nulls}/${rows.length} rows`);
    }
  }
  if (rule.anyOf) {
    // Denominator = rows the rule applies to (see the positions note above).
    const scoped = rule.positions
      ? rows.filter((r) => rule.positions.includes(String(r.position ?? '').toUpperCase()))
      : rows;
    if (scoped.length === 0) return out;
    const nulls = scoped.filter((r) => rule.anyOf.every((col) => isNullish(r[col]))).length;
    if (nulls / scoped.length > tolerance) {
      out.push(`no grade in any of ${rule.anyOf.join('/')} on ${nulls}/${scoped.length} ${rule.positions ? `${rule.positions.join('/')} ` : ''}rows`);
    }
  }
  return out;
}

const FEEDS = {
  'grades-team': { fetch: fetchTeamGrades, upsert: upsertTeamGrades },
  'grades-player': { fetch: fetchPlayerGrades, upsert: upsertPlayerGrades },
  'roster-status': { fetch: fetchRosterStatus, upsert: upsertRosterStatus },
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
    allowSparse: null, // the reason string; null = gate is armed
    selfTest: false,
    maxAgeHours: undefined, // undefined = day boundary; a number = rolling window
  };
  for (const a of argv) {
    if (a === '--dry') opts.dry = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--allow-stale') opts.allowStale = true;
    else if (a.startsWith('--allow-sparse=')) opts.allowSparse = a.slice('--allow-sparse='.length).trim();
    else if (a === '--allow-sparse') opts.allowSparse = ''; // rejected in main: the reason is mandatory
    else if (a.startsWith('--season=')) opts.season = Number(a.slice('--season='.length));
    else if (a.startsWith('--source=')) opts.source = a.slice('--source='.length);
    else if (a.startsWith('--max-age-hours=')) opts.maxAgeHours = Number(a.slice('--max-age-hours='.length));
    else if (!a.startsWith('--')) opts.feed = a;
  }
  return opts;
}

async function runFeed(name, { season, source, dry, allowStale, allowSparse, maxAgeHours }) {
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
  // Null density AFTER normalization and BEFORE any count is printed: the
  // count is the number that lies (32/32, every column present, every value
  // blank). Same shape as the stale-file refusal — dry runs refuse too.
  const sparse = nullDensityViolations(name, rows);
  if (sparse.length) {
    if (allowSparse == null) {
      console.warn(
        `  ${name}: BLOCKED — required column(s) mostly null: ${sparse.join('; ')}\n` +
          `      A logged-out paywall renders every row with the grade cells EMPTY and the count still reads correct. ` +
          `Check the login, re-capture, or pass --allow-sparse="<reason>" for a deliberate sparse ingest.`,
      );
      return { name, blocked: true };
    }
    console.warn(`  ${name}: SPARSE (${sparse.join('; ')}) — proceeding anyway (--allow-sparse: ${allowSparse}).`);
  }
  const dropNote = dropped.length ? `, ${dropped.length} dropped (unresolved: ${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? '…' : ''})` : '';
  if (dry) {
    console.log(`  ${name}: ${rows.length} rows normalized${dropNote} (dry — not written)`);
    return { name, normalized: rows.length, dropped: dropped.length, written: 0 };
  }
  const { count } = await upsert(rows);
  console.log(`  ${name}: ${count} rows upserted${dropNote}`);
  return { name, normalized: rows.length, dropped: dropped.length, written: count };
}

// --self-test: the gate must see a blank column, must not see a full one, and
// the anyOf rule and the tolerance boundary must land where the comment says.
// Synthetic rows only — no staging file, no Supabase.
function selfTest() {
  const failures = [];
  const check = (cond, label) => {
    console.log(`  ${cond ? '✓' : '✗'} ${label}`);
    if (!cond) failures.push(label);
  };
  const dvoaRow = (over) => ({
    season: 2026, week: 1, team: 'ARI', tot_dvoa: 0.12, tot_dvoa_rank: 3,
    off_dvoa: 0.05, def_dvoa: -0.03, st_dvoa: 0.01, est_wins: 9.4, wei_dvoa: 0.11, last_year_rank: null,
    ...over,
  });
  const good = Array.from({ length: 32 }, () => dvoaRow());
  // The 09-21 shape: identity + total + rank populated, every grade cell empty.
  const loggedOut = Array.from({ length: 32 }, () =>
    dvoaRow({ off_dvoa: null, def_dvoa: null, st_dvoa: null, est_wins: null, wei_dvoa: null }),
  );
  check(nullDensityViolations('dvoa-team', good).length === 0, 'a fully populated dvoa-team capture passes');
  check(nullDensityViolations('dvoa-team', good.map((r) => ({ ...r, last_year_rank: null }))).length === 0,
    'last_year_rank null on all 32 (FTN LAST YEAR = "x" in week 1) is NOT a violation');
  const v = nullDensityViolations('dvoa-team', loggedOut);
  check(v.length === 5, `the logged-out FTN shape BLOCKS on all five required columns (got ${v.length})`);
  check(v[0] === 'off_dvoa null on 32/32 rows', `message shape is "<col> null on N/M rows" (got "${v[0]}")`);
  check(nullDensityViolations('dvoa-team', good.map((r) => ({ ...r, off_dvoa: '' }))).length === 1,
    'an empty-string cell counts as null (captures arrive as strings)');
  // Boundary: 3/32 = 9.4% null passes, 4/32 = 12.5% blocks.
  const three = good.map((r, i) => (i < 3 ? { ...r, est_wins: null } : r));
  const four = good.map((r, i) => (i < 4 ? { ...r, est_wins: null } : r));
  check(nullDensityViolations('dvoa-team', three).length === 0, '3/32 null (9.4%) is under the 10% tolerance — passes');
  check(nullDensityViolations('dvoa-team', four).length === 1, '4/32 null (12.5%) is over — BLOCKS');
  // grades-player: position-dependent — a QB with only `pass` is a full row.
  const qb = { position: 'QB', off: 78.1, pass: 80.2, run: null, recv: null };
  const wr = { position: 'WR', off: 70.0, pass: null, run: null, recv: 72.5 };
  const blank = { position: 'QB', off: null, pass: null, run: null, recv: null };
  // The table has no defensive/kicking grade columns: these rows are all-null by construction.
  const defender = (position) => ({ position, off: null, pass: null, run: null, recv: null });
  check(nullDensityViolations('grades-player', [qb, wr, qb, wr]).length === 0, 'grades-player: one grade per row is enough (QB pass-only, WR recv-only)');
  const pv = nullDensityViolations('grades-player', Array.from({ length: 10 }, () => blank));
  check(pv.length === 1 && /no grade in any of off\/pass\/run\/recv on 10\/10 /.test(pv[0]),
    `grades-player: every grade null on every offensive row BLOCKS (got "${pv[0]}")`);
  check(nullDensityViolations('grades-player', [...Array.from({ length: 9 }, () => qb), blank]).length === 0,
    'grades-player: 1/10 gradeless offensive rows (10%) is at the tolerance — passes');
  // The 09-18 broad capture, in miniature: 4 offensive rows with grades, 8 defenders + 2 kickers without.
  const broad = [qb, wr, qb, wr, ...['DI', 'ED', 'CB', 'S', 'LB', 'DI', 'ED', 'CB'].map(defender), defender('K'), defender('K')];
  check(nullDensityViolations('grades-player', broad).length === 0,
    'grades-player: DI/ED/CB/S/LB/K rows with four nulls do NOT count against the gate (no such columns exist)');
  check(nullDensityViolations('grades-player', [...['DI', 'ED', 'CB'].map(defender), blank, blank]).length === 1,
    'grades-player: …but blanked OFFENSIVE rows among defenders still BLOCK (2/2 QB rows gradeless)');
  check(nullDensityViolations('grades-player', ['DI', 'ED', 'K'].map(defender)).length === 0,
    'grades-player: a capture with no offensive rows at all is not a density violation');
  check(nullDensityViolations('grades-player', [{ ...qb, position: 'qb' }, { ...blank, position: 'di' }]).length === 0,
    'grades-player: position match is case-insensitive');
  check(nullDensityViolations('power-ranks', [{ point_spread_rating: 3.2, sim_avg_wins: 9.1, make_playoffs_pct: 0.55 }]).length === 0,
    'power-ranks: populated row passes');
  check(nullDensityViolations('power-ranks', [{ point_spread_rating: 3.2, sim_avg_wins: null, make_playoffs_pct: null }]).length === 2,
    'power-ranks: two blank required columns → two violations');
  check(nullDensityViolations('grades-team', [{ overall: 80, off: null, def: 70 }]).length === 1, 'grades-team: off blank → one violation');
  check(nullDensityViolations('free-agency', [{ x: null }]).length === 0, 'a feed with no rule is never blocked');
  check(nullDensityViolations('dvoa-team', []).length === 0, 'zero rows is not a density violation (the empty case is the fetcher\'s to report)');
  if (failures.length) {
    console.error(`SELF-TEST FAIL (${failures.length}) — the null-density gate is blind:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`SELF-TEST PASS (${18} checks) — blank column blocks, full column passes, anyOf + tolerance boundary pinned.`);
  process.exit(0);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) selfTest();
  if (opts.allowSparse === '') {
    console.error('--allow-sparse needs a reason: --allow-sparse="why this sparse ingest is deliberate".');
    process.exit(2);
  }
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
      `${opts.allowStale ? ' [ALLOW-STALE]' : ''}${opts.allowSparse != null ? ` [ALLOW-SPARSE: ${opts.allowSparse}]` : ''}${opts.dry ? ' [DRY]' : ''}`,
  );
  const summary = [];
  for (const n of names) {
    summary.push(await runFeed(n, opts));
  }
  const written = summary.reduce((s, r) => s + (r.written || 0), 0);
  const blocked = summary.filter((r) => r.blocked).map((r) => r.name);
  // Run-level heartbeat (F8): record what this run SAW, even when feeds were
  // blocked — the ext-feeds-freshness workflow reads ext_capture_runs to tell
  // "run never happened" apart from "run happened". Dry runs write nothing and
  // record nothing. A failed heartbeat is loud and fails the run: an ingest
  // whose heartbeat didn't land looks exactly like a missed run to the monitor,
  // so pretending it succeeded would hide the very gap this exists to close.
  if (!opts.dry) {
    try {
      await recordExtCaptureRun({ summary, source: opts.source });
      console.log('heartbeat: ext_capture_runs row recorded.');
    } catch (err) {
      console.error(`heartbeat FAILED: ${err.message} — the freshness monitor will read this run as missing.`);
      process.exitCode = 1;
    }
  }
  console.log(`done — ${written} total rows ${opts.dry ? 'would be written' : 'written'} across ${names.length} feed(s).`);
  if (blocked.length) {
    // Non-zero so an unattended run can't report success while feeds were
    // refused. A missing staging file stays a soft skip (documented above);
    // stale-file, season-mismatch and null-density refusals fail the run.
    console.error(`BLOCKED: ${blocked.join(', ')} — nothing was written for these. See the lines above.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('ext-feeds ingest failed:', err.message);
  process.exit(1);
});
