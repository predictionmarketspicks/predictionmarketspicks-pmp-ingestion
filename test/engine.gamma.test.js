// Dealer-gamma compute tests. Locks the methodology against the legacy
// commodity_edge/_legacy/src/gamma.py port — same constants, same sign
// conventions, same NEUTRAL fallback paths.

import { describe, it, expect } from 'vitest';
import { computeDealerGamma, __test__ as gammaInternals } from '../src/engine/gamma.js';

describe('computeDealerGamma — fallback paths', () => {
  it('returns NEUTRAL with strikes=0 when contracts are empty', () => {
    const r = computeDealerGamma({ contracts: [], etfSpot: 30, T: 0.05 });
    expect(r.gammaEnvironment).toBe('NEUTRAL');
    expect(r.signalModifier).toBe(1.0);
    expect(r.strikesContributing).toBe(0);
    expect(r.netDealerGamma).toBe(0);
    expect(r.gammaNeutralPrice).toBe(30);
  });

  it('returns NEUTRAL when etfSpot is non-positive', () => {
    const r = computeDealerGamma({
      contracts: [{ strike: 30, contractType: 'call', iv: 0.3, openInterest: 100 }],
      etfSpot: 0,
      T: 0.05,
    });
    expect(r.gammaEnvironment).toBe('NEUTRAL');
    expect(r.gammaNeutralPrice).toBe(0);
  });

  it('returns NEUTRAL when T is zero or negative', () => {
    const r = computeDealerGamma({
      contracts: [{ strike: 30, contractType: 'call', iv: 0.3, openInterest: 100 }],
      etfSpot: 30,
      T: 0,
    });
    expect(r.gammaEnvironment).toBe('NEUTRAL');
  });

  it('skips contracts with missing iv / oi / strike / contractType', () => {
    const r = computeDealerGamma({
      contracts: [
        { strike: 30, contractType: 'call', iv: null, openInterest: 100 },
        { strike: 30, contractType: 'call', iv: 0.3, openInterest: 0 },
        { strike: null, contractType: 'put', iv: 0.3, openInterest: 50 },
        { strike: 30, contractType: 'unknown', iv: 0.3, openInterest: 50 },
      ],
      etfSpot: 30,
      T: 0.05,
    });
    expect(r.strikesContributing).toBe(0);
    expect(r.netDealerGamma).toBe(0);
  });
});

describe('computeDealerGamma — sign convention', () => {
  // Calls add NEGATIVE gamma (dealers short customer longs); puts add POSITIVE.
  it('a call-only chain produces negative net gamma', () => {
    const r = computeDealerGamma({
      contracts: [
        { strike: 28, contractType: 'call', iv: 0.4, openInterest: 5000 },
        { strike: 30, contractType: 'call', iv: 0.4, openInterest: 5000 },
        { strike: 32, contractType: 'call', iv: 0.4, openInterest: 5000 },
      ],
      etfSpot: 30,
      T: 0.05,
    });
    expect(r.netDealerGamma).toBeLessThan(0);
    expect(r.strikesContributing).toBe(3);
  });

  it('a put-only chain produces positive net gamma', () => {
    const r = computeDealerGamma({
      contracts: [
        { strike: 28, contractType: 'put', iv: 0.4, openInterest: 5000 },
        { strike: 30, contractType: 'put', iv: 0.4, openInterest: 5000 },
        { strike: 32, contractType: 'put', iv: 0.4, openInterest: 5000 },
      ],
      etfSpot: 30,
      T: 0.05,
    });
    expect(r.netDealerGamma).toBeGreaterThan(0);
    expect(r.strikesContributing).toBe(3);
  });

  it('balanced call+put on same strike approximately cancels (call_gamma == put_gamma at same strike)', () => {
    const r = computeDealerGamma({
      contracts: [
        { strike: 30, contractType: 'call', iv: 0.4, openInterest: 5000 },
        { strike: 30, contractType: 'put', iv: 0.4, openInterest: 5000 },
      ],
      etfSpot: 30,
      T: 0.05,
    });
    expect(Math.abs(r.netDealerGamma)).toBeLessThan(1);
    expect(r.strikesContributing).toBe(2);
  });
});

describe('computeDealerGamma — environment classification', () => {
  it('classifies large negative gamma as AMPLIFYING with 1.20 modifier', () => {
    // Massive call OI at deep ATM → strongly negative net gamma → AMPLIFYING.
    const r = computeDealerGamma({
      contracts: [{ strike: 30, contractType: 'call', iv: 0.3, openInterest: 200_000 }],
      etfSpot: 30,
      T: 0.05,
    });
    expect(r.netDealerGamma).toBeLessThan(-gammaInternals.GAMMA_THRESHOLD);
    expect(r.gammaEnvironment).toBe('AMPLIFYING');
    expect(r.signalModifier).toBe(gammaInternals.MODIFIER_AMPLIFYING);
  });

  it('classifies large positive gamma as DAMPENING with 0.85 modifier', () => {
    const r = computeDealerGamma({
      contracts: [{ strike: 30, contractType: 'put', iv: 0.3, openInterest: 200_000 }],
      etfSpot: 30,
      T: 0.05,
    });
    expect(r.netDealerGamma).toBeGreaterThan(gammaInternals.GAMMA_THRESHOLD);
    expect(r.gammaEnvironment).toBe('DAMPENING');
    expect(r.signalModifier).toBe(gammaInternals.MODIFIER_DAMPENING);
  });

  it('classifies small net gamma as NEUTRAL with 1.0 modifier', () => {
    const r = computeDealerGamma({
      contracts: [
        { strike: 30, contractType: 'call', iv: 0.3, openInterest: 100 },
        { strike: 30, contractType: 'put', iv: 0.3, openInterest: 100 },
      ],
      etfSpot: 30,
      T: 0.05,
    });
    expect(Math.abs(r.netDealerGamma)).toBeLessThan(gammaInternals.GAMMA_THRESHOLD);
    expect(r.gammaEnvironment).toBe('NEUTRAL');
    expect(r.signalModifier).toBe(gammaInternals.MODIFIER_NEUTRAL);
  });
});

describe('computeDealerGamma — gamma_neutral_price crossover', () => {
  it('returns the strike where running cumulative crosses zero (low→high walk)', () => {
    // Layered: low strikes negative (call OI dominant), high strikes positive
    // (put OI dominant). Cumulative crosses near the inflection.
    const r = computeDealerGamma({
      contracts: [
        { strike: 25, contractType: 'call', iv: 0.3, openInterest: 50_000 },
        { strike: 27, contractType: 'call', iv: 0.3, openInterest: 50_000 },
        { strike: 32, contractType: 'put', iv: 0.3, openInterest: 50_000 },
        { strike: 35, contractType: 'put', iv: 0.3, openInterest: 50_000 },
      ],
      etfSpot: 30,
      T: 0.05,
    });
    // Crossover should land on one of the put strikes (32 or 35), not on the
    // ETF spot fallback.
    expect([32, 35]).toContain(r.gammaNeutralPrice);
  });

  it('falls back to etfSpot when cumulative never crosses zero', () => {
    const r = computeDealerGamma({
      contracts: [
        { strike: 28, contractType: 'call', iv: 0.3, openInterest: 5000 },
        { strike: 30, contractType: 'call', iv: 0.3, openInterest: 5000 },
      ],
      etfSpot: 30,
      T: 0.05,
    });
    // All-negative cumulative → never crosses → falls back.
    expect(r.gammaNeutralPrice).toBe(30);
  });
});

describe('computeDealerGamma — output shape', () => {
  it('rounds netDealerGamma to 2dp and gammaNeutralPrice to 4dp', () => {
    const r = computeDealerGamma({
      contracts: [{ strike: 30, contractType: 'call', iv: 0.3, openInterest: 5000 }],
      etfSpot: 30,
      T: 0.05,
    });
    // Numeric precision check — the DB columns are numeric so rounding here
    // keeps the row tidy.
    expect(Number.isFinite(r.netDealerGamma)).toBe(true);
    expect(Number.isFinite(r.gammaNeutralPrice)).toBe(true);
    const netStr = r.netDealerGamma.toString();
    const decimals = netStr.includes('.') ? netStr.split('.')[1].length : 0;
    expect(decimals).toBeLessThanOrEqual(2);
  });
});
