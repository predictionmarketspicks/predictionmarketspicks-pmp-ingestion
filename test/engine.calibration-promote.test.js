// Calibration-map auto-promotion decision (site repo handoffs/EDGE_LOOP_V2_2026-11-09.md U8).
import { describe, it, expect } from 'vitest';
import {
  wilsonLowerBound, isoWeekKey, weeksTest, rescorePicks, promoteBar, consecutiveBrierWins, decidePromotion,
  PROMOTE_MIN_N_ALL, RESCORE_MIN_EDGE, METALS_MIN_TRADING_DAYS,
} from '../src/engine/calibration-promote.js';

const NOW = new Date('2026-11-09T18:00:00Z');
const daysAgo = (d, h = 20) => new Date(NOW.getTime() - d * 86_400_000 + (h - 18) * 3_600_000).toISOString();

/** A YES pick at 45c the calibrated model still likes at 60% (+15pp) that paid +50c net, or lost −45c. */
const pick = (over = {}) => ({
  picked_at: daysAgo(3), settled_at: daysAgo(3), side: 'YES', p_yes_model: 0.70, p_yes_cal: 0.60, yes_price: 0.45,
  won: true, net_c: 50, ...over,
});

/** n picks spread one per day over the last `days` days, 2 of every `winEvery` winning. */
function series(n, { days = 60, winEvery = 3, loseNet = -45, winNet = 50 } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const d = Math.floor((i * days) / n);
    const won = i % winEvery !== 0;
    out.push(pick({ picked_at: daysAgo(d), settled_at: daysAgo(d), won, net_c: won ? winNet : loseNet }));
  }
  return out;
}

describe('the pieces', () => {
  it('wilson lower bound is the miner\'s formula', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(61, 84)).toBeCloseTo(0.6225, 3); // bitcoin-edge 30d 61-23, 2026-11-09
    expect(wilsonLowerBound(10, 10)).toBeLessThan(1);
  });
  it('iso week keys cross the year boundary the ISO way', () => {
    expect(isoWeekKey(new Date('2026-11-09T12:00:00Z'))).toBe('2026-46');
    expect(isoWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-53');
  });
  it('weeks test: 4 of 6, 3 of 4 when young, never under 4 traded weeks', () => {
    const w = (nets) => nets.map((net_c, i) => ({ wk: `2026-${40 + i}`, n: 5, net_c }));
    expect(weeksTest(w([1, 1, 1, 1, -1, -1])).pass).toBe(true);
    expect(weeksTest(w([1, 1, 1, -1, -1, -1])).pass).toBe(false);
    expect(weeksTest(w([1, 1, 1, -1])).pass).toBe(true);
    expect(weeksTest(w([1, 1, -1, -1])).pass).toBe(false);
    expect(weeksTest(w([1, 1, 1])).pass).toBe(false);
    expect(weeksTest(w([-9, -9, 1, 1, 1, 1, 1, 1])).hits).toBe(6); // only the newest 6 count (keys ascend with i)
  });
});

describe('rescorePicks', () => {
  it('keeps a pick only when the CALIBRATED side edge clears the MODERATE floor; unknowns are excluded, not dropped', () => {
    const r = rescorePicks([
      pick(),                                                       // 60 − 45 = +15pp → survives
      pick({ p_yes_cal: 0.50 }),                                    // +5pp → dropped (floor is 7)
      pick({ side: 'NO', p_yes_cal: 0.30, yes_price: 0.60 }),       // NO: 0.70 − 0.40 = +30pp → survives
      pick({ side: 'NO', p_yes_cal: 0.55, yes_price: 0.60 }),       // NO: 0.45 − 0.40 = +5pp → dropped
      pick({ p_yes_cal: null }),                                    // unknown
    ], { now: NOW });
    expect(RESCORE_MIN_EDGE).toBe(0.07);
    expect(r.counts).toEqual({ input: 5, unknown: 1, dropped: 2, survivors: 2 });
    expect(r.n_all).toBe(2);
    expect(r.mean_entry).toBeCloseTo((0.45 + 0.40) / 2, 9);
  });
  it('rolls weeks (newest first, ≤ 6), the 30-day window and the ET-day concentration', () => {
    const r = rescorePicks(series(60, { days: 60 }), { now: NOW });
    expect(r.n_all).toBe(60);
    expect(r.n_30d).toBe(31); // days 0..30 inclusive sit inside the 30-day window
    expect(r.weeks.length).toBe(6);
    expect(r.weeks[0].wk >= r.weeks[1].wk).toBe(true);
    expect(r.max_day_share).toBeGreaterThan(0);
    expect(r.max_day_share).toBeLessThanOrEqual(1);
    // one day carrying everything → share 1
    const one = rescorePicks([pick({ net_c: 100 }), pick({ settled_at: daysAgo(40), net_c: 5 })], { now: NOW });
    expect(one.max_day_share).toBe(1);
  });
});

describe('promoteBar + decidePromotion', () => {
  const fitsGood = [
    { id: 2, fit_at: '2026-11-09T12:00:00Z', brier_raw: 0.232, brier_cal: 0.218 },
    { id: 1, fit_at: '2026-11-02T12:00:00Z', brier_raw: 0.233, brier_cal: 0.218 },
  ];

  it('a healthy 60-pick pot (2 of 3 win at 45c) passes the bar', () => {
    const pot = rescorePicks(series(60), { now: NOW });
    const bar = promoteBar(pot);
    expect(bar.checks).toEqual({ n_all: true, net_30d_pos: true, net_all_pos: true, weeks: true, wilson_vs_breakeven: true, concentration: true });
    expect(bar.pass).toBe(true);
    expect(decidePromotion({ commodity: 'bitcoin', fits: fitsGood, rescored: pot }).verdict).toBe('PROMOTE');
  });

  it('each leg of the bar can fail on its own', () => {
    expect(promoteBar(rescorePicks(series(PROMOTE_MIN_N_ALL - 1), { now: NOW })).checks.n_all).toBe(false);
    // a losing pot: 1 of 3 wins
    const losing = promoteBar(rescorePicks(series(60).map((p, i) => ({ ...p, won: i % 3 === 0, net_c: i % 3 === 0 ? 50 : -45 })), { now: NOW }));
    expect(losing.checks.net_all_pos).toBe(false);
    expect(losing.checks.wilson_vs_breakeven).toBe(false);
    // concentration: one monster day inside the 30d window
    const picks = series(60);
    picks[0] = { ...picks[0], net_c: 5000 };
    expect(promoteBar(rescorePicks(picks, { now: NOW })).checks.concentration).toBe(false);
    // a pot younger than 4 traded weeks never passes the weeks test
    expect(promoteBar(rescorePicks(series(60, { days: 14 }), { now: NOW })).checks.weeks).toBe(false);
  });

  it('two consecutive fits must both beat their raw Brier — one fit, or a null, is not enough', () => {
    expect(consecutiveBrierWins(fitsGood).pass).toBe(true);
    expect(consecutiveBrierWins([fitsGood[0]]).pass).toBe(false);
    expect(consecutiveBrierWins([fitsGood[0], { id: 1, fit_at: '2026-11-02T12:00:00Z', brier_raw: null, brier_cal: null }]).pass).toBe(false);
    expect(consecutiveBrierWins([fitsGood[0], { ...fitsGood[1], brier_cal: 0.24 }]).pass).toBe(false);
    // order-insensitive input; only the newest two are read
    const older = { id: 0, fit_at: '2026-10-26T12:00:00Z', brier_raw: 0.2, brier_cal: 0.9 };
    expect(consecutiveBrierWins([older, fitsGood[1], fitsGood[0]]).pass).toBe(true);
    expect(consecutiveBrierWins([fitsGood[1], fitsGood[0]]).fits[0].id).toBe(2);
  });

  it('metals need ≥ 10 trading days of clock data; bitcoin does not', () => {
    const pot = rescorePicks(series(60), { now: NOW });
    expect(METALS_MIN_TRADING_DAYS).toBe(10);
    expect(decidePromotion({ commodity: 'gold', fits: fitsGood, rescored: pot, tradingDays: 9 }).verdict).toBe('HOLD');
    expect(decidePromotion({ commodity: 'gold', fits: fitsGood, rescored: pot, tradingDays: 10 }).verdict).toBe('PROMOTE');
    expect(decidePromotion({ commodity: 'gold', fits: fitsGood, rescored: pot, tradingDays: null }).checks.trading_days).toBe(false);
    expect(decidePromotion({ commodity: 'bitcoin', fits: fitsGood, rescored: pot, tradingDays: null }).checks.trading_days).toBe(true);
  });

  it('today\'s live shape HOLDS: bitcoin platt beats raw on every fit but the re-scored pot is the 84-pick 30d sample (n_all < 50 all-time would pass; a 2-pick metals pot cannot)', () => {
    // metals today: 2 gold picks with a clock at the pick → n_all 2 → HOLD by n_all alone, whatever the Brier says
    const metals = rescorePicks([pick(), pick({ settled_at: daysAgo(1) })], { now: NOW });
    const d = decidePromotion({ commodity: 'gold', fits: fitsGood, rescored: metals, tradingDays: 10 });
    expect(d.verdict).toBe('HOLD');
    expect(d.checks.rescored_bar).toBe(false);
    expect(d.bar.checks.n_all).toBe(false);
  });
});
