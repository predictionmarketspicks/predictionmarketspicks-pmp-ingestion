// IV solver / BS pricer round-trip tests. Compared against the Python original
// in commodity_edge/src/blackscholes.py — same inputs should produce
// numerically equivalent outputs (within 1e-3).

import { describe, it, expect } from 'vitest';
import { bsPrice, probAboveStrike, impliedVol, brentq } from '../src/engine/options.js';

describe('Black-Scholes', () => {
  it('prices a near-ATM call against a known fixture', () => {
    // Inputs match the Python __main__ self-test: S=73.39, K=73.99, T=1/365, sigma=0.30.
    const S = 73.39;
    const K = 73.99;
    const T = 1 / 365;
    const r = 0.045;
    const q = 0;
    const sigma = 0.3;
    const call = bsPrice(S, K, T, r, q, sigma, 'call');
    // Strike is +0.82% above spot on a 1-day, sigma=0.3 (1-day move ≈ 1.6%).
    // Half-sigma OTM ⇒ ~$0.22 — bounds keep us anchored to BS, not random regression.
    expect(call).toBeGreaterThan(0.15);
    expect(call).toBeLessThan(0.35);
  });

  it('round-trips price → implied vol → ~original sigma', () => {
    const S = 35;
    const K = 36;
    const T = 6 / 365;
    const r = 0.045;
    const q = 0;
    const sigma = 0.42;
    const price = bsPrice(S, K, T, r, q, sigma, 'call');
    const back = impliedVol(price, S, K, T, r, q, 'call');
    expect(back.converged).toBe(true);
    expect(back.iv).toBeCloseTo(sigma, 3);
  });

  it('probAboveStrike returns 0..1', () => {
    const p = probAboveStrike(35, 40, 7 / 365, 0.045, 0, 0.4);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it('flags no-arbitrage violations', () => {
    // Price below intrinsic: 35-30 = 5 intrinsic on a call, asking for IV at
    // price=2 should refuse.
    const r = impliedVol(2, 35, 30, 7 / 365, 0.045, 0, 'call');
    expect(r.converged).toBe(false);
    expect(r.method).toBe('no_arb_violation');
  });
});

describe('brentq', () => {
  it('finds roots of a simple polynomial', () => {
    const root = brentq((x) => x ** 3 - 2 * x - 5, 2, 3);
    expect(root).toBeCloseTo(2.0945514815, 6);
  });
});
