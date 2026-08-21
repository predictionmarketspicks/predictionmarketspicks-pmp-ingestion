import { describe, it, expect } from 'vitest';
import {
  normalizeUsMarket,
  parseJsonArray,
  POLY_US_CATEGORY_ALLOWLIST,
} from '../src/feeds/polymarket-us.js';

// Fixtures are REAL shapes captured from gateway.polymarket.us on 2026-08-04.
// The two orderings below are the whole reason this file exists: the gateway
// quotes its book on outcome index 0, and index 0 is "Yes" on only ~57% of
// markets (113 of 200 sampled). Mapping the book straight through would invert
// the price on the other ~43% and manufacture ~100-point phantom arb gaps.

const YES_FIRST = {
  id: '25901',
  slug: 'world-series-champion-xyz',
  question: 'World Series Champion',
  category: 'politics',
  active: true,
  closed: false,
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.075","0.928"]',
  marketSides: [
    { long: true, price: '0.075', description: 'Yes' },
    { long: false, price: '0.928', description: 'No' },
  ],
  bestBidQuote: { value: '0.0720', currency: 'USD' },
  bestAskQuote: { value: '0.0750', currency: 'USD' },
  startDate: '2026-03-07T02:30:00Z',
  endDate: '2026-11-03T13:00:00Z',
};

// ⚠️ CAPTURED, NOT AUTHORED. This is `ewc-usgub-ia-2026-11-03-dem` as the gateway
// actually served it on 2026-08-21, and the shape is the whole point: `outcomes`
// lists No first, and `outcomePrices` is NOT reordered to match — index 0 still
// holds the YES price, which is what the book brackets and what marketSides'
// long leg confirms.
//
// The fixture this replaced had the same shape and the opposite expectation:
// hand-written from the belief that No-first meant the book described NO, it
// asserted the complement was correct. It passed for seventeen days while every
// ["No","Yes"] row in production was stored inverted. A fixture invented from a
// belief can only ever confirm it — capture the payload.
const NO_FIRST = {
  ...YES_FIRST,
  id: '25902',
  slug: 'ewc-usgub-ia-2026-11-03-dem',
  outcomes: '["No","Yes"]',
  outcomePrices: '["0.7800","0.23"]',
  marketSides: [
    { long: true, price: '0.7800', description: 'Yes' },
    { long: false, price: '0.23', description: 'No' },
  ],
  bestBidQuote: { value: '0.7700', currency: 'USD' },
  bestAskQuote: { value: '0.7800', currency: 'USD' },
};

// A market whose book genuinely describes the other side. Its own long-side
// price is the evidence, so it flips — and it is the ONLY thing that makes it flip.
const GENUINELY_INVERTED = {
  ...YES_FIRST,
  id: '25903',
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.872","0.129"]',
  marketSides: [
    { long: true, price: '0.872', description: 'Yes' },
    { long: false, price: '0.129', description: 'No' },
  ],
  bestBidQuote: { value: '0.1280', currency: 'USD' },
  bestAskQuote: { value: '0.1290', currency: 'USD' },
};

describe('parseJsonArray', () => {
  it('parses the JSON-encoded string the gateway actually sends', () => {
    expect(parseJsonArray('["Yes","No"]')).toEqual(['Yes', 'No']);
  });
  it('passes a real array through', () => {
    expect(parseJsonArray(['Yes', 'No'])).toEqual(['Yes', 'No']);
  });
  it('returns null rather than throwing on junk', () => {
    expect(parseJsonArray('not json')).toBeNull();
    expect(parseJsonArray(null)).toBeNull();
  });
});

describe('normalizeUsMarket — YES normalisation', () => {
  it('maps the book straight through when outcome 0 is Yes', () => {
    const row = normalizeUsMarket(YES_FIRST);
    expect(row.best_bid).toBeCloseTo(0.072, 6);
    expect(row.best_ask).toBeCloseTo(0.075, 6);
    expect(row.last_trade_price).toBeCloseTo(0.075, 6); // outcomePrices[yesIdx=0]
  });

  it('does NOT complement merely because outcomes lists No first', () => {
    const row = normalizeUsMarket(NO_FIRST);
    // The book is already the YES book. Complementing here is what stored the
    // Iowa Democrat market at 0.22/0.23 against a real 0.77/0.78.
    expect(row.best_bid).toBeCloseTo(0.77, 6);
    expect(row.best_ask).toBeCloseTo(0.78, 6);
    expect(row.last_trade_price).toBeCloseTo(0.78, 6);
  });

  it('regression: the old ordering rule would have inverted that row', () => {
    const row = normalizeUsMarket(NO_FIRST);
    expect(row.best_ask).not.toBeCloseTo(1 - 0.77, 6);
    expect(row.best_bid).not.toBeCloseTo(1 - 0.78, 6);
  });

  it('COMPLEMENTS AND SWAPS when the market’s own long-side price says the book is the other side', () => {
    const row = normalizeUsMarket(GENUINELY_INVERTED);
    expect(row.best_bid).toBeCloseTo(1 - 0.129, 6); // 0.871
    expect(row.best_ask).toBeCloseTo(1 - 0.128, 6); // 0.872
    expect(row.last_trade_price).toBeCloseTo(0.872, 6);
  });

  it('never produces a crossed book in either ordering', () => {
    for (const fixture of [YES_FIRST, NO_FIRST]) {
      const row = normalizeUsMarket(fixture);
      expect(row.best_bid).toBeLessThanOrEqual(row.best_ask);
    }
  });

  it('puts both orderings on the SAME side of 50c — the actual bug guard', () => {
    // A naive mapping would report the No-first market at ~13c and the
    // Yes-first at ~7c, i.e. both cheap, hiding that one is an 87c favourite.
    const yesFirst = normalizeUsMarket(YES_FIRST);
    const noFirst = normalizeUsMarket(NO_FIRST);
    expect(yesFirst.best_ask).toBeLessThan(0.5); // genuine longshot
    expect(noFirst.best_bid).toBeGreaterThan(0.5); // genuine favourite
  });
});

describe('normalizeUsMarket — honesty + shape', () => {
  it('writes NULL, never 0, for the volume fields the gateway does not publish', () => {
    const row = normalizeUsMarket(YES_FIRST);
    for (const k of [
      'volume_24h_usdc',
      'volume_total_usdc',
      'liquidity_usdc',
      'open_interest_usdc',
    ]) {
      expect(row[k]).toBeNull();
    }
  });

  it('tags every row with venue=us', () => {
    expect(normalizeUsMarket(YES_FIRST).venue).toBe('us');
  });

  it('namespaces condition_id so it cannot collide with an international one', () => {
    expect(normalizeUsMarket(YES_FIRST).condition_id).toBe('pmus:25901');
  });

  it('tolerates a one-sided book', () => {
    const row = normalizeUsMarket({ ...YES_FIRST, bestBidQuote: null });
    expect(row.best_bid).toBeNull();
    expect(row.best_ask).toBeCloseTo(0.075, 6);
  });

  it('leaves a one-sided book alone — there is nothing to check it against', () => {
    // The side check needs both quotes to test containment, so a half-book is
    // passed through as YES rather than guessed at. Skipping beats inventing.
    const row = normalizeUsMarket({ ...NO_FIRST, bestBidQuote: null });
    expect(row.best_bid).toBeNull();
    expect(row.best_ask).toBeCloseTo(0.78, 6);
  });

  it('skips rather than guesses on non-binary or unparseable outcomes', () => {
    expect(normalizeUsMarket({ ...YES_FIRST, outcomes: '["A","B","C"]' })).toBeNull();
    expect(normalizeUsMarket({ ...YES_FIRST, marketSides: [] })).not.toBeNull();
    expect(normalizeUsMarket({ ...YES_FIRST, outcomes: '["Chargers","Titans"]' })).toBeNull();
    expect(normalizeUsMarket({ ...YES_FIRST, outcomes: 'garbage' })).toBeNull();
    expect(normalizeUsMarket({ ...YES_FIRST, slug: null })).toBeNull();
    expect(normalizeUsMarket(null)).toBeNull();
  });
});

describe('category allowlist', () => {
  it('excludes sports — 7,382 of 8,500 live markets, the flood case', () => {
    expect(POLY_US_CATEGORY_ALLOWLIST).not.toContain('sports');
  });
});
