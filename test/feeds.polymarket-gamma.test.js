// Polymarket Gamma fetcher helper tests — locks the normalize/parse shape so
// future "let's switch to Number()" or "let's drop the array-string parse"
// refactors don't silently break the upsert (typed JSONB + NUMERIC columns
// would reject coerced garbage).
//
// Integration with Gamma REST is exercised by the engine's
// runPolymarketSnapshotOnce() at /dev/poly post-deploy; here we only unit-test
// the pure helpers.

import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/feeds/polymarket-gamma.js';

const { normalizeMarket, parseTags, parseOutcomes, parseTimestamp, toNumOrNull, keepSportsGameRow } =
  __test__;

// Minimal Gamma market builder for the sports-game filter tests.
function gameMarket({ slug, vol = 50000 }) {
  return {
    conditionId: `0x${slug}`,
    slug,
    question: 'A vs. B',
    tags: [{ slug: 'sports' }, { slug: 'games' }],
    volume24hr: vol,
    outcomes: '["A","B"]',
    outcomePrices: '["0.5","0.5"]',
  };
}

describe('toNumOrNull', () => {
  it('returns null for null/undefined/garbage (NUMERIC column is nullable)', () => {
    expect(toNumOrNull(null)).toBeNull();
    expect(toNumOrNull(undefined)).toBeNull();
    expect(toNumOrNull('abc')).toBeNull();
    expect(toNumOrNull(NaN)).toBeNull();
  });

  it('preserves numeric values incl 0 (do not collapse 0 → null)', () => {
    expect(toNumOrNull(0)).toBe(0);
    expect(toNumOrNull('0')).toBe(0);
    expect(toNumOrNull(0.4523)).toBe(0.4523);
    expect(toNumOrNull('0.4523')).toBe(0.4523);
  });
});

describe('parseTags', () => {
  it('returns null for non-array input (column is nullable)', () => {
    expect(parseTags(null)).toBeNull();
    expect(parseTags(undefined)).toBeNull();
    expect(parseTags('sports')).toBeNull();
  });

  it('extracts slugs from object-shaped tags ({id,label,slug})', () => {
    expect(
      parseTags([
        { id: '1', label: 'Sports', slug: 'sports' },
        { id: '2', label: 'NFL', slug: 'nfl' },
      ]),
    ).toEqual(['sports', 'nfl']);
  });

  it('falls back to label if slug missing', () => {
    expect(parseTags([{ id: '1', label: 'World' }])).toEqual(['World']);
  });

  it('passes through string-shaped tags (alternate Gamma route)', () => {
    expect(parseTags(['sports', 'nfl'])).toEqual(['sports', 'nfl']);
  });

  it('returns null for empty array (consistent with "no tags")', () => {
    expect(parseTags([])).toBeNull();
  });
});

describe('parseOutcomes', () => {
  it('returns null when outcomes missing', () => {
    expect(parseOutcomes({})).toBeNull();
    expect(parseOutcomes({ outcomes: null })).toBeNull();
  });

  it('parses parallel JSON-string arrays into objects', () => {
    const m = {
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.42","0.58"]',
      clobTokenIds: '["tok-yes","tok-no"]',
    };
    expect(parseOutcomes(m)).toEqual([
      { outcome: 'Yes', price: 0.42, token_id: 'tok-yes' },
      { outcome: 'No', price: 0.58, token_id: 'tok-no' },
    ]);
  });

  it('handles outcomes-only (multi-outcome market with no published prices yet)', () => {
    const m = { outcomes: '["A","B","C"]' };
    expect(parseOutcomes(m)).toEqual([
      { outcome: 'A', price: null, token_id: null },
      { outcome: 'B', price: null, token_id: null },
      { outcome: 'C', price: null, token_id: null },
    ]);
  });

  it('accepts native arrays (non-string Gamma response shape)', () => {
    expect(
      parseOutcomes({
        outcomes: ['Yes', 'No'],
        outcomePrices: [0.5, 0.5],
        clobTokenIds: ['a', 'b'],
      }),
    ).toEqual([
      { outcome: 'Yes', price: 0.5, token_id: 'a' },
      { outcome: 'No', price: 0.5, token_id: 'b' },
    ]);
  });

  it('returns null on malformed JSON string (do not throw — log-then-skip)', () => {
    expect(parseOutcomes({ outcomes: '{not json}' })).toBeNull();
  });
});

describe('parseTimestamp', () => {
  it('returns null for null/undefined/non-string', () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp(123)).toBeNull();
  });

  it('round-trips ISO strings', () => {
    expect(parseTimestamp('2026-05-04T12:34:56Z')).toBe('2026-05-04T12:34:56.000Z');
  });

  it('returns null on unparseable strings (TIMESTAMPTZ would reject)', () => {
    expect(parseTimestamp('not a date')).toBeNull();
  });
});

describe('normalizeMarket', () => {
  it('returns null when condition_id or slug missing (NOT NULL columns)', () => {
    expect(normalizeMarket(null)).toBeNull();
    expect(normalizeMarket({})).toBeNull();
    expect(normalizeMarket({ conditionId: '0xabc' })).toBeNull();
    expect(normalizeMarket({ slug: 'foo' })).toBeNull();
  });

  it('maps a full Gamma market response to the table row shape', () => {
    const m = {
      conditionId: '0xabc',
      slug: 'will-x-happen',
      question: 'Will X happen?',
      category: 'Politics',
      tags: [{ id: '1', label: 'Politics', slug: 'politics' }],
      bestBid: 0.42,
      bestAsk: 0.45,
      lastTradePrice: 0.43,
      volume24hr: 12345.67,
      volume: 999999,
      liquidity: 5000,
      openInterest: 250000,
      startDate: '2026-05-01T00:00:00Z',
      endDate: '2026-12-31T23:59:59Z',
      active: true,
      closed: false,
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.43","0.57"]',
      clobTokenIds: '["tok-y","tok-n"]',
    };
    const row = normalizeMarket(m);
    expect(row).toEqual({
      condition_id: '0xabc',
      slug: 'will-x-happen',
      question: 'Will X happen?',
      // 2026-05-15: category now derived from tags via pickCategory(); slug
      // wins over Gamma's free-form `category` string.
      category: 'politics',
      tags: ['politics'],
      best_bid: 0.42,
      best_ask: 0.45,
      last_trade_price: 0.43,
      volume_24h_usdc: 12345.67,
      volume_total_usdc: 999999,
      liquidity_usdc: 5000,
      open_interest_usdc: 250000,
      start_date: '2026-05-01T00:00:00.000Z',
      end_date: '2026-12-31T23:59:59.000Z',
      active: true,
      closed: false,
      outcomes: [
        { outcome: 'Yes', price: 0.43, token_id: 'tok-y' },
        { outcome: 'No', price: 0.57, token_id: 'tok-n' },
      ],
    });
  });

  it('falls back to volumeNum when volume24hr missing (Gamma field rename safety)', () => {
    const row = normalizeMarket({
      conditionId: '0xabc',
      slug: 'foo',
      volumeNum: 42,
    });
    expect(row.volume_24h_usdc).toBe(42);
  });

  it('preserves null on missing optional fields rather than coercing to 0', () => {
    const row = normalizeMarket({ conditionId: '0xabc', slug: 'foo' });
    expect(row.best_bid).toBeNull();
    expect(row.best_ask).toBeNull();
    expect(row.volume_24h_usdc).toBeNull();
    expect(row.tags).toBeNull();
    expect(row.outcomes).toBeNull();
  });
});

describe('keepSportsGameRow — daily game coverage + noise gate', () => {
  it('keeps a dated arb-league game above the floor, forces category=sports', () => {
    const row = keepSportsGameRow(gameMarket({ slug: 'mlb-tor-bal-2026-05-31', vol: 50000 }), 2000);
    expect(row).not.toBeNull();
    expect(row.slug).toBe('mlb-tor-bal-2026-05-31');
    expect(row.category).toBe('sports'); // overrides whatever pickCategory derived
    expect(row.volume_24h_usdc).toBe(50000);
  });

  it('keeps NBA / NHL / NFL / WC dated games', () => {
    for (const slug of [
      'nba-bos-nyk-2026-06-02',
      'nhl-edm-fla-2026-06-04',
      'nfl-kc-buf-2026-09-13',
      'fifwc-usa-mex-2026-06-11',
    ]) {
      expect(keepSportsGameRow(gameMarket({ slug }), 2000), slug).not.toBeNull();
    }
  });

  it('rejects futures/props with no trailing date (the false-match hole)', () => {
    for (const slug of [
      'will-arizona-cardinals-win-the-2027-nfl-nfc-championship-199',
      'mlb-world-series-champion-2026',
      'pro-baseball-2026-al-mvp',
      'new-mlb-cba-by-dec-1',
    ]) {
      expect(keepSportsGameRow(gameMarket({ slug }), 2000), slug).toBeNull();
    }
  });

  it('rejects dated games from non-arb leagues (tennis/esports/cricket)', () => {
    for (const slug of [
      'atp-djokovic-alcaraz-2026-05-31',
      'lol-t1-geng-2026-05-31',
      'cs2-navi-faze-2026-05-31',
      'crict20blast-x-y-2026-05-31',
    ]) {
      expect(keepSportsGameRow(gameMarket({ slug }), 2000), slug).toBeNull();
    }
  });

  it('enforces the volume floor (thin market that would post a fake edge)', () => {
    expect(keepSportsGameRow(gameMarket({ slug: 'mlb-tor-bal-2026-05-31', vol: 1999 }), 2000)).toBeNull();
    expect(keepSportsGameRow(gameMarket({ slug: 'mlb-tor-bal-2026-05-31', vol: 2000 }), 2000)).not.toBeNull();
  });

  it('rejects rows missing identity fields (NOT NULL columns)', () => {
    expect(keepSportsGameRow({ slug: 'mlb-tor-bal-2026-05-31', volume24hr: 50000 }, 2000)).toBeNull(); // no conditionId
    expect(keepSportsGameRow(null, 2000)).toBeNull();
  });
});
