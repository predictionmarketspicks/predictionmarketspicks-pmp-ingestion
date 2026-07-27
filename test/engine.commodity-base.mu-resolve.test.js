// resolveTwapMu — the mu that feeds probPhysical on the TWAP path
// (BITCOIN_V2_CUTOVER_2026-07-27). Raw short-horizon momentum, shrunk by
// lambda (scale), clamped to a horizon-appropriate annualized cap — NOT the
// +/-3.0 sanity band short-horizon-vol.js applies to its own mu_annual.
import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/engine/commodity-base.js';
import { __test__ as shTest } from '../src/engine/short-horizon-vol.js';

const { resolveTwapMu } = __test__;

describe('resolveTwapMu', () => {
  it('passes raw mu through under the cap (lambda=1)', () => {
    expect(resolveTwapMu({ muRaw: 12, muClamped: 3, scale: 1, capAnnual: 50 })).toBe(12);
    expect(resolveTwapMu({ muRaw: -12, muClamped: -3, scale: 1, capAnnual: 50 })).toBe(-12);
  });

  it('clamps to +/-capAnnual on momentum blowups', () => {
    expect(resolveTwapMu({ muRaw: 400, scale: 1, capAnnual: 50 })).toBe(50);
    expect(resolveTwapMu({ muRaw: -400, scale: 1, capAnnual: 50 })).toBe(-50);
  });

  it('lambda shrinks before the clamp', () => {
    expect(resolveTwapMu({ muRaw: 40, scale: 0.5, capAnnual: 50 })).toBe(20);
    expect(resolveTwapMu({ muRaw: 200, scale: 0.5, capAnnual: 50 })).toBe(50);
  });

  it('falls back to the clamped mu when raw is absent (old buffer shape)', () => {
    expect(resolveTwapMu({ muRaw: undefined, muClamped: 2.5, scale: 1, capAnnual: 50 })).toBe(2.5);
  });

  it('degrades to 0 (pure vol model) when neither mu resolved', () => {
    expect(resolveTwapMu({ muRaw: null, muClamped: null, scale: 1, capAnnual: 50 })).toBe(0);
  });
});

describe('short-horizon buffer exposes raw mu alongside the capped one', () => {
  it('mu_annual stays inside +/-MU_CAP while mu_annual_raw carries real drift', () => {
    // 31 ticks, 10s apart, each +0.1% — a strong intra-hour momentum burst.
    const t0 = 1_753_600_000_000;
    const samples = [];
    let p = 60000;
    for (let i = 0; i < 31; i += 1) {
      samples.push({ price: p, ts: t0 + i * 10_000 });
      p *= 1.001;
    }
    const stats = shTest.computeFromSamples(samples, { now: t0 + 30 * 10_000 });
    expect(stats).not.toBeNull();
    expect(Math.abs(stats.mu_annual)).toBeLessThanOrEqual(shTest.MU_CAP);
    expect(stats.mu_annual_raw).toBeGreaterThan(shTest.MU_CAP);
    // and the TWAP resolver actually consumes the raw value (cap 50, lambda 1)
    expect(
      resolveTwapMu({ muRaw: stats.mu_annual_raw, muClamped: stats.mu_annual, scale: 1, capAnnual: 50 }),
    ).toBe(50);
  });
});
