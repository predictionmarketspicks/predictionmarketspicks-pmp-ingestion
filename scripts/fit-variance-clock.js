#!/usr/bin/env node
// Fit the intraday variance clock for gold, silver or oil and write it to
// edge_calibration_maps (method 'variance_clock_v1').
// Site repo: handoffs/METALS_EDGE_VARIANCE_CLOCK_2026-10-23.md PART 2.1 / 2.4 (metals),
//            handoffs/OIL_EDGE_DEEP_DIVE_2026-11-09.md §4 U2 (oil).
//
// Usage:
//   node scripts/fit-variance-clock.js --commodity gold            # fit + write SHADOW row + #bot-logs line
//   node scripts/fit-variance-clock.js --commodity silver --dry-run # fit + print, write nothing
//   node scripts/fit-variance-clock.js --commodity oil --live       # fit + write an ACTIVE row (oil, U2)
//
// Metals: SHADOW by default — the row writes prob_clock only; promotion is the Loop v2
// auto-promote's decision (scripts/auto-promote-calibration.js). Oil: `--live` writes
// active=true/shadow=false because the oil engine runs clockGoverns (commodities.js) and
// prices prob_physical on the ACTIVE clock — Benny's no-shadow direction, 2026-11-09.
// Without --live oil too writes a shadow row (prob_clock only). --live is refused for
// the metals: their promotion has its own bar.
//
// Returns source per commodity:
//   gold / silver   metals_spot_marks (mark_at, spot) — the 15-min settle-boundary marks
//   oil             settlement_spot_captures where commodity='wti' and kind='settle'
//                   (window_close_at, our_spot): the 15-min WTI proxy read at each
//                   KXWTI15M close, until oil marks exist in metals_spot_marks. The
//                   ICE/CME WTI week is the metals_globex calendar (Sun 18:00 → Fri
//                   17:00 ET, 17–18 break), so the same fit applies unchanged.

import 'dotenv/config';
import { getClient } from '../src/delivery/supabase.js';
import { postBotLog } from '../src/delivery/discord.js';
import { CLOCK_METHOD, fitIntradayProfile, returnsFromMarks, FULL_WINDOW_MS } from '../src/engine/variance-clock.js';

const METALS = new Set(['gold', 'silver']);

/** Pure: argv → { commodity, dryRun, live } or { error } (no process.exit at import time). */
export function parseClockArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const live = args.includes('--live');
  const ci = args.indexOf('--commodity');
  const commodity = ci >= 0 ? args[ci + 1] : null;
  if (commodity !== 'gold' && commodity !== 'silver' && commodity !== 'oil') {
    return { error: 'usage: node scripts/fit-variance-clock.js --commodity gold|silver|oil [--dry-run] [--live (oil only)]' };
  }
  if (live && METALS.has(commodity)) {
    return { error: `--live is oil-only: the ${commodity} clock is promoted by scripts/auto-promote-calibration.js under its own bar` };
  }
  return { commodity, dryRun, live };
}

const parsed = parseClockArgs(process.argv);
const COMMODITY = parsed.commodity ?? null;
const dryRun = parsed.dryRun === true;
const live = parsed.live === true;

/** Pure: settlement_spot_captures rows → the { mark_at, spot } shape returnsFromMarks reads. */
export function marksFromWtiCaptures(rows) {
  return (rows ?? [])
    .filter((r) => r && r.window_close_at && Number(r.our_spot) > 0)
    .map((r) => ({ mark_at: r.window_close_at, spot: Number(r.our_spot) }));
}

// Ordered + .range() paged: PostgREST caps every response at 1,000 rows.
async function pageAll(build) {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await build().range(from, from + size - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < size) break;
  }
  return out;
}

async function readMarks(sb, sinceIso) {
  if (COMMODITY === 'oil') {
    const rows = await pageAll(() => sb
      .from('settlement_spot_captures')
      .select('window_close_at, our_spot')
      .eq('commodity', 'wti')
      .eq('kind', 'settle')
      .gt('our_spot', 0)
      .gte('window_close_at', sinceIso)
      .order('window_close_at', { ascending: true }));
    return marksFromWtiCaptures(rows);
  }
  return pageAll(() => sb
    .from('metals_spot_marks')
    .select('mark_at, spot')
    .eq('commodity', COMMODITY)
    .gt('spot', 0)
    .gte('mark_at', sinceIso)
    .order('mark_at', { ascending: true }));
}

async function main() {
  const sb = getClient();
  // One day of slack past the 8-week window so the window edge has its preceding mark.
  const since = new Date(Date.now() - FULL_WINDOW_MS - 24 * 3600 * 1000).toISOString();
  const marks = await readMarks(sb, since);
  const returns = returnsFromMarks(marks);
  const knots = fitIntradayProfile(returns, { commodity: COMMODITY });
  const w = knots.hours_et;

  const mode = live ? 'LIVE' : 'shadow';
  const fmt = (x) => x.toFixed(2);
  const line =
    `${COMMODITY} variance clock (${mode}) — n=${knots.n_returns} returns, ${knots.n_trading_days} days, ` +
    `λ=${knots.lambda.toFixed(3)} (${knots.window_from.slice(0, 10)}→${knots.window_to.slice(0, 10)})\n` +
    `ET 0-23: ${w.map(fmt).join(' ')}`;
  console.log(JSON.stringify({ commodity: COMMODITY, marks: marks.length, ...knots }, null, 2));
  console.log(`\n${line}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written');
    return;
  }

  const source = COMMODITY === 'oil'
    ? 'from 15-min settlement_spot_captures (wti, settle) returns'
    : 'from 15-min metals_spot_marks returns';
  const governance = live
    ? 'LIVE (active=true): the oil engine runs clockGoverns and prices prob_physical on this row; ' +
      'prob_clock is written beside it. OIL_EDGE_DEEP_DIVE_2026-11-09 U2, no shadow (Benny).'
    : 'SHADOW: writes prob_clock only. Promotion = scripts/auto-promote-calibration.js (Loop v2 U8).';
  const { data: written, error } = await sb
    .from('edge_calibration_maps')
    .insert({
      commodity: COMMODITY,
      method: CLOCK_METHOD,
      knots,
      n_samples: knots.n_returns,
      n_events: knots.n_trading_days,
      shrink_lambda: knots.lambda,
      fit_window_start: knots.window_from.slice(0, 10),
      fit_window_end: knots.window_to.slice(0, 10),
      shadow: !live,
      active: live,
      notes:
        `Intraday variance clock: 24 ET-hour weights w_h = sigma_h^2 / mean over trading hours, ${source}; ` +
        'closed hours (Sat, Sun < 18:00, 17:00 break) weigh 0. ' +
        `Shrunk toward flat with lambda = H/(H+240) until 8 weeks exist (lambda=${knots.lambda}). ` +
        'NOT a map on p — consumed at the sigma*sqrt(T) step; applyCalibration() returns null for it. ' +
        governance,
    })
    .select('id')
    .single();
  if (error) throw new Error(`write clock: ${error.message}`);
  console.log(`\nwrote edge_calibration_maps id=${written.id} (${CLOCK_METHOD}, ${live ? 'ACTIVE' : 'shadow, inactive'})`);
  try {
    await postBotLog(`${line}\nedge_calibration_maps #${written.id}`);
  } catch (err) {
    console.warn(`[bot-logs] post failed: ${err?.message || err}`);
  }
}

// Only run when invoked directly (the pure helpers above are imported by tests).
if (process.argv[1] && /fit-variance-clock\.js$/.test(process.argv[1])) {
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
