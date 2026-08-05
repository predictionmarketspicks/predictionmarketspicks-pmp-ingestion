#!/usr/bin/env node
// Promotion gate for a bitcoin calibration map.
// handoffs/BITCOIN_EDGE_V21_CALIBRATED_RELAUNCH_2026-08-05.md §4.3
//
// Usage:
//   node scripts/promote-btc-calibration.js              # evaluate + report only
//   node scripts/promote-btc-calibration.js --promote    # flip active=true if it passes
//
// GATE (all must hold, on OUT-OF-SAMPLE data only):
//   1. >= MIN_EVENTS distinct settled events in the evaluation window
//   2. brier_cal <  brier_raw
//   3. brier_cal <= brier_market + 0.01
//
// The evaluation window is picks made AFTER the map's fit window closed —
// never the fit window itself. A Platt map is fitted to beat brier_raw in
// sample, so an in-sample comparison always passes and proves nothing. This
// script is the only thing allowed to set active=true.
//
// If the gate cannot be passed after several weeks, that IS the kill-criteria
// signal in §9: calibration that cannot match the book's own Brier means there
// is no directional edge here to rescue.

import { getClient } from '../src/delivery/supabase.js';
import { applyCalibration } from '../src/engine/calibration.js';

const TOOL_SLUG = 'bitcoin-edge';
const COMMODITY = 'bitcoin';
const MODEL_VERSION = 'v2_physical';
const MIN_EVENTS = 10;
const MARKET_TOLERANCE = 0.01;

function brier(ps, ys) {
  let s = 0;
  for (let i = 0; i < ps.length; i += 1) s += (ps[i] - ys[i]) ** 2;
  return s / ps.length;
}

async function main() {
  const doPromote = process.argv.includes('--promote');
  const sb = getClient();

  const { data: maps, error: mapErr } = await sb
    .from('edge_calibration_maps')
    .select('*')
    .eq('commodity', COMMODITY)
    .order('fit_at', { ascending: false })
    .limit(1);
  if (mapErr) throw new Error(`read maps: ${mapErr.message}`);
  const map = maps?.[0];
  if (!map) {
    console.error('no calibration map found — run fit-btc-calibration.js first');
    process.exit(1);
  }
  if (map.active) {
    console.log(`map id=${map.id} is already active; nothing to do`);
    return;
  }

  // Out-of-sample window: strictly after the fit window closed.
  const cutoff = map.fit_window_end; // date
  const { data, error } = await sb
    .from('tool_picks')
    .select(
      'pick_id, picked_at, market_id, predicted_side, predicted_prob, market_price_at_pick, regime_tags, tool_settles!inner(resolution)',
    )
    .eq('tool_slug', TOOL_SLUG)
    .gt('picked_at', `${cutoff}T23:59:59Z`)
    .order('picked_at', { ascending: true });
  if (error) throw new Error(`read eval picks: ${error.message}`);

  const pModel = [];
  const pCal = [];
  const pMarket = [];
  const y = [];
  const events = new Set();

  for (const r of data ?? []) {
    if (r.regime_tags?.model_version !== MODEL_VERSION) continue;
    if (r.predicted_side !== 'YES') continue;
    const res = r.tool_settles?.resolution ?? r.tool_settles?.[0]?.resolution;
    if (res !== 'won' && res !== 'lost') continue;
    const pm = Number(r.predicted_prob);
    const mk = Number(r.market_price_at_pick);
    if (!Number.isFinite(pm) || pm <= 0 || pm >= 1 || !Number.isFinite(mk)) continue;
    const cal = applyCalibration(map, pm);
    if (cal == null) continue;
    pModel.push(pm);
    pCal.push(cal);
    pMarket.push(mk);
    y.push(res === 'won' ? 1 : 0);
    events.add(r.market_id);
  }

  const nEvents = events.size;
  const result = {
    map_id: map.id,
    fit_window_end: cutoff,
    eval_n_samples: pModel.length,
    eval_n_events: nEvents,
  };

  if (pModel.length === 0) {
    console.log(
      JSON.stringify({ ...result, verdict: 'INSUFFICIENT_DATA', reason: 'no settled out-of-sample picks yet' }, null, 2),
    );
    return;
  }

  const bRaw = brier(pModel, y);
  const bCal = brier(pCal, y);
  const bMkt = brier(pMarket, y);
  const checks = {
    enough_events: nEvents >= MIN_EVENTS,
    beats_raw: bCal < bRaw,
    matches_market: bCal <= bMkt + MARKET_TOLERANCE,
  };
  const pass = Object.values(checks).every(Boolean);

  console.log(
    JSON.stringify(
      {
        ...result,
        realized: Number((y.reduce((s, v) => s + v, 0) / y.length).toFixed(4)),
        brier_raw: Number(bRaw.toFixed(4)),
        brier_cal: Number(bCal.toFixed(4)),
        brier_market: Number(bMkt.toFixed(4)),
        checks,
        verdict: pass ? 'PASS' : 'HOLD',
      },
      null,
      2,
    ),
  );

  if (!pass) {
    console.log('\ngate not met — map stays in shadow. This is the designed outcome, not a failure.');
    return;
  }
  if (!doPromote) {
    console.log('\ngate MET — re-run with --promote to set active=true');
    return;
  }

  // Exactly one active map per commodity.
  const { error: deErr } = await sb
    .from('edge_calibration_maps')
    .update({ active: false })
    .eq('commodity', COMMODITY)
    .eq('active', true);
  if (deErr) throw new Error(`deactivate previous: ${deErr.message}`);

  const { error: upErr } = await sb
    .from('edge_calibration_maps')
    .update({ active: true, shadow: false })
    .eq('id', map.id);
  if (upErr) throw new Error(`promote: ${upErr.message}`);

  console.log(`\npromoted map id=${map.id} to ACTIVE.`);
  console.log('The engine picks it up within the hour (or on next boot).');
  console.log('REMINDER: write a tool_changes row for bitcoin-edge (resets_record=false).');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
