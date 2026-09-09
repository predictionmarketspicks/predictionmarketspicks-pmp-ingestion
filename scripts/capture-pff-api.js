#!/usr/bin/env node
// Capture PFF grades via the official PFF Developer API (api.pff.com) instead
// of a Claude-in-Chrome scrape of premium.pff.com. Writes the SAME staging
// JSON shape ext-shared.js already reads — data/ext-staging/<feed>.json — so
// scripts/ingest-ext-feeds.js and the normalizers downstream are untouched
// (see the "SWAPPABLE FETCH LAYER" note atop src/feeds/ext-shared.js).
//
//   node scripts/capture-pff-api.js [--season=2026] [--week=N] [--feeds=grades-team,grades-player]
//
// Requires PFF_API_KEY in .env (a PFF Pro account API key from
// pff.com/account/api-keys). Never printed, never logged.
//
// COVERAGE — only two of the five ext-feeds live in this API:
//   grades-team    <- /v1/teams/overview                       (this script)
//   grades-player  <- /v1/facet/{passing,rushing,receiving,field_goal}/summary
//                      + /v2/nfl/teams/{slug}/roster for bio    (this script)
//   power-ranks    <- pff.com/betting/nfl-power-rankings — a different PFF
//                      product (sim wins, playoff odds); NOT in the Developer
//                      API's 70 operations. Still needs the Chrome capture.
//   free-agency    <- pff.com/nfl/free-agency. Also not in the Developer API.
//                      Still needs the Chrome capture.
//   dvoa-team      <- FTN Fantasy, a different vendor entirely. This key does
//                      nothing for it. Still needs the Chrome capture.
//
// ⛔ SEASON AGGREGATES ARE PRESEASON-INCLUSIVE UNLESS YOU PASS `week=1,2,…,N`.
// Measured 2026-09-09, season 2025 ARZ: unfiltered = 5-15 over 20 games / 402 PF
// / team grade 68.0; `week=1..18` = 3-14 over 17 games / 355 PF / 67.2. Before
// week 1 is played the unfiltered call is preseason and NOTHING else — season
// 2026 read records like "3-0" and "1-3" on 2026-09-09. This script therefore
// resolves the last fully-graded regular-season week from /v1/games (`has_stats`)
// and scopes every aggregate to that union; at week 0 it writes nothing and
// exits 3. `weeks[]=`, `min_week`, `season_type` are silently IGNORED by the API
// and return the contaminated number, so the union form is the only safe one.
//
// The week filter reaches the REGULAR SEASON ONLY in this account — weeks 19-22
// carry no stats in any season tested, and no team exceeds 17 games over a 1..22
// union. `week_scope` stays "REGPO" because that is the established upsert key
// (season,week_scope,team) and both consensus readers select on season alone —
// a second "REG" row set would double every team. In-season the two are the
// same rows; postseason is simply not addressable through this API.
//
// KNOWN GAPS vs. the Chrome-scraped shape (documented, not fabricated — see
// ext-parse.js's "never guess" rule):
//   - war / war_rank: not present anywhere in the PFF Developer API schema.
//     PFF's WAR appears to be a website-only metric with no API endpoint.
//     Left null on every grades-player row.
//   - college / draft_round / draft_pick / forty (40-yd): only obtainable via
//     a per-player /v1/players?id=N lookup, which is one API call per player
//     (400+ for the full skill-position set) against a shared 100 reads/min
//     account budget. Not fetched by default — left null. height / weight /
//     age DO come cheaply from the 32-call team-roster batch and are filled.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pffGet, sleep, packedHeightToFeetInches, ageFromBirthDate, lastGradedRegWeek, regWeekUnion } from '../src/lib/pff-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGING_DIR = path.resolve(__dirname, '..', 'data', 'ext-staging');

function parseArgs(argv) {
  const opts = { season: undefined, week: undefined, feeds: ['grades-team', 'grades-player', 'roster-status'] };
  for (const a of argv) {
    if (a.startsWith('--season=')) opts.season = Number(a.slice('--season='.length));
    else if (a.startsWith('--week=')) opts.week = Number(a.slice('--week='.length));
    else if (a.startsWith('--feeds=')) opts.feeds = a.slice('--feeds='.length).split(',').map((s) => s.trim());
  }
  return opts;
}

function writeStaging(feed, season, rows) {
  const file = path.join(STAGING_DIR, `${feed}.json`);
  fs.writeFileSync(file, JSON.stringify({ season, rows }, null, 2) + '\n');
  console.log(`  wrote ${file} (${rows.length} rows)`);
}

async function captureGradesTeam(season, throughWeek) {
  const weeks = regWeekUnion(throughWeek);
  console.log(`[grades-team] GET /v1/teams/overview league=nfl season=${season} week=1..${throughWeek}`);
  const body = await pffGet(`/v1/teams/overview?league=nfl&season=${season}&week=${weeks}`);
  const teamRows = body.team_overview || [];
  const rows = teamRows.map((r) => ({
    team: r.abbreviation,
    week_scope: 'REGPO',
    pf: r.points_scored ?? null,
    pa: r.points_allowed ?? null,
    record: r.wins != null ? `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}` : null,
    overall: r.grades_overall ?? null,
    off: r.grades_offense ?? null,
    pass: r.grades_pass ?? null,
    pblk: r.grades_pass_block ?? null,
    recv: r.grades_pass_route ?? null,
    run: r.grades_run ?? null,
    rblk: r.grades_run_block ?? null,
    def: r.grades_defense ?? null,
    rdef: r.grades_run_defense ?? null,
    tack: r.grades_tackle ?? null,
    prsh: r.grades_pass_rush_defense ?? null,
    cov: r.grades_coverage_defense ?? null,
    spec: r.grades_misc_st ?? null,
  }));
  writeStaging('grades-team', season, rows);
  return rows;
}

// Facet reports to pull for the skill-position set (mirrors the "By Position"
// premium-stats pages the Chrome capture used), each restricted to the
// position(s) that facet is meaningful for — the facet itself returns every
// position that recorded a snap in that phase (e.g. rushing includes OL who
// picked up a fumble), which is not what we want.
const FACETS = [
  { facet: 'passing', positions: ['QB'] },
  { facet: 'rushing', positions: ['HB', 'RB'] },
  { facet: 'receiving', positions: ['WR', 'TE'] },
  { facet: 'field_goal', positions: ['K'] },
];

const GRADE_KEYS = new Set([
  'grades_offense', 'grades_pass', 'grades_run', 'grades_pass_route',
  'grades_pass_block', 'grades_run_block',
]);
const IDENTITY_KEYS = new Set([
  'player', 'player_id', 'team', 'team_name', 'position', 'jersey_number', 'draft_season',
]);
const SNAP_KEY_PATTERN = /snap/i;

async function fetchAllTeamSlugs(season) {
  const body = await pffGet(`/v2/nfl/teams?season=${season}`);
  return (body.rows || []).map((r) => ({ slug: r.slug, abbreviation: r.abbreviation }));
}

// ONE pass over the 32 team rosters, feeding BOTH consumers.
//
// ⛔ THE ROSTER ENDPOINT IGNORES `season` — it serves TODAY'S roster whatever you
// pass. Measured 2026-09-09: the rows returned for season=2025 contain 2026
// rookies (Carson Beck, Jalon Daniels, Haynes King). So the crosswalk must match
// against the CURRENT season's nflverse roster, not the season in the URL —
// matching 2025 names scored 84.1% on prop-eligible players, matching 2026
// scored 99.6%. Getting this backwards degrades the join silently, all season.
//
// The roster endpoint carries bio (height/weight/birthDate) AND availability
// (status/depthOrder/snapPct). Fetching it twice would double 32 calls against a
// 100-reads/min budget that is shared ACROSS THE WHOLE ACCOUNT, not per key
// (src/lib/pff-api.js header), so the two feeds share one pass.
//
// Returns { bio, roster } — `bio` keyed by playerId for the grades-player join,
// `roster` a flat array of availability rows for the roster-status staging file.
// 32 calls total, paced at ~4/sec.
async function fetchRosters(season, teams) {
  const bio = new Map();
  const roster = [];
  for (const t of teams) {
    try {
      const body = await pffGet(`/v2/nfl/teams/${t.slug}/roster?season=${season}`);
      for (const row of body.rows || []) {
        bio.set(row.playerId, {
          height: packedHeightToFeetInches(row.height),
          weight: row.weight ?? null,
          age: ageFromBirthDate(row.birthDate),
          eligibilityYear: row.eligibilityYear ?? null,
        });
        roster.push({
          // The vendor id, persisted deliberately — it is the join key the
          // crosswalk resolves to a gsis id once, instead of name-matching on
          // every run. First vendor id kept in an ext_* table; see the
          // handoff for why that is the point.
          pff_player_id: row.playerId != null ? String(row.playerId) : null,
          name: row.name ?? null,
          team: t.abbreviation ?? null,
          position: row.position ?? null,
          alignment: row.alignment ?? null,
          unit: row.unit ?? null,
          // ⚠️ depth ORDER (1,2,3…), not the nflverse "named starter" mark.
          depth_order: row.depthOrder ?? null,
          // active | out | questionable | … — normalised downstream, not here.
          // ext-parse's "never guess" rule: pass the vendor's own word through.
          status: row.status ?? null,
          snap_pct: row.snapPct ?? null,
          snap_counts: row.snapCounts ?? null,
          jersey: row.jersey ?? null,
        });
      }
    } catch (err) {
      console.warn(`  [roster] fetch failed for ${t.slug}: ${err.message}`);
    }
    await sleep(250);
  }
  return { bio, roster };
}

async function captureGradesPlayer(season, week, bioByPlayerId) {
  const weeks = regWeekUnion(week);
  const allRows = [];
  const seen = new Set();
  for (const { facet, positions } of FACETS) {
    console.log(`[grades-player] GET /v1/facet/${facet}/summary league=nfl season=${season} week=1..${week}`);
    const body = await pffGet(`/v1/facet/${facet}/summary?league=nfl&season=${season}&week=${weeks}`);
    const key = Object.keys(body).find((k) => k !== 'restricted');
    const rows = body[key] || [];
    for (const r of rows) {
      if (!positions.includes(r.position)) continue;
      const dedupeKey = `${r.player_id}|${r.position}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const bio = bioByPlayerId.get(r.player_id) || {};
      const extra = {};
      for (const [k, v] of Object.entries(r)) {
        if (IDENTITY_KEYS.has(k) || GRADE_KEYS.has(k) || SNAP_KEY_PATTERN.test(k)) continue;
        extra[k] = v;
      }
      const snaps = {};
      for (const [k, v] of Object.entries(r)) {
        if (SNAP_KEY_PATTERN.test(k)) snaps[k] = v;
      }
      allRows.push({
        name: r.player,
        team: r.team || r.team_name,
        position: r.position,
        week,
        jersey: r.jersey_number != null ? Number(String(r.jersey_number).replace(/^0+(?=\d)/, '')) : null,
        age: bio.age ?? null,
        college: null, // not available without a per-player /v1/players call — see header
        draft_year: r.draft_season ?? null,
        draft_round: null, // ditto
        draft_pick: null, // ditto
        height: bio.height ?? null,
        weight: bio.weight ?? null,
        forty: null, // ditto (PFF calls it "speed" on the per-player endpoint only)
        rs: null, // rookie flag not exposed by this API; leave unknown rather than guess
        off: r.grades_offense ?? null,
        pass: r.grades_pass ?? null,
        run: r.grades_run ?? null,
        recv: r.grades_pass_route ?? null,
        pblk: r.grades_pass_block ?? null,
        rblk: r.grades_run_block ?? null,
        war: null, // not present anywhere in the PFF Developer API schema
        war_rank: null,
        snaps,
        extra,
      });
    }
  }
  writeStaging('grades-player', season, allRows);
  return allRows;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.season) {
    console.error('--season=YYYY is required');
    process.exit(2);
  }
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  console.log(`whoami check…`);
  const who = await pffGet('/v1/auth/whoami');
  console.log(`  entitled=${who.entitled} tier=${who.tier} credential=${who.credential}`);
  if (!who.entitled) {
    console.error('PFF account is not entitled (needs PFF Pro). Aborting.');
    process.exit(2);
  }

  // Resolve the regular-season week FIRST — every aggregate below is scoped to
  // `week=1..N` because the unfiltered call is preseason-inclusive (see the
  // header comment in src/lib/pff-api.js). N=0 means no regular-season game has
  // been graded yet, and there is then nothing this script can honestly write:
  // the only numbers the API would hand back are preseason, and both staging
  // files are keyed/consumed as regular-season. Refuse rather than publish them.
  const week = opts.week ?? (await lastGradedRegWeek(opts.season));
  console.log(`[week] regular-season week=${week} (${opts.week != null ? 'explicit --week' : 'derived from /v1/games has_stats'})`);
  // ⛔ THE WEEK-0 REFUSAL IS A *GRADES* GUARD, NOT A BLANKET ONE. teams/overview
  // and the facets aggregate a season, so before week 1 they return preseason
  // and must not be written as REGPO. A roster snapshot has no such problem —
  // today's roster is today's roster, and the week before kickoff is exactly
  // when its injury designations matter most. So refuse only if a GRADES feed
  // was asked for.
  const gradesRequested =
    opts.feeds.includes('grades-team') || opts.feeds.includes('grades-player');
  if (week < 1 && gradesRequested) {
    console.error(
      `No regular-season week of season ${opts.season} is graded yet — the only data ` +
      `/v1/teams/overview and /v1/facet/*/summary would return is PRESEASON, which is ` +
      `not what ext_team_grades(week_scope=REGPO) / ext_player_grades hold. Nothing written.`,
    );
    process.exit(3);
  }

  if (opts.feeds.includes('grades-team')) {
    await captureGradesTeam(opts.season, week);
  }

  // ONE roster pass serves both grades-player (bio) and roster-status
  // (availability). Only fetch it if at least one of them was requested.
  const wantsPlayer = opts.feeds.includes('grades-player');
  const wantsRoster = opts.feeds.includes('roster-status');
  if (wantsPlayer || wantsRoster) {
    console.log('[roster] fetching 32 team rosters (paced, shared by grades-player + roster-status)…');
    const teams = await fetchAllTeamSlugs(opts.season);
    const { bio, roster } = await fetchRosters(opts.season, teams);

    if (wantsRoster) {
      // ⚠️ A roster/status feed is WEEK-scoped even though the endpoint is not:
      // PFF serves today's roster, so the row is only meaningful stamped with
      // the week it was captured for. Same reasoning as grades-player.
      const rows = roster
        .filter((r) => r.pff_player_id && r.name)
        .map((r) => ({ ...r, week }));
      writeStaging('roster-status', opts.season, rows);
      const byStatus = {};
      for (const r of rows) {
        const k = String(r.status ?? 'unknown').toLowerCase();
        byStatus[k] = (byStatus[k] || 0) + 1;
      }
      console.log(`  [roster-status] status mix: ${JSON.stringify(byStatus)}`);
    }

    if (wantsPlayer) await captureGradesPlayer(opts.season, week, bio);
  }

  console.log('done.');
}

main().catch((err) => {
  console.error('capture-pff-api failed:', err.message);
  process.exit(1);
});
