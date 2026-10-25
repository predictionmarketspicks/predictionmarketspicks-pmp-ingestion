// §5.8.6 keep-list (prediction-marketspicks/handoffs/POLYMARKET_US_COVERAGE_2026-10-25.md):
// NBA/NHL/CFB/UFC game lines, league futures, EPL/UCL 3-way, daily weather — and
// every player prop / period line / team total still OUT. REAL gateway payloads
// captured 2026-10-25 (test/fixtures/polymarket-us-markets-2026-10-25.json).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyUsMarket, keepUsMarket, normalizeUsMarket, US_QUERIES } from '../src/feeds/polymarket-us.js';
import { HOURLY_GROUPS } from '../src/engine/polymarket-us-snapshot.js';

const { markets: F } = JSON.parse(
  readFileSync(new URL('./fixtures/polymarket-us-markets-2026-10-25.json', import.meta.url), 'utf8'),
);

describe('§5.8.6 kept families', () => {
  const kept = {
    nba_moneyline: 'league_game',
    nba_spread: 'league_game',
    nba_total: 'league_game',
    nba_future_champ: 'league_future',
    nhl_moneyline: 'league_game',
    nhl_spread: 'league_game',
    nhl_total: 'league_game',
    nhl_future_cup: 'league_future',
    cfb_moneyline: 'league_game',
    cfb_total: 'league_game',
    cfb_future_champ: 'league_future',
    ufc_moneyline: 'league_game',
    epl_3way: 'soccer_3way',
    ucl_3way: 'soccer_3way',
    epl_future_title: 'league_future',
    weather_nyc_high: 'weather',
  };
  for (const [name, kind] of Object.entries(kept)) {
    it(`keeps ${name} (${F[name].slug}) as ${kind}`, () => {
      expect(classifyUsMarket(F[name])).toEqual({ keep: true, kind });
    });
  }
});

describe('§5.8.6 still dropped: props, period lines, team totals, other futures, other weather', () => {
  const dropped = {
    nba_player_prop: 'league_period_prop_or_future',
    nba_team_total: 'league_period_prop_or_future',
    nba_first_half_spread: 'league_period_prop_or_future',
    nba_future_bestrecord: 'league_period_prop_or_future',
    nhl_first_period_total: 'league_period_prop_or_future',
    nhl_player_goals: 'league_period_prop_or_future',
    cfb_first_half_spread: 'league_period_prop_or_future',
    epl_exact_score: 'league_period_prop_or_future',
    epl_player_goals: 'league_period_prop_or_future',
    weather_monthly: 'category_climate',
    weather_rain: 'category_climate',
  };
  for (const [name, rule] of Object.entries(dropped)) {
    it(`drops ${name} (${F[name].slug}) by ${rule}`, () => {
      expect(keepUsMarket(F[name])).toBe(false);
      expect(classifyUsMarket(F[name]).rule).toBe(rule);
    });
  }

  it('the prefix must match the market type (an aec- spread or a tec- prop is not kept)', () => {
    expect(keepUsMarket({ ...F.nba_spread, slug: F.nba_spread.slug.replace(/^asc-/, 'aec-') })).toBe(false);
    expect(keepUsMarket({ ...F.nba_future_champ, slug: F.nba_future_champ.slug.replace(/^tec-/, 'astatc-') })).toBe(false);
  });

  it('a league outside the list stays out (UCL futures, MLS, UFC futures)', () => {
    expect(classifyUsMarket({ ...F.epl_future_title, slug: 'tec-ucl-final-2026-06-05-w-shd' }).rule).toBe('league_period_prop_or_future');
    expect(classifyUsMarket({ ...F.epl_3way, slug: 'atc-mls-mia-lafc-2026-10-25-mia' }).rule).toBe('sports_non_nfl');
    expect(keepUsMarket({ ...F.nba_future_champ, slug: 'tec-ufc-lightw-2026-12-31-champ-x' })).toBe(false);
  });
});

describe('§5.8.6 rows normalize on the long side', () => {
  for (const name of ['nba_moneyline', 'nba_spread', 'nba_total', 'nhl_moneyline', 'nhl_spread', 'nhl_total', 'cfb_moneyline', 'cfb_total', 'ufc_moneyline']) {
    it(`${name}: two-outcome team shape, outcomes[0] is the long side, book not crossed`, () => {
      const m = F[name];
      const row = normalizeUsMarket(m);
      expect(row).not.toBeNull();
      const long = m.marketSides.find((s) => s.long === true);
      expect(row.outcomes[0].outcome).toBe(long.description);
      if (row.best_bid != null && row.best_ask != null) {
        expect(row.best_bid).toBeLessThanOrEqual(row.best_ask);
        expect(Number(long.price)).toBeGreaterThanOrEqual(row.best_bid - 0.01);
        expect(Number(long.price)).toBeLessThanOrEqual(row.best_ask + 0.01);
      }
    });
  }
  for (const name of ['nba_future_champ', 'nhl_future_cup', 'cfb_future_champ', 'epl_future_title', 'epl_3way', 'ucl_3way', 'weather_nyc_high']) {
    it(`${name}: yes/no shape, the book is the YES book`, () => {
      const row = normalizeUsMarket(F[name]);
      expect(row).not.toBeNull();
      expect(row.outcomes.every((o) => typeof o === 'string')).toBe(true);
      expect(row.venue).toBe('us');
    });
  }
});

describe('§5.8.6 query groups', () => {
  it('league tags only (nba 5, cfb 6, nhl 7, ufc 9, epl 17, ucl 18) — never all of sports', () => {
    for (const g of ['league_games', 'league_futures', 'soccer_3way']) {
      expect(US_QUERIES[g]).toMatch(/^tagIds=\d+/);
      expect(US_QUERIES[g]).not.toMatch(/categories=sports/);
      expect(US_QUERIES[g]).not.toMatch(/marketTypes=props/);
    }
    expect(US_QUERIES.weather).toBe('categories=climate');
  });
  it('every new group is fetched hourly, not every tick', () => {
    for (const g of ['league_games', 'league_futures', 'soccer_3way', 'weather']) expect(HOURLY_GROUPS).toContain(g);
    for (const g of HOURLY_GROUPS) expect(US_QUERIES[g]).toBeTruthy();
    expect(HOURLY_GROUPS).not.toContain('nfl_games');
  });
});
