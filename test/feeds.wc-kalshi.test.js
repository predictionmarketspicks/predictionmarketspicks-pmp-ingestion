// Kalshi WC parser unit tests. Locks the title→entity_id+kind mapping so
// silent regressions don't drop entire series. Live REST is exercised by the
// /dev/wc handler post-deploy; this file only tests the pure parsers.

import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/feeds/wc-kalshi.js';

const {
  parseChampionMarket,
  parseGroupWinMarket,
  parseReachRoundMarket,
  parseGameMarket,
  parseSquadMarket,
  playerSlugFromText,
  readYesPriceCents,
} = __test__;

describe('parseChampionMarket', () => {
  it('"Will France win the 2026 FIFA World Cup?" → team:france champion', () => {
    expect(
      parseChampionMarket({
        title: 'Will France win the 2026 FIFA World Cup?',
        subtitle: 'France',
      }),
    ).toEqual({ entity_id: 'team:france', kind: 'champion' });
  });

  it('returns null when team is unrecognized', () => {
    expect(parseChampionMarket({ title: 'Will Atlantis win the 2026 FIFA World Cup?', subtitle: 'Atlantis' })).toBeNull();
  });

  it('returns null when title doesn\'t mention world cup', () => {
    expect(parseChampionMarket({ title: 'Will France win the Euro?', subtitle: 'France' })).toBeNull();
  });
});

describe('parseGroupWinMarket', () => {
  it('"Spain to win Group H" → team:spain group_winner', () => {
    expect(parseGroupWinMarket({ title: 'Spain to win Group H', subtitle: 'Spain' })).toEqual({
      entity_id: 'team:spain',
      kind: 'group_winner',
    });
  });

  it('falls back to title parse when subtitle is empty', () => {
    expect(parseGroupWinMarket({ title: 'Will Brazil win Group C?', subtitle: '' })).toEqual({
      entity_id: 'team:brazil',
      kind: 'group_winner',
    });
  });
});

describe('parseReachRoundMarket', () => {
  it('"England to reach the Quarterfinals" → reach_qf', () => {
    expect(parseReachRoundMarket({ title: 'England to reach the Quarterfinals', subtitle: 'England' })).toEqual({
      entity_id: 'team:england',
      kind: 'reach_qf',
    });
  });

  it('handles all four rounds', () => {
    expect(parseReachRoundMarket({ title: 'France to reach the Round of 16', subtitle: 'France' })?.kind).toBe('reach_r16');
    expect(parseReachRoundMarket({ title: 'France to reach the Semifinals', subtitle: 'France' })?.kind).toBe('reach_sf');
    expect(parseReachRoundMarket({ title: 'France to reach the final', subtitle: 'France' })?.kind).toBe('reach_final');
  });

  it('returns null when round cannot be detected', () => {
    expect(parseReachRoundMarket({ title: 'France to win Group I', subtitle: 'France' })).toBeNull();
  });
});

describe('parseGameMarket', () => {
  it('"France vs Senegal — France wins" → match home', () => {
    expect(
      parseGameMarket({ title: 'France vs Senegal — France wins', subtitle: 'France' }),
    ).toEqual({ entity_id: 'match:I-MD1-FRA-SEN', kind: 'match_winner_home' });
  });

  it('subtitle="Draw" → match_winner_draw', () => {
    expect(
      parseGameMarket({ title: 'Mexico vs Korea Republic', subtitle: 'Draw' }),
    ).toEqual({ entity_id: 'match:A-MD1-MEX-KOR', kind: 'match_winner_draw' });
  });

  it('"over 2.5" anywhere in text → match_o25', () => {
    expect(
      parseGameMarket({ title: 'Brazil vs Morocco over 2.5 goals', subtitle: 'Over 2.5' }),
    ).toEqual({ entity_id: 'match:C-MD1-BRA-MOR', kind: 'match_o25' });
  });

  it('"both teams to score" → match_btts', () => {
    expect(
      parseGameMarket({ title: 'Spain vs Uruguay — both teams to score', subtitle: 'Yes' }),
    ).toEqual({ entity_id: 'match:H-MD1-ESP-URU', kind: 'match_btts' });
  });

  it('reverse pair order resolves to the same match', () => {
    expect(
      parseGameMarket({ title: 'Senegal vs France — France wins', subtitle: 'France' })?.entity_id,
    ).toBe('match:I-MD1-FRA-SEN');
  });

  it('returns null for non-group-stage pairs', () => {
    expect(parseGameMarket({ title: 'Brazil vs Argentina', subtitle: 'Brazil' })).toBeNull();
  });
});

describe('parseSquadMarket', () => {
  it('"Kylian Mbappé to win Golden Boot" → golden_boot', () => {
    const r = parseSquadMarket({ title: 'Kylian Mbappé to win Golden Boot', subtitle: 'Kylian Mbappé' });
    expect(r?.kind).toBe('golden_boot');
    expect(r?.entity_id?.startsWith('player:')).toBe(true);
  });

  it('"Harry Kane to score in any match" → player_anytime_scorer', () => {
    const r = parseSquadMarket({ title: 'Harry Kane to score in any World Cup match', subtitle: 'Harry Kane' });
    expect(r?.kind).toBe('player_anytime_scorer');
  });
});

describe('playerSlugFromText', () => {
  it('lowercases and hyphenates names', () => {
    expect(playerSlugFromText('Kylian Mbappe')).toBe('kylian-mbappe');
  });
  it('drops marketing fluff before slugifying', () => {
    expect(playerSlugFromText('Harry Kane Top Scorer')).toBe('harry-kane');
  });
  it('returns null for too-short slugs', () => {
    expect(playerSlugFromText('A')).toBeNull();
  });
});

describe('readYesPriceCents', () => {
  it('prefers yes_ask_dollars (string-cents shape)', () => {
    expect(readYesPriceCents({ yes_ask_dollars: '0.42', yes_bid_dollars: '0.40' })).toBe(42);
  });
  it('falls back to yes_bid then last_price', () => {
    expect(readYesPriceCents({ yes_bid_dollars: '0.55' })).toBe(55);
    expect(readYesPriceCents({ last_price_dollars: '0.78' })).toBe(78);
  });
  it('handles legacy numeric fields', () => {
    expect(readYesPriceCents({ yes_ask: 33 })).toBe(33);
  });
  it('returns null when nothing is in 1..99 band', () => {
    expect(readYesPriceCents({ yes_ask_dollars: '1.00' })).toBeNull();
    expect(readYesPriceCents({})).toBeNull();
  });
});
