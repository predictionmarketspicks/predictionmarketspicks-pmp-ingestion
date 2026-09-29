// keepUsMarket + the NFL two-outcome normalization, on REAL gateway payloads
// captured 2026-09-29 (test/fixtures/polymarket-us-markets-2026-09-29.json).
// Every expectation about side mapping below is checked against the captured
// book, never against a belief about field ordering — the 2026-08-07→08-21
// side inversion shipped because a fixture was authored from a belief.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  classifyUsMarket,
  keepUsMarket,
  kickoffMsOf,
  normalizeUsMarket,
  US_QUERIES,
} from '../src/feeds/polymarket-us.js';

const { markets: F } = JSON.parse(
  readFileSync(new URL('./fixtures/polymarket-us-markets-2026-09-29.json', import.meta.url), 'utf8'),
);
const clone = (m) => JSON.parse(JSON.stringify(m));

describe('keepUsMarket — each rule on a captured market', () => {
  const kept = {
    nfl_moneyline: 'nfl_game',
    nfl_spread: 'nfl_game',
    nfl_total: 'nfl_game',
    nfl_total_under_first: 'nfl_game',
    nfl_spread_no_book: 'nfl_game',
    nfl_future_champ: 'nfl_future',
    nfl_future_mvp: 'nfl_future',
    nfl_future_playoffq_no_first: 'nfl_future',
    nfl_future_win_total: 'nfl_future',
    politics_winner: 'politics',
    culture: 'culture',
    crypto: 'crypto',
    finance: 'finance',
  };
  for (const [name, kind] of Object.entries(kept)) {
    it(`keeps ${name} (${F[name].slug}) as ${kind}`, () => {
      expect(keepUsMarket(F[name])).toBe(true);
      expect(classifyUsMarket(F[name]).kind).toBe(kind);
    });
  }

  const dropped = {
    politics_vmc_bracket: 'politics_bracket',
    politics_vtc_turnout: 'politics_bracket',
    politics_cmovc_margin: 'politics_bracket',
    climate: 'category_climate',
    mlb_moneyline: 'sports_non_nfl',
    cfb_spread: 'sports_non_nfl', // football_team_full_game_spread is shared with college
    football_txs_crossleague: 'sports_non_nfl',
    nfl_team_total: 'nfl_period_or_team_total',
    nfl_first_half_spread: 'nfl_period_or_team_total',
    nfl_first_quarter_total: 'nfl_period_or_team_total',
    nfl_period_winner_prop: 'nfl_prop',
    nfl_player_prop: 'nfl_prop',
    nfl_future_player_stat_leader: 'nfl_future_player_prop',
    nfl_future_season_stat: 'nfl_future_player_prop',
    nfl_future_fantasy: 'nfl_future_player_prop',
  };
  for (const [name, rule] of Object.entries(dropped)) {
    it(`drops ${name} (${F[name].slug}) by ${rule}`, () => {
      expect(keepUsMarket(F[name])).toBe(false);
      expect(classifyUsMarket(F[name]).rule).toBe(rule);
    });
  }

  it('drops science and geopolitics by category', () => {
    expect(classifyUsMarket({ category: 'science', slug: 'x-1' }).rule).toBe('category_science');
    expect(classifyUsMarket({ category: 'geopolitics', slug: 'x-1' }).rule).toBe('category_geopolitics');
  });

  it('keeps technology and macro', () => {
    expect(keepUsMarket({ category: 'technology', slug: 'x-1' })).toBe(true);
    expect(keepUsMarket({ category: 'macro', slug: 'x-1' })).toBe(true);
  });

  it('keeps a teamless aachc- future only if a side names an NFL team', () => {
    const m = clone(F.nfl_future_win_total);
    expect(keepUsMarket(m)).toBe(true);
    for (const s of m.marketSides) s.team = null;
    expect(keepUsMarket(m)).toBe(false);
  });

  it('politics brackets are matched on the prefix, not anywhere in the slug', () => {
    expect(keepUsMarket({ category: 'politics', slug: 'ussewc-vmc-thing' })).toBe(true);
    expect(keepUsMarket({ category: 'politics', slug: 'cmovcusg-x' })).toBe(false);
  });

  it('never keeps junk', () => {
    expect(keepUsMarket(null)).toBe(false);
    expect(keepUsMarket({})).toBe(false);
  });
});

describe('server-side query groups', () => {
  it('asks only for the kept categories and the NFL tag', () => {
    expect(US_QUERIES.non_sports).not.toMatch(/sports|climate|science|geopolitics/);
    expect(US_QUERIES.nfl_games).toMatch(/^tagIds=1&/);
    expect(US_QUERIES.nfl_futures).toBe('tagIds=1&marketTypes=futures');
  });
});

describe('kickoffMsOf', () => {
  it('reads gameStartTime', () => {
    expect(kickoffMsOf(F.nfl_moneyline)).toBe(Date.parse('2026-10-02T00:15:00Z'));
  });
  it('falls back to the slug date', () => {
    const m = { ...F.nfl_moneyline, gameStartTime: null };
    expect(kickoffMsOf(m)).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });
});

describe('normalizeUsMarket — NFL two-outcome side mapping (captured payloads)', () => {
  it('moneyline: outcomes[0] is the long side, best_* is its book', () => {
    // Captured: Steelers long, price 0.58; Browns 0.425; book 0.575 / 0.58.
    const row = normalizeUsMarket(F.nfl_moneyline);
    expect(row.condition_id).toBe('pmus:919543');
    expect(row.best_bid).toBeCloseTo(0.575, 6);
    expect(row.best_ask).toBeCloseTo(0.58, 6);
    expect(row.last_trade_price).toBeCloseTo(0.58, 6);
    expect(row.outcomes).toEqual([
      { outcome: 'Steelers', price: 0.5775, team: 'pit' },
      { outcome: 'Browns', price: 0.4225, team: 'cle' },
    ]);
    expect(row.venue).toBe('us');
    expect(row.volume_24h_usdc).toBeNull();
  });

  it('spread: the team field says who lays the points', () => {
    const row = normalizeUsMarket(F.nfl_spread);
    expect(row.outcomes[0]).toMatchObject({ outcome: '-3.50', team: 'pit' });
    expect(row.outcomes[1]).toMatchObject({ outcome: '+3.50', team: 'cle' });
    expect(row.best_bid).toBeCloseTo(0.42, 6);
    expect(row.best_ask).toBeCloseTo(0.425, 6);
    expect(row.outcomes[0].price + row.outcomes[1].price).toBeCloseTo(1, 9);
  });

  it('total: Over is the long side', () => {
    const row = normalizeUsMarket(F.nfl_total);
    expect(row.outcomes.map((o) => o.outcome)).toEqual(['Over', 'Under']);
    expect(row.outcomes[0].team).toBeNull();
    expect(row.best_bid).toBeCloseTo(0.42, 6);
    expect(row.best_ask).toBeCloseTo(0.425, 6);
  });

  it('total listed ["Under","Over"]: outcomes[0] is STILL the long side (Over) — gateway order is not trusted', () => {
    // Captured tsc-nfl-buf-lar-2026-10-12-total-64pt5: outcomes ["Under","Over"],
    // long side Over @ 0.52, book 0.12 / 0.52 — the book brackets Over.
    expect(JSON.parse(F.nfl_total_under_first.outcomes)).toEqual(['Under', 'Over']);
    const row = normalizeUsMarket(F.nfl_total_under_first);
    expect(row.outcomes[0].outcome).toBe('Over');
    expect(row.best_bid).toBeCloseTo(0.12, 6);
    expect(row.best_ask).toBeCloseTo(0.52, 6);
    expect(row.outcomes[0].price).toBeCloseTo(0.32, 6);
  });

  it('flipped-book path: complements AND swaps when the book brackets the short side', () => {
    // Same captured moneyline with the book replaced by the Browns' book
    // (0.42 / 0.425 = 1 − 0.58 / 1 − 0.575). The long side's own price (0.58)
    // is the evidence; the row must still describe the Steelers.
    const m = clone(F.nfl_moneyline);
    m.bestBidQuote = { value: '0.4200', currency: 'USD' };
    m.bestAskQuote = { value: '0.4250', currency: 'USD' };
    const row = normalizeUsMarket(m);
    expect(row.outcomes[0].outcome).toBe('Steelers');
    expect(row.best_bid).toBeCloseTo(0.575, 6);
    expect(row.best_ask).toBeCloseTo(0.58, 6);
    expect(row.best_bid).toBeLessThanOrEqual(row.best_ask);
  });

  it('no book: prices null, row still written with its structure', () => {
    const row = normalizeUsMarket(F.nfl_spread_no_book);
    expect(row.best_bid).toBeNull();
    expect(row.best_ask).toBeNull();
    expect(row.outcomes.map((o) => o.price)).toEqual([null, null]);
    expect(row.outcomes[0].outcome).toBe('-1.50');
  });

  it('yes/no rows keep their existing shape (raw string outcomes, YES book)', () => {
    const row = normalizeUsMarket(F.nfl_future_playoffq_no_first);
    expect(row.outcomes).toEqual(['No', 'Yes']);
    const m = F.nfl_future_playoffq_no_first;
    const long = m.marketSides.find((s) => s.long);
    expect(long.description).toBe('Yes');
    expect(Number(long.price)).toBeGreaterThanOrEqual(row.best_bid - 0.01);
    expect(Number(long.price)).toBeLessThanOrEqual(row.best_ask + 0.01);
    expect(normalizeUsMarket(F.politics_winner).outcomes.every((o) => typeof o === 'string')).toBe(true);
  });

  it('refuses a team market whose sides do not name its outcomes', () => {
    const m = clone(F.nfl_moneyline);
    m.marketSides[1].description = 'Ravens';
    expect(normalizeUsMarket(m)).toBeNull();
    const two = clone(F.nfl_moneyline);
    two.marketSides[1].long = true;
    expect(normalizeUsMarket(two)).toBeNull();
    const none = clone(F.nfl_moneyline);
    none.marketSides[0].long = false;
    expect(normalizeUsMarket(none)).toBeNull();
  });

  it('never produces a crossed book on any captured fixture', () => {
    for (const m of Object.values(F)) {
      const row = normalizeUsMarket(m);
      if (row && row.best_bid != null && row.best_ask != null) {
        expect(row.best_bid).toBeLessThanOrEqual(row.best_ask);
      }
    }
  });
});
