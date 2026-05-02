// Comparator unit tests. The comparator has two surfaces:
//   - buildComparison(mapping, kalshiQuote, polyQuote) — pure function over a
//     single pair, no dedup.
//   - evaluateAll({ getKalshiQuote, getPolymarketYesQuote, now }) — runs every
//     mapping, applies dedup, returns the rows that should be written.

import { describe, it, expect, beforeEach } from 'vitest';

import { buildComparison, evaluateAll, _resetDedupState } from '../src/engine/comparator.js';
import { ARB_MAPPINGS } from '../src/engine/arb-mappings.js';
import { ARB_MIN_INTERVAL_PER_PAIR_MS } from '../src/engine/arb-thresholds.js';

const M0 = ARB_MAPPINGS[0];

describe('buildComparison', () => {
  it('returns ok=false when either side is missing', () => {
    expect(buildComparison(M0, null, { mid: 0.5 }).ok).toBe(false);
    expect(buildComparison(M0, { yesBid: 0.4, yesAsk: 0.42 }, null).ok).toBe(false);
  });

  it('uses Kalshi mid (yesBid+yesAsk)/2 when both quotes exist', () => {
    const cmp = buildComparison(
      M0,
      { yesBid: 0.4, yesAsk: 0.5 },
      { mid: 0.6 },
    );
    expect(cmp.ok).toBe(true);
    expect(cmp.price_a).toBe(0.45);
    expect(cmp.price_b).toBe(0.6);
  });

  it('falls back to Kalshi last_price (`price`) when no two-sided book', () => {
    const cmp = buildComparison(
      M0,
      { price: 0.7 },
      { mid: 0.5 },
    );
    expect(cmp.price_a).toBe(0.7);
  });

  it('classifies STRONG when |spread| ≥ 10pp', () => {
    const cmp = buildComparison(M0, { yesBid: 0.7, yesAsk: 0.72 }, { mid: 0.6 });
    // mid=0.71 vs poly=0.6 → spread=11pp
    expect(cmp.confidence).toBe('STRONG');
    expect(cmp.confidence_tier).toBe(3);
    expect(cmp.spread_pp).toBe(11);
    expect(cmp.direction).toBe('A_OVER_B');
  });

  it('classifies MODERATE when 7pp ≤ |spread| < 10pp', () => {
    const cmp = buildComparison(M0, { yesBid: 0.5, yesAsk: 0.5 }, { mid: 0.42 });
    expect(cmp.confidence).toBe('MODERATE');
    expect(cmp.confidence_tier).toBe(2);
    expect(cmp.spread_pp).toBe(8);
  });

  it('classifies SPECULATIVE when 5pp ≤ |spread| < 7pp', () => {
    const cmp = buildComparison(M0, { yesBid: 0.5, yesAsk: 0.5 }, { mid: 0.44 });
    expect(cmp.confidence).toBe('SPECULATIVE');
    expect(cmp.confidence_tier).toBe(1);
    expect(cmp.spread_pp).toBe(6);
  });

  it('classifies NO_EDGE when |spread| < 5pp', () => {
    const cmp = buildComparison(M0, { yesBid: 0.5, yesAsk: 0.5 }, { mid: 0.48 });
    expect(cmp.confidence).toBe('NO_EDGE');
    expect(cmp.confidence_tier).toBe(0);
  });

  it('reports B_OVER_A when Polymarket prices YES higher than Kalshi', () => {
    const cmp = buildComparison(M0, { yesBid: 0.4, yesAsk: 0.4 }, { mid: 0.55 });
    expect(cmp.direction).toBe('B_OVER_A');
    expect(cmp.spread_pp).toBe(-15);
  });
});

describe('evaluateAll', () => {
  beforeEach(() => {
    _resetDedupState();
  });

  it('skips pairs with NO_EDGE classification', () => {
    const writes = evaluateAll({
      getKalshiQuote: () => ({ yesBid: 0.5, yesAsk: 0.5 }),
      getPolymarketYesQuote: () => ({ mid: 0.49 }),
      now: 1_000_000,
    });
    expect(writes).toHaveLength(0);
  });

  it('returns one row per mapping when all cross threshold', () => {
    const writes = evaluateAll({
      getKalshiQuote: () => ({ yesBid: 0.6, yesAsk: 0.6 }),
      getPolymarketYesQuote: () => ({ mid: 0.45 }),
      now: 1_000_000,
    });
    expect(writes.length).toBe(ARB_MAPPINGS.length);
    expect(writes.every((w) => w.confidence === 'STRONG')).toBe(true);
  });

  it('per-pair dedup suppresses repeat writes within ARB_MIN_INTERVAL_PER_PAIR_MS', () => {
    const t0 = 1_000_000;
    const first = evaluateAll({
      getKalshiQuote: () => ({ yesBid: 0.6, yesAsk: 0.6 }),
      getPolymarketYesQuote: () => ({ mid: 0.45 }),
      now: t0,
    });
    expect(first.length).toBe(ARB_MAPPINGS.length);

    // Same prices, only 1s later — dedup suppresses.
    const second = evaluateAll({
      getKalshiQuote: () => ({ yesBid: 0.6, yesAsk: 0.6 }),
      getPolymarketYesQuote: () => ({ mid: 0.45 }),
      now: t0 + 1000,
    });
    expect(second).toHaveLength(0);

    // Past the interval — writes resume.
    const third = evaluateAll({
      getKalshiQuote: () => ({ yesBid: 0.6, yesAsk: 0.6 }),
      getPolymarketYesQuote: () => ({ mid: 0.45 }),
      now: t0 + ARB_MIN_INTERVAL_PER_PAIR_MS + 1,
    });
    expect(third.length).toBe(ARB_MAPPINGS.length);
  });

  it('tier flip bypasses dedup even within the interval', () => {
    const t0 = 1_000_000;
    evaluateAll({
      getKalshiQuote: () => ({ yesBid: 0.55, yesAsk: 0.55 }),
      getPolymarketYesQuote: () => ({ mid: 0.49 }),
      now: t0,
    }); // 6pp → SPECULATIVE
    const flipped = evaluateAll({
      getKalshiQuote: () => ({ yesBid: 0.7, yesAsk: 0.7 }),
      getPolymarketYesQuote: () => ({ mid: 0.55 }),
      now: t0 + 1000,
    }); // 15pp → STRONG, tier changed → bypass dedup
    expect(flipped.length).toBe(ARB_MAPPINGS.length);
    expect(flipped[0].confidence).toBe('STRONG');
  });
});
