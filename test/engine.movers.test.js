// Movers selection logic — pure-function tests (no Kalshi I/O).
// Mirrors the filter/score behavior of the Edge Function it replaces. If
// these change, the engine + Edge Function will diverge during the soak.

import { describe, it, expect } from 'vitest';
import {
  applyFilters,
  selectTop,
  score,
  alertKey,
  moverTier,
  VOL_MIN,
  DELTA_MIN_PP,
  PRICE_MIN_C,
  PRICE_MAX_C,
} from '../src/engine/movers.js';

function makeCandidate(overrides = {}) {
  return {
    source: 'kalshi',
    seriesOrSlug: 'KXFED',
    ticker: 'KXFED-26MAY-001',
    title: 'Will the Fed cut by 25bp in May?',
    yes_price: 42,
    volume_24h: 12_500,
    price_change_24h: 5,
    category: 'Economics',
    ...overrides,
  };
}

describe('applyFilters', () => {
  it('drops below-volume markets', () => {
    const out = applyFilters([
      makeCandidate({ volume_24h: VOL_MIN - 1 }),
      makeCandidate({ volume_24h: VOL_MIN + 1 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].volume_24h).toBe(VOL_MIN + 1);
  });

  it('drops below-delta markets', () => {
    const out = applyFilters([
      makeCandidate({ price_change_24h: DELTA_MIN_PP - 1 }),
      makeCandidate({ price_change_24h: -(DELTA_MIN_PP - 1) }),
      makeCandidate({ price_change_24h: -(DELTA_MIN_PP + 1) }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].price_change_24h).toBe(-(DELTA_MIN_PP + 1));
  });

  it('drops out-of-range prices', () => {
    const out = applyFilters([
      makeCandidate({ yes_price: PRICE_MIN_C - 1 }),
      makeCandidate({ yes_price: PRICE_MAX_C + 1 }),
      makeCandidate({ yes_price: 50 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].yes_price).toBe(50);
  });

  it('drops KXNFL when sportsRestricted=true', () => {
    const out = applyFilters(
      [
        makeCandidate({ ticker: 'KXNFLMVP-26-MAHOMES' }),
        makeCandidate({ ticker: 'KXFED-26MAY-001' }),
      ],
      { sportsRestricted: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0].ticker).toBe('KXFED-26MAY-001');
  });

  it('keeps KXNFL when sportsRestricted=false', () => {
    const out = applyFilters(
      [
        makeCandidate({ ticker: 'KXNFLMVP-26-MAHOMES' }),
        makeCandidate({ ticker: 'KXFED-26MAY-001' }),
      ],
      { sportsRestricted: false },
    );
    expect(out).toHaveLength(2);
  });

  it('isTest=true bypasses volume + delta filters', () => {
    const out = applyFilters(
      [makeCandidate({ volume_24h: 0, price_change_24h: 0 })],
      { isTest: true },
    );
    expect(out).toHaveLength(1);
  });

  it('isTest=true does NOT bypass price-range filter', () => {
    const out = applyFilters(
      [makeCandidate({ yes_price: 99 })],
      { isTest: true },
    );
    expect(out).toHaveLength(0);
  });
});

describe('score', () => {
  it('weights delta and volume together', () => {
    const big = makeCandidate({ price_change_24h: 10, volume_24h: 100_000 });
    const small = makeCandidate({ price_change_24h: 4, volume_24h: 600 });
    expect(score(big)).toBeGreaterThan(score(small));
  });

  it('clamps log10 to volume_24h>=10 to avoid -Infinity on zero-vol markets', () => {
    const zero = makeCandidate({ price_change_24h: 8, volume_24h: 0 });
    expect(Number.isFinite(score(zero))).toBe(true);
  });
});

describe('selectTop', () => {
  it('returns up to 5 gainers + 5 losers, sorted by score desc', () => {
    const candidates = [
      ...Array.from({ length: 7 }, (_, i) =>
        makeCandidate({
          ticker: `KX-G-${i}`,
          title: `gainer ${i}`,
          price_change_24h: 4 + i,
          volume_24h: 1_000 * (i + 1),
        }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        makeCandidate({
          ticker: `KX-L-${i}`,
          title: `loser ${i}`,
          price_change_24h: -(3 + i),
          volume_24h: 1_000 * (i + 1),
        }),
      ),
    ];
    const { gainers, losers } = selectTop(candidates);
    expect(gainers).toHaveLength(5);
    expect(losers).toHaveLength(5);
    expect(score(gainers[0])).toBeGreaterThanOrEqual(score(gainers[4]));
    expect(score(losers[0])).toBeGreaterThanOrEqual(score(losers[4]));
  });

  it('isTest=true caps at 2 gainers + 1 loser', () => {
    const candidates = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate({ title: `g${i}`, price_change_24h: 4 + i, volume_24h: 1000 }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate({ title: `l${i}`, price_change_24h: -(4 + i), volume_24h: 1000 }),
      ),
    ];
    const { gainers, losers } = selectTop(candidates, { isTest: true });
    expect(gainers).toHaveLength(2);
    expect(losers).toHaveLength(1);
  });
});

describe('alertKey', () => {
  it('matches the Edge Function key shape', () => {
    const c = makeCandidate({ title: 'Will the Fed CUT by 25bp in May 2026?!' });
    expect(alertKey(c)).toBe('market_movers:will the fed cut by 25bp in may 2026');
  });

  it('caps title at 60 chars to keep alert_key reasonable', () => {
    const c = makeCandidate({ title: 'a'.repeat(120) });
    expect(alertKey(c)).toBe(`market_movers:${'a'.repeat(60)}`);
  });
});

describe('moverTier', () => {
  it('STRONG=3 at 8pp+, MODERATE=2 at 5–8pp, SPECULATIVE=1 below 5pp', () => {
    expect(moverTier(10)).toBe(3);
    expect(moverTier(8)).toBe(3);
    expect(moverTier(7)).toBe(2);
    expect(moverTier(5)).toBe(2);
    expect(moverTier(4)).toBe(1);
    expect(moverTier(0)).toBe(1);
  });
});
