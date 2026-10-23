#!/usr/bin/env node
// Fit the intraday variance clock for gold or silver from metals_spot_marks and
// write it as a SHADOW row in edge_calibration_maps (method 'variance_clock_v1').
// Site repo: handoffs/METALS_EDGE_VARIANCE_CLOCK_2026-10-23.md PART 2.1 / 2.4.
//
// Usage:
//   node scripts/fit-variance-clock.js --commodity gold            # fit + write shadow row + #bot-logs line
//   node scripts/fit-variance-clock.js --commodity silver --dry-run # fit + print, write nothing
//
// Never activates anything. Promotion (active=true, model_version bump, tool_changes,
// sync_tool_track_from) is PART 3 — manual, Benny's go, after 10 trading days of shadow.
// The engine reads the newest shadow clock for prob_clock (shadow only): decisions keep
// reading prob_physical until promotion.

import 'dotenv/config';
import { getClient } from '../src/delivery/supabase.js';
import { postBotLog } from '../src/delivery/discord.js';
import { CLOCK_METHOD, fitIntradayProfile, returnsFromMarks, FULL_WINDOW_MS } from '../src/engine/variance-clock.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const ci = args.indexOf('--commodity');
const COMMODITY = ci >= 0 ? args[ci + 1] : null;
if (COMMODITY !== 'gold' && COMMODITY !== 'silver') {
  console.error('usage: node scripts/fit-variance-clock.js --commodity gold|silver [--dry-run]');
  process.exit(2);
}

async function readMarks(sb, sinceIso) {
  // Ordered + .range() paged: PostgREST caps every response at 1,000 rows.
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb
      .from('metals_spot_marks')
      .select('mark_at, spot')
      .eq('commodity', COMMODITY)
      .gt('spot', 0)
      .gte('mark_at', sinceIso)
      .order('mark_at', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw new Error(`metals_spot_marks read: ${error.message}`);
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

async function main() {
  const sb = getClient();
  // One day of slack past the 8-week window so the window edge has its preceding mark.
  const since = new Date(Date.now() - FULL_WINDOW_MS - 24 * 3600 * 1000).toISOString();
  const marks = await readMarks(sb, since);
  const returns = returnsFromMarks(marks);
  const knots = fitIntradayProfile(returns, { commodity: COMMODITY });
  const w = knots.hours_et;

  const fmt = (x) => x.toFixed(2);
  const line =
    `${COMMODITY} variance clock (shadow) — n=${knots.n_returns} returns, ${knots.n_trading_days} days, ` +
    `λ=${knots.lambda.toFixed(3)} (${knots.window_from.slice(0, 10)}→${knots.window_to.slice(0, 10)})\n` +
    `ET 0-23: ${w.map(fmt).join(' ')}`;
  console.log(JSON.stringify({ commodity: COMMODITY, marks: marks.length, ...knots }, null, 2));
  console.log(`\n${line}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written');
    return;
  }

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
      shadow: true,
      active: false,
      notes:
        'Intraday variance clock: 24 ET-hour weights w_h = sigma_h^2 / mean over trading hours, ' +
        'from 15-min metals_spot_marks returns; closed hours (Sat, Sun < 18:00, 17:00 break) weigh 0. ' +
        `Shrunk toward flat with lambda = H/(H+240) until 8 weeks exist (lambda=${knots.lambda}). ` +
        'NOT a map on p — consumed at the sigma*sqrt(T) step; applyCalibration() returns null for it. ' +
        'SHADOW: writes prob_clock only. Promotion = METALS_EDGE_VARIANCE_CLOCK_2026-10-23 PART 3.',
    })
    .select('id')
    .single();
  if (error) throw new Error(`write clock: ${error.message}`);
  console.log(`\nwrote edge_calibration_maps id=${written.id} (${CLOCK_METHOD}, shadow, inactive)`);
  try {
    await postBotLog(`${line}\nedge_calibration_maps #${written.id}`);
  } catch (err) {
    console.warn(`[bot-logs] post failed: ${err?.message || err}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
