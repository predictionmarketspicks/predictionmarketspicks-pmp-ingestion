#!/usr/bin/env node
// Auto-promote a shadow calibration map under the Loop v2 bar (site repo
// handoffs/EDGE_LOOP_V2_2026-11-09.md U8). Runs after each weekly fit in
// .github/workflows/btc-calibration-weekly.yml and metals-variance-clock-weekly.yml.
//
//   node scripts/auto-promote-calibration.js --commodity bitcoin --method platt_pooled
//   node scripts/auto-promote-calibration.js --commodity gold    --method variance_clock_v1 --promote
//   --dry-run   compute + print, write nothing (no Brier stamp, no promotion, no event)
//   --promote   when the decision is PROMOTE: active=true (shadow=false) on the newest fit, the
//               older active row of the same (commodity, method) deactivated, one
//               engine_rule_events row (event 'activated', actor 'calibration-fit'), a #bot-logs line.
//
// Decision (src/engine/calibration-promote.js): brier_cal < brier_raw on the two newest fits AND the
// settled picks re-scored under the calibrated probability clear the §2 PROMOTE bar AND (metals) ≥ 10
// trading days of prob_clock. The variance-clock fit writes no Brier, so for method variance_clock_v1
// this script scores the shadow first — commodity_edge_signals (final daily ladder) ⨝
// commodity_edge_settles where prob_clock is not null: Brier(prob_physical) vs Brier(prob_clock) vs
// Brier(kalshi_yes) — and stamps brier_raw / brier_cal / brier_market on the newest clock row when
// they are null, so "two consecutive fits" has two numbers to read next week.
//
// Re-score inputs are tool_picks ⨝ tool_settles (immutable at the crossing): predicted_prob and
// market_price_at_pick are P(YES) / the YES price on every commodity pick (the mint trigger). The
// calibrated P(YES) is applyCalibration(map, p) for a Platt map; for the clock it is the newest
// commodity_edge_intraday.prob_clock at or before picked_at on that strike (45-day retention — older
// picks are "unknown" and excluded, which the report says). Always prints the decision + numbers.

import 'dotenv/config';
import { getClient } from '../src/delivery/supabase.js';
import { postBotLog } from '../src/delivery/discord.js';
import { applyCalibration } from '../src/engine/calibration.js';
import { decidePromotion, rescorePicks, brier } from '../src/engine/calibration-promote.js';

const argValue = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
};
const COMMODITY = (argValue('commodity') || 'bitcoin').toLowerCase();
const METHOD = argValue('method') || (COMMODITY === 'bitcoin' ? 'platt_pooled' : 'variance_clock_v1');
const TOOL_SLUG = argValue('tool-slug') || `${COMMODITY}-edge`;
const DRY = process.argv.includes('--dry-run');
const PROMOTE = process.argv.includes('--promote');
const PAGE = 1000;

async function pageAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function readFits(sb) {
  const { data, error } = await sb.from('edge_calibration_maps').select('*')
    .eq('commodity', COMMODITY).eq('method', METHOD).order('fit_at', { ascending: false }).limit(6);
  if (error) throw new Error(`read fits: ${error.message}`);
  return data ?? [];
}

/** Settled picks for the tool, ordered on pick_id (unique) so the pages cannot overlap. */
async function readSettledPicks(sb) {
  const rows = await pageAll(() => sb.from('tool_picks')
    .select('pick_id, picked_at, market_id, predicted_side, predicted_prob, market_price_at_pick, regime_tags, tool_settles!inner(resolution, settled_at, net_pnl_cents, pnl_cents)')
    .eq('tool_slug', TOOL_SLUG).order('pick_id', { ascending: true }));
  const out = [];
  for (const r of rows) {
    const s = Array.isArray(r.tool_settles) ? r.tool_settles[0] : r.tool_settles;
    if (!s || (s.resolution !== 'won' && s.resolution !== 'lost')) continue;
    const p = Number(r.predicted_prob);
    const yes = Number(r.market_price_at_pick);
    if (!Number.isFinite(p) || p <= 0 || p >= 1 || !Number.isFinite(yes)) continue;
    out.push({
      pick_id: r.pick_id, picked_at: r.picked_at, settled_at: s.settled_at, market_id: r.market_id,
      side: r.predicted_side === 'NO' ? 'NO' : 'YES', p_yes_model: p, yes_price: yes,
      strike: r.regime_tags?.strike ?? null,
      won: s.resolution === 'won', net_c: Number(s.net_pnl_cents ?? s.pnl_cents ?? 0),
    });
  }
  return out;
}

/** Clock P(YES) at the pick: newest intraday snapshot on the strike at or before picked_at. */
async function attachClockProb(sb, picks) {
  for (const p of picks) {
    if (p.strike == null) { p.p_yes_cal = null; continue; }
    const { data, error } = await sb.from('commodity_edge_intraday').select('prob_clock')
      .eq('commodity', COMMODITY).eq('event_ticker', p.market_id).eq('strike', p.strike)
      .lte('snapshot_at', p.picked_at).not('prob_clock', 'is', null)
      .order('snapshot_at', { ascending: false }).limit(1);
    if (error) throw new Error(`intraday clock read: ${error.message}`);
    p.p_yes_cal = data?.[0]?.prob_clock == null ? null : Number(data[0].prob_clock);
  }
  return picks;
}

/** Shadow score for the clock (PART 3 shape): final ladder ⨝ settles where prob_clock exists. */
async function scoreClockShadow(sb) {
  const rows = await pageAll(() => sb.from('commodity_edge_signals')
    .select('id, event_ticker, strike, prob_physical, prob_clock, kalshi_yes, options_prob')
    .eq('commodity', COMMODITY).not('prob_clock', 'is', null).order('id', { ascending: true }));
  if (rows.length === 0) return { n: 0 };
  const settles = await pageAll(() => sb.from('commodity_edge_settles').select('event_ticker, strike, outcome')
    .eq('commodity', COMMODITY).in('outcome', ['yes', 'no']).order('event_ticker', { ascending: true }).order('strike', { ascending: true }));
  const key = (e, k) => `${e}|${Number(k)}`;
  const outcome = new Map(settles.map((s) => [key(s.event_ticker, s.strike), s.outcome === 'yes' ? 1 : 0]));
  const pm = []; const pc = []; const pk = []; const ys = [];
  for (const r of rows) {
    const y = outcome.get(key(r.event_ticker, r.strike));
    const model = r.prob_physical ?? r.options_prob;
    if (y == null || model == null || r.kalshi_yes == null) continue;
    pm.push(Number(model)); pc.push(Number(r.prob_clock)); pk.push(Number(r.kalshi_yes)); ys.push(y);
  }
  return { n: ys.length, brier_raw: brier(pm, ys), brier_cal: brier(pc, ys), brier_market: brier(pk, ys) };
}

async function clockTradingDays(sb) {
  const rows = await pageAll(() => sb.from('commodity_edge_intraday').select('snapshot_date')
    .eq('commodity', COMMODITY).not('prob_clock', 'is', null).order('snapshot_date', { ascending: true }));
  return new Set(rows.map((r) => r.snapshot_date)).size;
}

async function main() {
  const sb = getClient();
  const now = new Date();
  const fits = await readFits(sb);
  if (fits.length === 0) {
    console.log(JSON.stringify({ commodity: COMMODITY, method: METHOD, verdict: 'HOLD', reason: 'no fit rows' }, null, 2));
    return;
  }
  const newest = fits[0];
  if (newest.active) {
    console.log(JSON.stringify({ commodity: COMMODITY, method: METHOD, verdict: 'ALREADY_ACTIVE', map_id: newest.id }, null, 2));
    return;
  }

  const picks = await readSettledPicks(sb);
  let tradingDays = null;
  let shadow = null;
  if (METHOD === 'platt_pooled') {
    for (const p of picks) p.p_yes_cal = applyCalibration(newest, p.p_yes_model);
  } else if (METHOD === 'variance_clock_v1') {
    await attachClockProb(sb, picks);
    tradingDays = await clockTradingDays(sb);
    shadow = await scoreClockShadow(sb);
    // Stamp the shadow Brier on the newest clock row so next week's run has two fits to read.
    if (shadow.n > 0 && newest.brier_raw == null && newest.brier_cal == null) {
      if (!DRY) {
        const { error } = await sb.from('edge_calibration_maps')
          .update({ brier_raw: shadow.brier_raw, brier_cal: shadow.brier_cal, brier_market: shadow.brier_market })
          .eq('id', newest.id).is('brier_cal', null);
        if (error) throw new Error(`brier stamp: ${error.message}`);
      }
      Object.assign(newest, { brier_raw: shadow.brier_raw, brier_cal: shadow.brier_cal, brier_market: shadow.brier_market });
    }
  } else {
    throw new Error(`unknown method ${METHOD}`);
  }

  const rescored = rescorePicks(picks, { now });
  const decision = decidePromotion({ commodity: COMMODITY, fits, rescored, tradingDays });
  const report = {
    commodity: COMMODITY, method: METHOD, tool_slug: TOOL_SLUG, map_id: newest.id, fit_at: newest.fit_at,
    dry_run: DRY, promote_flag: PROMOTE,
    shadow_score: shadow && shadow.n > 0
      ? { n: shadow.n, brier_raw: +shadow.brier_raw.toFixed(4), brier_cal: +shadow.brier_cal.toFixed(4), brier_market: +shadow.brier_market.toFixed(4) }
      : shadow,
    ...decision,
  };
  console.log(JSON.stringify(report, null, 2));

  if (decision.verdict !== 'PROMOTE') {
    console.log('\nHOLD — the map stays in shadow. This is the bar holding, not a failure.');
    return;
  }
  if (!PROMOTE || DRY) {
    console.log('\nPROMOTE met — re-run with --promote (and without --dry-run) to activate.');
    return;
  }
  const { error: deErr } = await sb.from('edge_calibration_maps').update({ active: false })
    .eq('commodity', COMMODITY).eq('method', METHOD).eq('active', true);
  if (deErr) throw new Error(`deactivate previous: ${deErr.message}`);
  const { error: upErr } = await sb.from('edge_calibration_maps').update({ active: true, shadow: false }).eq('id', newest.id);
  if (upErr) throw new Error(`promote: ${upErr.message}`);
  const evidence = {
    map_id: newest.id, method: METHOD, fit_at: newest.fit_at, checks: decision.checks,
    brier: decision.brier, bar: decision.bar, trading_days: decision.trading_days, rescore_counts: decision.rescore_counts,
    shadow_score: report.shadow_score, as_of: now.toISOString(),
  };
  const { error: evErr } = await sb.from('engine_rule_events').insert({
    rule_id: null, scope: TOOL_SLUG, pot_key: `calibration:${METHOD}`, event: 'activated', actor: 'calibration-fit', evidence,
  });
  if (evErr) throw new Error(`engine_rule_events: ${evErr.message}`);
  console.log(`\npromoted edge_calibration_maps id=${newest.id} (${COMMODITY} ${METHOD}) to ACTIVE; engine_rule_events written.`);
  console.log(`REMINDER: a tool_changes row for ${TOOL_SLUG} (resets_record=false) + select public.sync_tool_track_from('${TOOL_SLUG}').`);
  try {
    await postBotLog(
      `🔁 ${COMMODITY} ${METHOD} calibration map #${newest.id} PROMOTED by calibration-fit — ` +
      `re-scored ${decision.bar.detail.n_all} picks, 30d ${(decision.bar.detail.net_30d_c / 100).toFixed(2)} / all ${(decision.bar.detail.net_all_c / 100).toFixed(2)} net, ` +
      `weeks ${decision.bar.detail.weeks.hits}/${decision.bar.detail.weeks.considered}, two fits beat raw Brier.`,
    );
  } catch (err) {
    console.warn(`[bot-logs] post failed: ${err?.message || err}`);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
