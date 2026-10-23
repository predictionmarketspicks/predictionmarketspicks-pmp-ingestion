// Variance-time clock (site repo handoffs/METALS_EDGE_VARIANCE_CLOCK_2026-10-23.md PART 2 / PART 7).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  effectiveYearFraction,
  fitIntradayProfile,
  flatProfile,
  resolveVarianceClock,
  returnsFromMarks,
  etDowHour,
  metalsOpen,
  CLOCK_METHOD,
  CALENDAR_METALS,
  __resetClockLogForTest,
} from '../src/engine/variance-clock.js';
import { yearFraction, probAboveStrikePhysical } from '../src/engine/options.js';
import {
  applyCalibration,
  groupGoverning,
  getCalibrationMap,
  getVarianceClock,
  isCalibrationActive,
  __setMapsForTest,
  __setClocksForTest,
} from '../src/engine/calibration.js';

vi.mock('../src/delivery/supabase.js', () => ({ getClient: () => { throw new Error('no db in tests'); } }));

const H = 3600 * 1000;
const YEAR_MS = 365 * 24 * H;

// Deterministic PRNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// A metals-shaped profile: loud morning, quiet late afternoon, 17:00 break.
function metalsProfile() {
  const w = [0.6, 0.8, 1.1, 0.7, 0.7, 0.4, 0.6, 0.7, 3.7, 1.9, 2.5, 1.1, 1.0, 0.6, 0.6, 0.7, 0.31, 0, 0.25, 0.25, 0.9, 1.6, 1.1, 0.9];
  return { hours_et: w, calendar: CALENDAR_METALS };
}

describe('effectiveYearFraction — the flat identity', () => {
  it('flat profile ≡ yearFraction to 1e-12 for 1,000 random (now, close) pairs', () => {
    const r = rng(20261023);
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 1000; i++) {
      const now = base + Math.floor(r() * 300 * 24 * H) + Math.floor(r() * 1000);
      const close = now + Math.floor(r() * 10 * 24 * H) + 1;
      const tEff = effectiveYearFraction(now, close, flatProfile());
      expect(Math.abs(tEff - yearFraction(now / 1000, close / 1000))).toBeLessThan(1e-12);
    }
  });
});

describe('effectiveYearFraction — the metals calendar', () => {
  const p = metalsProfile();
  it('is monotone non-increasing as now advances, and 0 at close', () => {
    const close = Date.parse('2026-10-26T21:00:00Z'); // Mon 5 PM ET
    let prev = Infinity;
    for (let now = Date.parse('2026-10-23T13:35:00Z'); now <= close; now += 7 * 60 * 1000) {
      const t = effectiveYearFraction(now, close, p);
      expect(t).toBeLessThanOrEqual(prev + 1e-18);
      prev = t;
    }
    expect(effectiveYearFraction(close, close, p)).toBe(0);
  });

  it('weekend hours contribute 0; Sunday 18:00 ET onward contributes', () => {
    // Fri 17:00 ET (21:00Z, EDT) → Sun 18:00 ET (22:00Z): all closed.
    const fri5 = Date.parse('2026-10-23T21:00:00Z');
    const sun6 = Date.parse('2026-10-25T22:00:00Z');
    expect(effectiveYearFraction(fri5, sun6, p)).toBe(0);
    // Sun 18:00 → 19:00 ET carries the 18:00 weight.
    const t = effectiveYearFraction(sun6, sun6 + H, p);
    expect(t).toBeCloseTo((p.hours_et[18] * H) / YEAR_MS, 15);
    expect(t).toBeGreaterThan(0);
    // The 17:00–18:00 ET weekday break is closed.
    const thu5 = Date.parse('2026-10-22T21:00:00Z');
    expect(effectiveYearFraction(thu5, thu5 + H, p)).toBe(0);
  });

  it('Friday → Monday contract (KXGOLDD-26OCT2617 shape) integrates Fri 16:00 → Mon 17:00 ET', () => {
    const fri4 = Date.parse('2026-10-23T20:00:00Z');
    const monClose = Date.parse('2026-10-26T21:00:00Z');
    // Expected by hand: Fri 16:00 hour, then Sun 18–23, then Mon 0–16.
    const w = p.hours_et;
    let hours = w[16];
    for (let h = 18; h <= 23; h++) hours += w[h];
    for (let h = 0; h <= 16; h++) hours += w[h];
    expect(effectiveYearFraction(fri4, monClose, p)).toBeCloseTo((hours * H) / YEAR_MS, 15);
    // and it is far less than calendar time over the same 73 hours
    expect(effectiveYearFraction(fri4, monClose, p)).toBeLessThan(yearFraction(fri4 / 1000, monClose / 1000) * 0.5);
  });

  it('handles DST: ET hour boundaries stay on UTC hour boundaries across Nov 1', () => {
    const before = Date.parse('2026-10-30T13:00:00Z'); // Fri 9 AM EDT
    const after = Date.parse('2026-11-02T14:00:00Z');  // Mon 9 AM EST
    expect(etDowHour(before)).toEqual({ dow: 5, hour: 9 });
    expect(etDowHour(after)).toEqual({ dow: 1, hour: 9 });
    expect(Number.isFinite(effectiveYearFraction(before, after, p))).toBe(true);
  });

  it('metalsOpen encodes the Globex week', () => {
    expect(metalsOpen(6, 12)).toBe(false);
    expect(metalsOpen(0, 17)).toBe(false);
    expect(metalsOpen(0, 18)).toBe(true);
    expect(metalsOpen(5, 16)).toBe(true);
    expect(metalsOpen(5, 17)).toBe(false);
    expect(metalsOpen(3, 17)).toBe(false);
    expect(metalsOpen(3, 18)).toBe(true);
  });
});

describe('fail-open — never a throw, always calendar time', () => {
  const now = Date.parse('2026-10-23T15:00:00Z');
  const close = Date.parse('2026-10-23T21:00:00Z');
  const cal = yearFraction(now / 1000, close / 1000);
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN weight', { hours_et: Array(24).fill(1).map((x, i) => (i === 3 ? NaN : x)), calendar: CALENDAR_METALS }],
    ['Infinity weight', { hours_et: Array(24).fill(Infinity), calendar: CALENDAR_METALS }],
    ['short array', { hours_et: [1, 1, 1], calendar: CALENDAR_METALS }],
    ['negative weight', { hours_et: Array(24).fill(-1), calendar: CALENDAR_METALS }],
    ['unknown calendar', { hours_et: Array(24).fill(1), calendar: 'lunar' }],
    ['string', 'garbage'],
  ])('%s profile → calendar time', (_n, prof) => {
    expect(() => effectiveYearFraction(now, close, prof)).not.toThrow();
    expect(effectiveYearFraction(now, close, prof)).toBe(cal);
  });

  it('resolveVarianceClock: missing / stale / NaN / unknown method → null + one log line, never a throw', () => {
    __resetClockLogForTest();
    const log = vi.fn();
    const good = { id: 1, commodity: 'gold', method: CLOCK_METHOD, fit_at: '2026-10-20T00:00:00Z', knots: metricsKnots() };
    expect(resolveVarianceClock(good, { nowMs: now, log })).toEqual(good.knots);
    expect(resolveVarianceClock(null, { nowMs: now, commodity: 'gold', log })).toBeNull();
    expect(resolveVarianceClock({ ...good, fit_at: '2026-10-01T00:00:00Z' }, { nowMs: now, log })).toBeNull();
    expect(resolveVarianceClock({ ...good, knots: { ...good.knots, hours_et: Array(24).fill(NaN) } }, { nowMs: now, log })).toBeNull();
    expect(resolveVarianceClock({ ...good, method: 'platt_pooled' }, { nowMs: now, log })).toBeNull();
    expect(resolveVarianceClock({ ...good, fit_at: 'not a date' }, { nowMs: now, log })).toBeNull();
    expect(() => resolveVarianceClock({ get method() { throw new Error('boom'); } }, { nowMs: now, log })).not.toThrow();
    expect(log.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(log.mock.calls.every(([m]) => m.startsWith('[clock] fail-open'))).toBe(true);
  });
});

function metricsKnots() {
  return { ...metalsProfile(), window_from: '2026-09-23T17:00:00Z', window_to: '2026-10-23T18:00:00Z', n_returns: 2000, lambda: 0.68 };
}

describe('fitIntradayProfile', () => {
  // Synthetic marks: 15-min returns whose σ depends on ET hour (morning 3× the close).
  function synthMarks(days, seed) {
    const r = rng(seed);
    const marks = [];
    let spot = 4000;
    const start = Date.parse('2026-08-01T04:00:00Z');
    for (let t = start; t < start + days * 24 * H; t += 15 * 60 * 1000) {
      const { dow, hour } = etDowHour(t);
      if (!metalsOpen(dow, hour)) continue;
      const s = hour >= 8 && hour <= 10 ? 0.0024 : hour === 16 ? 0.0008 : 0.0012;
      const z = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
      spot *= Math.exp(s * z);
      marks.push({ mark_at: new Date(t).toISOString(), spot });
    }
    return marks;
  }

  it('weights average 1 over trading hours, 17:00 is 0, the loud morning outweighs the close', () => {
    const p = fitIntradayProfile(returnsFromMarks(synthMarks(30, 7)), { commodity: 'gold' });
    const trading = p.hours_et.filter((_, h) => h !== 17);
    expect(trading.reduce((a, b) => a + b, 0) / trading.length).toBeCloseTo(1, 5);
    expect(p.hours_et[17]).toBe(0);
    expect(p.hours_et[9]).toBeGreaterThan(p.hours_et[16] * 2);
    expect(p.calendar).toBe(CALENDAR_METALS);
  });

  it('shrinks toward flat until 8 weeks exist, then does not', () => {
    const short = fitIntradayProfile(returnsFromMarks(synthMarks(30, 11)));
    const long = fitIntradayProfile(returnsFromMarks(synthMarks(70, 11)));
    expect(short.lambda).toBeGreaterThan(0.5);
    expect(short.lambda).toBeLessThan(1);
    expect(long.lambda).toBe(1);
    // λ = H / (H + 240)
    expect(short.lambda).toBeCloseTo(short.hours_observed / (short.hours_observed + 240), 5);
  });

  it('throws on unusable input (the fit script reports it; the engine never fits)', () => {
    expect(() => fitIntradayProfile([])).toThrow();
  });
});

describe('storage — a shadow clock coexists with an active Platt map', () => {
  const platt = { id: 12, commodity: 'bitcoin', method: 'platt_pooled', knots: { a: 1.1, b: -0.02 }, active: true, shadow: false, fit_at: '2026-10-19T00:00:00Z' };
  const clock = { id: 13, commodity: 'bitcoin', method: CLOCK_METHOD, knots: metalsProfile(), active: false, shadow: true, fit_at: '2026-10-23T00:00:00Z' };
  const goldClock = { ...clock, id: 14, commodity: 'gold' };

  beforeEach(() => {
    const { maps, clocks } = groupGoverning([goldClock, clock, platt]); // newest-first
    __setMapsForTest([...maps]);
    __setClocksForTest([...clocks]);
  });

  it('each is returned by its own getter; a newer shadow clock never displaces the active Platt map', () => {
    expect(getCalibrationMap('bitcoin')).toBe(platt);
    expect(getVarianceClock('bitcoin')).toBe(clock);
    expect(isCalibrationActive('bitcoin')).toBe(true);
    expect(getCalibrationMap('gold')).toBeNull();
    expect(getVarianceClock('gold')).toBe(goldClock);
    expect(isCalibrationActive('gold')).toBe(false);
  });

  it('applyCalibration() on a clock row returns null — the clock is never a map on p', () => {
    expect(applyCalibration(clock, 0.4)).toBeNull();
    expect(applyCalibration(goldClock, 0.9)).toBeNull();
  });
});

describe('replay — PART 0.4 Brier through the module with the real normCdf', () => {
  const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/metals-final-snapshot-replay.json', import.meta.url)), 'utf8'));
  const COLS = fx.columns;
  // Handoff 0.4 (logistic Φ): gold clock 0.0073, silver 0.0096. Real normCdf,
  // measured 2026-10-23 on the same 1,120 strikes each: 0.00729 / 0.00962.
  for (const c of ['gold', 'silver']) {
    it(`${c}: 28 events, Brier model / market / clock reproduce 0.4 within ±0.0005`, () => {
      const rows = fx[c].rows.map((a) => Object.fromEntries(COLS.map((k, i) => [k, a[i]])));
      const s0 = fx[c].sigma_last_hour;
      expect(new Set(rows.map((r) => r.event_ticker)).size).toBe(28);
      let bm = 0;
      let bk = 0;
      let bc = 0;
      for (const r of rows) {
        // A profile whose weight makes the engine's own σ_blend integrate to the
        // measured last-hour σ: w = (σ0/σ_blend)². Flat calendar ⇒ pure scaling,
        // so this exercises effectiveYearFraction + probAboveStrikePhysical end to end.
        const w = (s0 / r.sigma_blend) ** 2;
        const prof = { hours_et: Array(24).fill(w), calendar: 'none' };
        const now = r.close_ms - r.ms_to_close;
        const tEff = effectiveYearFraction(now, r.close_ms, prof);
        const p = probAboveStrikePhysical(r.spot, r.strike, tEff, 0, r.sigma_blend);
        bm += (r.prob_physical - r.y) ** 2;
        bk += (r.kalshi_yes - r.y) ** 2;
        bc += (p - r.y) ** 2;
      }
      const n = rows.length;
      const exp = fx.expected[c];
      expect(Math.abs(bm / n - exp.brier_model)).toBeLessThanOrEqual(0.0005);
      expect(Math.abs(bk / n - exp.brier_market)).toBeLessThanOrEqual(0.0005);
      expect(Math.abs(bc / n - exp.brier_clock)).toBeLessThanOrEqual(0.0005);
      expect(bc).toBeLessThan(bm);
    });
  }
});
