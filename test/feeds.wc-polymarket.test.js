// Polymarket WC question classifier tests. Locks the question→entity_id+
// kind mapping so the WC carry from PR 4 mispricing reads stable joins.

import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/feeds/wc-polymarket.js';

const { classifyPolymarketQuestion, nameToSlug, yesPriceFromMarket } = __test__;

describe('classifyPolymarketQuestion — champion', () => {
  it('"Will France win the 2026 FIFA World Cup?" → team:france champion', () => {
    expect(classifyPolymarketQuestion('Will France win the 2026 FIFA World Cup?')).toEqual({
      entity_id: 'team:france',
      kind: 'champion',
    });
  });
  it('handles "win the World Cup" without 2026 / FIFA', () => {
    expect(classifyPolymarketQuestion('Will Brazil win the World Cup?')).toEqual({
      entity_id: 'team:brazil',
      kind: 'champion',
    });
  });
});

describe('classifyPolymarketQuestion — group_winner', () => {
  it('"Will Spain win Group H?" → team:spain group_winner', () => {
    expect(classifyPolymarketQuestion('Will Spain win Group H?')).toEqual({
      entity_id: 'team:spain',
      kind: 'group_winner',
    });
  });
});

describe('classifyPolymarketQuestion — reach_*', () => {
  it('"Will England reach the Quarterfinals?" → reach_qf', () => {
    expect(classifyPolymarketQuestion('Will England reach the Quarterfinals?')).toEqual({
      entity_id: 'team:england',
      kind: 'reach_qf',
    });
  });
  it('handles all four rounds', () => {
    expect(classifyPolymarketQuestion('Will France reach the Round of 16?')?.kind).toBe('reach_r16');
    expect(classifyPolymarketQuestion('Will France reach the Semifinals?')?.kind).toBe('reach_sf');
    expect(classifyPolymarketQuestion('Will France reach the final?')?.kind).toBe('reach_final');
  });
});

describe('classifyPolymarketQuestion — match', () => {
  it('"Will France beat Senegal?" → match home', () => {
    expect(classifyPolymarketQuestion('Will France beat Senegal?')).toEqual({
      entity_id: 'match:I-MD1-FRA-SEN',
      kind: 'match_winner_home',
    });
  });
  it('returns null for knockout-only pairs', () => {
    expect(classifyPolymarketQuestion('Will Brazil beat Argentina?')).toBeNull();
  });
});

describe('classifyPolymarketQuestion — golden boot', () => {
  it('"Will Kylian Mbappé win the Golden Boot?" → player_*  golden_boot', () => {
    const r = classifyPolymarketQuestion('Will Kylian Mbappé win the Golden Boot?');
    expect(r?.kind).toBe('golden_boot');
    expect(r?.entity_id?.startsWith('player:')).toBe(true);
  });
});

describe('classifyPolymarketQuestion — fallthrough', () => {
  it('returns null for unrelated questions', () => {
    expect(classifyPolymarketQuestion('Will it rain in Lagos tomorrow?')).toBeNull();
    expect(classifyPolymarketQuestion('')).toBeNull();
    expect(classifyPolymarketQuestion(null)).toBeNull();
  });
});

describe('nameToSlug', () => {
  it('lowercases + hyphenates', () => {
    expect(nameToSlug('Kylian Mbappe')).toBe('kylian-mbappe');
  });
  it('strips diacritics', () => {
    expect(nameToSlug('Kylian Mbappé')).toBe('kylian-mbappe');
  });
  it('returns null for short slugs', () => {
    expect(nameToSlug('a')).toBeNull();
  });
});

describe('yesPriceFromMarket', () => {
  it('prefers Yes outcome from outcomes array', () => {
    expect(
      yesPriceFromMarket({
        outcomes: [
          { outcome: 'Yes', price: 0.42 },
          { outcome: 'No', price: 0.58 },
        ],
      }),
    ).toBe(0.42);
  });
  it('falls back to best_ask', () => {
    expect(yesPriceFromMarket({ best_ask: 0.5 })).toBe(0.5);
  });
  it('returns null when no field is present', () => {
    expect(yesPriceFromMarket({})).toBeNull();
  });
});
