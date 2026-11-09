// Model-level self-improvement — the calibration-map promotion decision, as pure functions.
// Site repo handoffs/EDGE_LOOP_V2_2026-11-09.md §2 ("The bar") + U8.
//
// A shadow map in edge_calibration_maps (bitcoin `platt_pooled`, gold/silver `variance_clock_v1`)
// auto-promotes — active=true, an engine_rule_events row with actor 'calibration-fit' — when ALL hold:
//
//   1. brier_cal < brier_raw on the two newest weekly fits of (commodity, method), both stamped;
//   2. the settled picks RE-SCORED under the calibrated probability — the ones that would still be
//      picks (calibrated side edge ≥ the MODERATE floor) — clear the §2 PROMOTE bar on their own P/L:
//        n_all ≥ 50 · net_30d > 0 ∧ net_all > 0 · net > 0 in ≥ 4 of the last 6 ISO weeks traded
//        (≥ 3 of 4 when younger than 6 weeks; < 4 weeks never passes) · wilson_lb(win%, n_all) >
//        breakeven(mean entry) · no single ET day > 50 % of net_30d;
//   3. metals only: ≥ 10 trading days of prob_clock data (the shadow's own clock).
//
// One bad week never flips a pot (Benny 2026-10-23). The constants are the rule-miner's
// (supabase/functions/rule-miner/bar.ts) — kept in step by hand, both files name each other.
// No I/O here: scripts/auto-promote-calibration.js reads, calls decidePromotion(), writes.

import { FUSED_TIER_CUTOFFS } from './thresholds.js';

export const PROMOTE_MIN_N_ALL = 50;
export const WEEKS_WINDOW = 6;
export const WEEKS_NEED = 4;
export const YOUNG_WINDOW = 4;
export const YOUNG_NEED = 3;
export const CONCENTRATION_MAX_SHARE = 0.5;
export const CONSECUTIVE_FITS = 2;
export const METALS_MIN_TRADING_DAYS = 10;
export const RESCORE_MIN_EDGE = FUSED_TIER_CUTOFFS.MODERATE; // a re-scored pick survives at ≥ 7pp
export const DAY_MS = 86_400_000;

const num = (x) => {
  if (x == null || x === '') return 0;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000);

/** Wilson lower bound of a win rate (z 1.96) — the miner's stats.ts formula. */
export function wilsonLowerBound(wins, n, z = 1.96) {
  if (!(n > 0)) return 0;
  const phat = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return (center - margin) / denom;
}

/** ISO week key 'IYYY-IW' (UTC calendar, like the miner). */
export function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-${String(wk).padStart(2, '0')}`;
}

/** ET calendar day of an instant ('YYYY-MM-DD'). */
export function etDay(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Weeks test: net > 0 in ≥ 4 of the last 6 traded ISO weeks (≥ 3 of 4 young; < 4 weeks never). */
export function weeksTest(weeks) {
  const w = [...(weeks ?? [])].sort((a, b) => (a.wk < b.wk ? 1 : a.wk > b.wk ? -1 : 0));
  const pos = (x) => num(x.net_c) > 0;
  if (w.length >= WEEKS_WINDOW) {
    const slice = w.slice(0, WEEKS_WINDOW);
    const hits = slice.filter(pos).length;
    return { pass: hits >= WEEKS_NEED, hits, considered: slice.length, rule: `${WEEKS_NEED} of ${WEEKS_WINDOW}` };
  }
  if (w.length >= YOUNG_WINDOW) {
    const slice = w.slice(0, YOUNG_WINDOW);
    const hits = slice.filter(pos).length;
    return { pass: hits >= YOUNG_NEED, hits, considered: slice.length, rule: `${YOUNG_NEED} of ${YOUNG_WINDOW} (young pot)` };
  }
  return { pass: false, hits: w.filter(pos).length, considered: w.length, rule: `needs ≥ ${YOUNG_WINDOW} traded weeks` };
}

/**
 * Re-score settled picks under a calibrated probability.
 *   picks   [{ picked_at, settled_at, side: 'YES'|'NO', p_yes_model, p_yes_cal, yes_price, won, net_c }]
 *           p_yes_cal may be null (no calibrated number for that pick) → the pick is unknown, excluded.
 *   now     the decision instant
 * Returns the pot the survivors form plus the counts the report prints.
 */
export function rescorePicks(picks, { now = new Date(), minEdge = RESCORE_MIN_EDGE } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const cutoff30 = nowMs - 30 * DAY_MS;
  let unknown = 0;
  let dropped = 0;
  const survivors = [];
  for (const p of picks ?? []) {
    if (p.p_yes_cal == null || !Number.isFinite(Number(p.p_yes_cal))) { unknown += 1; continue; }
    const yes = p.side === 'YES';
    const pSide = yes ? Number(p.p_yes_cal) : 1 - Number(p.p_yes_cal);
    const cost = yes ? Number(p.yes_price) : 1 - Number(p.yes_price);
    if (!Number.isFinite(pSide) || !Number.isFinite(cost)) { unknown += 1; continue; }
    const edge = pSide - cost;
    if (edge < minEdge) { dropped += 1; continue; }
    survivors.push({ ...p, cost, cal_edge: edge });
  }
  const weeksMap = new Map();
  const dayNet30 = new Map();
  let n30 = 0;
  let net30 = 0;
  let netAll = 0;
  let wins = 0;
  let entrySum = 0;
  for (const s of survivors) {
    const settled = new Date(s.settled_at);
    netAll += num(s.net_c);
    if (s.won) wins += 1;
    entrySum += s.cost;
    const wk = isoWeekKey(settled);
    const w = weeksMap.get(wk) ?? { wk, n: 0, net_c: 0 };
    w.n += 1; w.net_c += num(s.net_c);
    weeksMap.set(wk, w);
    if (settled.getTime() >= cutoff30) {
      n30 += 1; net30 += num(s.net_c);
      const d = etDay(settled);
      dayNet30.set(d, (dayNet30.get(d) ?? 0) + num(s.net_c));
    }
  }
  const weeks = [...weeksMap.values()].sort((a, b) => (a.wk < b.wk ? 1 : -1)).slice(0, WEEKS_WINDOW);
  let maxDayShare = null;
  if (net30 > 0) {
    let best = 0;
    for (const v of dayNet30.values()) best = Math.max(best, v);
    maxDayShare = best / net30;
  }
  return {
    n_all: survivors.length, wins_all: wins, net_all_c: netAll,
    n_30d: n30, net_30d_c: net30,
    mean_entry: survivors.length ? entrySum / survivors.length : null,
    weeks, max_day_share: maxDayShare,
    counts: { input: (picks ?? []).length, unknown, dropped, survivors: survivors.length },
  };
}

/** The §2 PROMOTE bar on a re-scored pot. */
export function promoteBar(pot) {
  const nAll = num(pot.n_all);
  const wk = weeksTest(pot.weeks);
  const wlb = nAll > 0 ? wilsonLowerBound(num(pot.wins_all), nAll) : 0;
  const be = pot.mean_entry == null ? null : Number(pot.mean_entry);
  const share = pot.max_day_share == null ? null : Number(pot.max_day_share);
  const checks = {
    n_all: nAll >= PROMOTE_MIN_N_ALL,
    net_30d_pos: num(pot.net_30d_c) > 0,
    net_all_pos: num(pot.net_all_c) > 0,
    weeks: wk.pass,
    wilson_vs_breakeven: be != null && wlb > be,
    concentration: num(pot.net_30d_c) > 0 && share != null && share <= CONCENTRATION_MAX_SHARE,
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    detail: { n_all: nAll, wins_all: num(pot.wins_all), net_all_c: num(pot.net_all_c), n_30d: num(pot.n_30d), net_30d_c: num(pot.net_30d_c),
      wilson_lb: r4(wlb), breakeven: r4(be), weeks: wk, max_day_share: r4(share) },
  };
}

/** Both of the newest two fits beat their own raw Brier (both numbers stamped). Fits newest-first. */
export function consecutiveBrierWins(fits, need = CONSECUTIVE_FITS) {
  const f = [...(fits ?? [])].sort((a, b) => (String(a.fit_at) < String(b.fit_at) ? 1 : -1)).slice(0, need);
  const rows = f.map((x) => ({
    id: x.id, fit_at: x.fit_at,
    brier_raw: x.brier_raw == null ? null : Number(x.brier_raw),
    brier_cal: x.brier_cal == null ? null : Number(x.brier_cal),
    wins: x.brier_raw != null && x.brier_cal != null && Number(x.brier_cal) < Number(x.brier_raw),
  }));
  return { pass: rows.length >= need && rows.every((r) => r.wins), need, fits: rows };
}

/**
 * The decision. `commodity` decides whether the metals trading-day floor applies.
 *   fits          edge_calibration_maps rows for (commodity, method), any order
 *   rescored      rescorePicks() output
 *   tradingDays   distinct ET days with prob_clock data (metals); ignored for bitcoin
 * Returns { verdict: 'PROMOTE' | 'HOLD', checks, brier, bar, trading_days }.
 */
export function decidePromotion({ commodity, fits, rescored, tradingDays = null }) {
  const brier = consecutiveBrierWins(fits);
  const bar = promoteBar(rescored);
  const metals = commodity === 'gold' || commodity === 'silver';
  const daysOk = !metals || (tradingDays != null && Number(tradingDays) >= METALS_MIN_TRADING_DAYS);
  const checks = { brier_two_fits: brier.pass, rescored_bar: bar.pass, trading_days: daysOk };
  return {
    verdict: Object.values(checks).every(Boolean) ? 'PROMOTE' : 'HOLD',
    checks,
    brier,
    bar,
    trading_days: metals ? { have: tradingDays, need: METALS_MIN_TRADING_DAYS } : null,
    rescore_counts: rescored.counts ?? null,
  };
}

/** Brier of a probability vector against 0/1 outcomes. */
export function brier(ps, ys) {
  if (!ps.length) return null;
  let s = 0;
  for (let i = 0; i < ps.length; i += 1) s += (ps[i] - ys[i]) ** 2;
  return s / ps.length;
}
