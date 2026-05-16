// Pure-function tests for the smile-non-degeneracy check in
// scripts/soak-commodities.js. The 2026-05-15 retune (handoff:
// project_commodity_soak_threshold.md) swapped the absolute-stddev floor for
// a relative-spread check; these tests pin the threshold semantics so a
// future "just nudge the number" change can't silently restore the cry-wolf.

import { describe, it, expect } from 'vitest';
import { evaluateSmile, minSmileRatio } from '../scripts/soak-commodities.js';

describe('evaluateSmile', () => {
  it('skips when fewer than 3 strikes have usable IV', () => {
    expect(evaluateSmile([])).toMatchObject({ ok: true, reason: 'too_few_strikes' });
    expect(evaluateSmile([0.3])).toMatchObject({ ok: true, reason: 'too_few_strikes' });
    expect(evaluateSmile([0.3, 0.31])).toMatchObject({ ok: true, reason: 'too_few_strikes' });
  });

  it('skips silently when input is non-array / null', () => {
    expect(evaluateSmile(null).ok).toBe(true);
    expect(evaluateSmile(undefined).ok).toBe(true);
  });

  it('filters non-finite values (NaN, string) out of the population', () => {
    // In production the query filters out null IVs upstream; this guards the
    // residual cases where a row arrives with a non-numeric value.
    const r = evaluateSmile([0.3, NaN, 'nope', 0.31, 0.32]);
    expect(r.strikes).toBe(3);
  });

  it('flags a literally flat smile (stddev = 0) as degenerate', () => {
    const r = evaluateSmile([0.25, 0.25, 0.25, 0.25, 0.25]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('smile_too_flat');
    expect(r.stddev).toBe(0);
    expect(r.ratio).toBe(0);
  });

  it('flags non-positive mean as degenerate (defensive guard)', () => {
    const r = evaluateSmile([0, 0, 0, 0]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('non_positive_mean');
  });

  it('passes a real silver smile (~30% IV, ~3% relative spread)', () => {
    // Representative healthy silver snapshot ~0.55 IV at ATM, ±0.02 across the chain.
    const r = evaluateSmile([0.52, 0.54, 0.55, 0.56, 0.58]);
    expect(r.ok).toBe(true);
    expect(r.ratio).toBeGreaterThan(0.005);
  });

  it('passes a real gold smile (~25% IV, ~2% relative spread)', () => {
    // Gold is tightly clustered post-Databento-cutover — observed mean ~0.25 IV
    // with day stddev ~0.005. Ratio ~2% comfortably clears 0.5%.
    const r = evaluateSmile([0.245, 0.248, 0.250, 0.253, 0.256]);
    expect(r.ok).toBe(true);
    expect(r.ratio).toBeGreaterThan(0.005);
  });

  it('passes a real oil smile (~70% IV, ~1% relative spread)', () => {
    // Oil today: mean ~0.69 IV, stddev ~0.006 → ratio ~0.9%. The ratio-based
    // check explicitly admits this regime that the old 0.05 stddev floor
    // false-failed.
    const r = evaluateSmile([0.676, 0.684, 0.687, 0.694, 0.701]);
    expect(r.ok).toBe(true);
    expect(r.ratio).toBeGreaterThan(0.005);
  });

  it('flags a near-flat oil chain (parse-error signature) even with high mean', () => {
    // mean=0.69, stddev=0.0017, ratio=0.0025 → below the 0.5% floor.
    // This is the actual failure mode worth surfacing: the chain "looks fine"
    // numerically but every strike printed the same IV. The old absolute
    // 0.05 floor caught it but lost it in the noise of healthy false-positives.
    const r = evaluateSmile([0.688, 0.689, 0.690, 0.691, 0.692]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('smile_too_flat');
    expect(r.ratio).toBeLessThan(0.005);
  });

  it('respects a per-call minRatio override', () => {
    const ivs = [0.245, 0.248, 0.250, 0.253, 0.256]; // ratio ~1.7%
    expect(evaluateSmile(ivs, { minRatio: 0.001 }).ok).toBe(true);
    expect(evaluateSmile(ivs, { minRatio: 0.05 }).ok).toBe(false);
  });
});

describe('minSmileRatio', () => {
  it('returns the default for unconfigured commodities', () => {
    expect(minSmileRatio('silver')).toBeGreaterThan(0);
    expect(minSmileRatio('gold')).toBeGreaterThan(0);
    expect(minSmileRatio('oil')).toBeGreaterThan(0);
    // All three use the default until per-commodity overrides are added.
    expect(minSmileRatio('silver')).toBe(minSmileRatio('gold'));
    expect(minSmileRatio('gold')).toBe(minSmileRatio('oil'));
  });

  it('returns the default for unknown commodities (defensive)', () => {
    expect(minSmileRatio('platinum')).toBeGreaterThan(0);
  });
});
