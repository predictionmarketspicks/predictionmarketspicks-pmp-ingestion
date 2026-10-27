// R-AVG-LOCK v1 (engine/btc15m-lock.js) — the pure model and the checkpoint scheduler.
// Spec: site repo handoffs/FINAL_MINUTE_LANE_AND_5MIN_HUB_2026-10-27.md §2.1–2.4.

import { describe, it, expect } from 'vitest';
import { dueCheckpoint, sigmaPerSecondLog, lockModel, CHECKPOINTS_S } from '../src/engine/btc15m-lock.js';

describe('dueCheckpoint', () => {
  it('fires each checkpoint once, inside its 5-s slot', () => {
    expect(CHECKPOINTS_S).toEqual([50, 40, 30, 20, 10]);
    expect(dueCheckpoint(61_000)).toBe(null);
    expect(dueCheckpoint(50_000)).toBe(50);
    expect(dueCheckpoint(46_000)).toBe(50); // the sampler slipped: still fires 50
    expect(dueCheckpoint(45_000)).toBe(null); // slot closed
    expect(dueCheckpoint(50_000, new Set([50]))).toBe(null);
    expect(dueCheckpoint(10_000)).toBe(10);
    expect(dueCheckpoint(4_000)).toBe(null);
  });
});

describe('sigmaPerSecondLog', () => {
  const close = 1_800_000_000_000 - (1_800_000_000_000 % 900_000);
  const prints = (fn) => {
    const out = [];
    for (let t = close - 370_000; t < close - 55_000; t += 1000) out.push({ t, price: fn(t) });
    return out;
  };

  it('a flat index has zero σ (returns exist, all zero)', () => {
    expect(sigmaPerSecondLog(prints(() => 100_000), close)).toBe(0);
  });

  it('recovers the per-second sd of a ±x alternating 5-s path', () => {
    // log returns alternate ±r every 5 s → sample sd ≈ r·√(n/(n−1)), per second ÷ √5
    const r = 0.0005;
    const p = prints((t) => 100_000 * Math.exp(Math.floor((t - (close - 370_000)) / 5000) % 2 === 0 ? 0 : r));
    const s = sigmaPerSecondLog(p, close);
    expect(s).toBeGreaterThan(r / Math.sqrt(5) * 0.95);
    expect(s).toBeLessThan(r / Math.sqrt(5) * 1.1);
  });

  it('too few prints → null', () => {
    expect(sigmaPerSecondLog(prints(() => 100_000).slice(-60), close)).toBe(null);
  });
});

describe('lockModel', () => {
  const base = { lockedAvg: 100_050, lockedPrints: 30, indexNow: 100_050, strike: 100_000, sigmaLog: 0.0001, rSec: 30 };

  it('matches the closed form: sd[A] = (r/60)·σ·√(r/3)', () => {
    const { z, pYes, lockedShare } = lockModel(base);
    const sd = (30 / 60) * (0.0001 * 100_050) * Math.sqrt(10); // ≈ 15.82
    expect(z).toBeCloseTo(50 / sd, 6);
    expect(pYes).toBeGreaterThan(0.99);
    expect(lockedShare).toBe(0.5);
  });

  it('the locked share pulls E[A] toward the locked average', () => {
    // index now below the strike, but 50 of 60 prints are locked well above it
    const { z } = lockModel({ ...base, lockedAvg: 100_100, indexNow: 99_990, rSec: 10, lockedPrints: 50 });
    expect(z).toBeGreaterThan(0);
  });

  it('is clamped to ±8 and null on a bad input', () => {
    expect(lockModel({ ...base, lockedAvg: 101_000, indexNow: 101_000 }).z).toBe(8);
    expect(lockModel({ ...base, strike: null }).z).toBe(null);
    expect(lockModel({ ...base, sigmaLog: 0 }).z).toBe(null);
    expect(lockModel({ ...base, rSec: 0 }).z).toBe(null);
  });

  it('r^1.5: halving the seconds left cuts sd by 2^1.5', () => {
    const sdAt = (r) => (r / 60) * (0.0001 * 100_000) * Math.sqrt(r / 3);
    expect(sdAt(30) / sdAt(15)).toBeCloseTo(2 ** 1.5, 9);
  });
});
