// Unit tests for the short-horizon vol / drift estimator.
//
// The module ships KXBTCD's intra-hour σ and μ — the inputs probAboveTwap
// uses when config.useShortHorizonRv is on. These tests lock the math
// (annualization, clamping) and the buffer-management semantics
// (sample-rate guard, capacity, freshness checks).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordTick,
  getShortHorizonStats,
  _resetBuffers,
  __test__,
} from '../src/engine/short-horizon-vol.js';

const { computeFromSamples, BUFFER_CAPACITY, MIN_TICKS_FOR_RV, MIN_TICK_INTERVAL_MS } = __test__;

beforeEach(() => {
  _resetBuffers();
});

// ---------- recordTick + buffer hygiene ----------

describe('recordTick', () => {
  it('ignores bad input (non-finite price, negative price, missing commodity)', () => {
    recordTick('bitcoin', NaN, Date.now());
    recordTick('bitcoin', -5, Date.now());
    recordTick(null, 100, Date.now());
    expect(getShortHorizonStats('bitcoin', { lookbackMin: 15 })).toBe(null);
  });

  it('enforces the 800ms sample-rate guard', () => {
    const t0 = 1_700_000_000_000;
    recordTick('bitcoin', 75_000, t0);
    recordTick('bitcoin', 75_010, t0 + 200);   // dropped — too soon
    recordTick('bitcoin', 75_020, t0 + 500);   // dropped — too soon
    recordTick('bitcoin', 75_030, t0 + 900);   // accepted
    const buf = __test__._buffers.get('bitcoin');
    expect(buf.length).toBe(2);
    expect(buf[0].price).toBe(75_000);
    expect(buf[1].price).toBe(75_030);
  });

  it('evicts oldest when capacity exceeded', () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i <= BUFFER_CAPACITY + 50; i++) {
      recordTick('bitcoin', 75_000 + i, t0 + i * 1_000);
    }
    const buf = __test__._buffers.get('bitcoin');
    expect(buf.length).toBe(BUFFER_CAPACITY);
    // Oldest tick should be evicted — first tick now corresponds to i=51.
    expect(buf[0].price).toBe(75_000 + 51);
  });
});

// ---------- getShortHorizonStats — rejects ----------

describe('getShortHorizonStats — null cases', () => {
  it('returns null when no buffer exists', () => {
    expect(getShortHorizonStats('bitcoin', { lookbackMin: 15 })).toBe(null);
  });

  it('returns null when buffer has fewer than MIN_TICKS_FOR_RV samples', () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < MIN_TICKS_FOR_RV - 5; i++) {
      recordTick('bitcoin', 75_000 + i, t0 + i * 10_000);
    }
    const out = getShortHorizonStats('bitcoin', {
      lookbackMin: 30,
      now: new Date(t0 + (MIN_TICKS_FOR_RV - 5) * 10_000),
    });
    expect(out).toBe(null);
  });

  it('returns null when the most recent tick is older than MAX_STALE_TICK_MS', () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 60; i++) {
      recordTick('bitcoin', 75_000, t0 + i * 10_000);
    }
    // "now" is 5 minutes past the last tick — stale.
    const out = getShortHorizonStats('bitcoin', {
      lookbackMin: 15,
      now: new Date(t0 + 60 * 10_000 + 5 * 60_000),
    });
    expect(out).toBe(null);
  });
});

// ---------- σ_annual round-trip from a known-σ synthetic GBM ----------

function gbmSamples({ S0, sigmaAnnual, muAnnual, dtSec, nSamples, t0 }) {
  // Box-Muller for deterministic Gaussians via a seeded LCG.
  let seed = 1234567;
  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed >>> 0) / 0x100000000;
  }
  function gauss() {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  const dtYr = dtSec / (365 * 24 * 3600);
  const drift = (muAnnual - 0.5 * sigmaAnnual * sigmaAnnual) * dtYr;
  const diff = sigmaAnnual * Math.sqrt(dtYr);
  const out = [{ price: S0, ts: t0 }];
  let logS = Math.log(S0);
  for (let i = 1; i < nSamples; i++) {
    logS += drift + diff * gauss();
    out.push({ price: Math.exp(logS), ts: t0 + i * dtSec * 1000 });
  }
  return out;
}

describe('computeFromSamples — annualization is correct', () => {
  it('round-trips σ within ±15% on 200 synthetic ticks at σ=0.50', () => {
    const t0 = 1_700_000_000_000;
    const samples = gbmSamples({
      S0: 75_000,
      sigmaAnnual: 0.50,
      muAnnual: 0,
      dtSec: 10,
      nSamples: 200,
      t0,
    });
    const out = computeFromSamples(samples, { now: samples[samples.length - 1].ts });
    expect(out).not.toBe(null);
    expect(out.sigma_annual).toBeGreaterThan(0.50 * 0.85);
    expect(out.sigma_annual).toBeLessThan(0.50 * 1.15);
    // Source may be 'clamped_mu_*' on a 200-sample synthetic where the
    // sample-mean drift annualizes past the MU_CAP — σ is the load-bearing
    // estimate, μ clamping is exercised in its own test below.
    expect(out.medianDtS).toBeCloseTo(10, 0);
  });

  it('round-trips σ within ±15% on 400 synthetic ticks at σ=1.20 (BTC-like)', () => {
    const t0 = 1_700_000_000_000;
    const samples = gbmSamples({
      S0: 75_000,
      sigmaAnnual: 1.20,
      muAnnual: 0,
      dtSec: 10,
      nSamples: 400,
      t0,
    });
    const out = computeFromSamples(samples, { now: samples[samples.length - 1].ts });
    expect(out).not.toBe(null);
    expect(out.sigma_annual).toBeGreaterThan(1.20 * 0.85);
    expect(out.sigma_annual).toBeLessThan(1.20 * 1.15);
  });
});

describe('computeFromSamples — clamping', () => {
  it('clamps σ below SIGMA_MIN (0.10) and tags source', () => {
    // Tiny ticks — variance well below the floor.
    const t0 = 1_700_000_000_000;
    const samples = [];
    for (let i = 0; i < 60; i++) {
      // 1e-8 relative jitter → annualized σ ≈ ~3e-4, way below the floor.
      samples.push({ price: 75_000 + (i % 2) * 0.0001, ts: t0 + i * 10_000 });
    }
    const out = computeFromSamples(samples, { now: samples[samples.length - 1].ts });
    expect(out.sigma_annual).toBeCloseTo(0.10, 6);
    expect(out.source).toBe('clamped_low');
  });

  it('clamps σ above SIGMA_MAX (5.0) and tags source', () => {
    // Wild swings.
    const t0 = 1_700_000_000_000;
    const samples = [];
    let p = 75_000;
    for (let i = 0; i < 60; i++) {
      p *= (i % 2 === 0) ? 1.10 : 0.91;     // ±10% per 10s
      samples.push({ price: p, ts: t0 + i * 10_000 });
    }
    const out = computeFromSamples(samples, { now: samples[samples.length - 1].ts });
    expect(out.sigma_annual).toBeCloseTo(5.0, 6);
    expect(out.source).toBe('clamped_high');
  });

  it('clamps μ above MU_CAP (+3.0) when prices trend monotonically up', () => {
    const t0 = 1_700_000_000_000;
    const samples = [];
    let p = 75_000;
    for (let i = 0; i < 60; i++) {
      p *= 1.001;     // +0.1% per 10s → ~+3,150× annualized, way past cap
      samples.push({ price: p, ts: t0 + i * 10_000 });
    }
    const out = computeFromSamples(samples, { now: samples[samples.length - 1].ts });
    expect(out.mu_annual).toBeCloseTo(3.0, 6);
    expect(out.source).toMatch(/clamped/);
  });
});

// ---------- end-to-end via recordTick + getShortHorizonStats ----------

describe('getShortHorizonStats — happy path via recordTick', () => {
  it('returns sensible σ on a 15-min synthetic stream', () => {
    const t0 = Date.now() - 14 * 60_000;
    const samples = gbmSamples({
      S0: 75_000,
      sigmaAnnual: 0.80,
      muAnnual: 0.20,
      dtSec: 10,
      nSamples: 84,                     // ~14 min at 10s
      t0,
    });
    for (const s of samples) recordTick('bitcoin', s.price, s.ts);
    const out = getShortHorizonStats('bitcoin', {
      lookbackMin: 15,
      now: new Date(samples[samples.length - 1].ts),
    });
    expect(out).not.toBe(null);
    expect(out.nTicks).toBeGreaterThan(50);
    expect(out.sigma_annual).toBeGreaterThan(0.5);
    expect(out.sigma_annual).toBeLessThan(1.2);
  });

  it('filters by lookback window', () => {
    const tEnd = Date.now();
    // 60 ticks an hour ago — outside a 15-min lookback.
    for (let i = 0; i < 60; i++) {
      recordTick('bitcoin', 75_000 + i, tEnd - 60 * 60_000 + i * 1_000);
    }
    // 10 ticks in the last minute — too few to clear MIN_TICKS_FOR_RV.
    for (let i = 0; i < 10; i++) {
      recordTick('bitcoin', 76_000 + i, tEnd - 60_000 + i * 1_000);
    }
    const out = getShortHorizonStats('bitcoin', { lookbackMin: 15, now: new Date(tEnd) });
    expect(out).toBe(null);
  });
});
