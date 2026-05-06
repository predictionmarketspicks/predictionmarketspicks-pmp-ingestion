// World Cup shared helpers — locks the team/match/price helpers so the
// downstream feeds (kalshi/polymarket/odds-api/espn) can rely on stable
// entity_id resolution. Integration with live APIs is unit-tested per feed;
// here we only test the pure lookups + clamps.

import { describe, it, expect } from 'vitest';
import {
  lookupTeamByName,
  lookupTeamBySlug,
  lookupTeamByCode,
  lookupGroupMatchId,
  detectReachKind,
  americanOddsToImpliedPct,
  priceToCents,
  kalshiMarketUrl,
  polymarketMarketUrl,
} from '../src/feeds/wc-shared.js';

describe('lookupTeamByName', () => {
  it('matches canonical names', () => {
    expect(lookupTeamByName('Mexico')?.slug).toBe('mexico');
    expect(lookupTeamByName('England')?.slug).toBe('england');
  });

  it('matches aliases (USA, South Korea, Bosnia and Herzegovina)', () => {
    expect(lookupTeamByName('USA')?.slug).toBe('united-states');
    expect(lookupTeamByName('South Korea')?.slug).toBe('korea-republic');
    expect(lookupTeamByName('Bosnia and Herzegovina')?.slug).toBe('bosnia');
  });

  it('strips diacritics for Türkiye / Curaçao / Côte d\'Ivoire', () => {
    expect(lookupTeamByName('Türkiye')?.slug).toBe('turkiye');
    expect(lookupTeamByName('Turkey')?.slug).toBe('turkiye');
    expect(lookupTeamByName('Curaçao')?.slug).toBe('curacao');
    expect(lookupTeamByName("Côte d'Ivoire")?.slug).toBe('cote-divoire');
    expect(lookupTeamByName('Ivory Coast')?.slug).toBe('cote-divoire');
  });

  it('returns null for unknown names', () => {
    expect(lookupTeamByName('NotATeam')).toBeNull();
    expect(lookupTeamByName('')).toBeNull();
    expect(lookupTeamByName(null)).toBeNull();
  });
});

describe('lookupTeamBySlug / lookupTeamByCode', () => {
  it('round-trips slug↔code via the same record', () => {
    const a = lookupTeamBySlug('united-states');
    const b = lookupTeamByCode('USA');
    expect(a?.code).toBe('USA');
    expect(b?.slug).toBe('united-states');
  });

  it('uppercases code lookups', () => {
    expect(lookupTeamByCode('mex')?.slug).toBe('mexico');
  });
});

describe('lookupGroupMatchId', () => {
  it('returns canonical match_id for a known pair (home order)', () => {
    expect(lookupGroupMatchId('mexico', 'korea-republic')?.id).toBe(
      'match:A-MD1-MEX-KOR',
    );
  });

  it('returns the same match for the reversed pair', () => {
    expect(lookupGroupMatchId('korea-republic', 'mexico')?.id).toBe(
      'match:A-MD1-MEX-KOR',
    );
  });

  it('returns null for non-group-stage pairs', () => {
    expect(lookupGroupMatchId('france', 'panama')).toBeNull();
  });
});

describe('detectReachKind', () => {
  it('classifies "Round of 16", "Quarterfinals", "Semifinals", "Final"', () => {
    expect(detectReachKind('England to reach the Round of 16')).toBe('reach_r16');
    expect(detectReachKind('England to reach the Quarterfinals')).toBe('reach_qf');
    expect(detectReachKind('England to reach the Semi-finals')).toBe('reach_sf');
    expect(detectReachKind('England to reach the final')).toBe('reach_final');
  });

  it('returns null for non-round phrases', () => {
    expect(detectReachKind('England to win Group L')).toBeNull();
  });
});

describe('americanOddsToImpliedPct', () => {
  it('+700 → ~12.5%', () => {
    expect(Math.round(americanOddsToImpliedPct(+700))).toBe(13);
  });
  it('-200 → ~66.7%', () => {
    expect(Math.round(americanOddsToImpliedPct(-200))).toBe(67);
  });
  it('rejects 0 / NaN / non-number', () => {
    expect(americanOddsToImpliedPct(0)).toBeNull();
    expect(americanOddsToImpliedPct(NaN)).toBeNull();
    expect(americanOddsToImpliedPct('abc')).toBeNull();
  });
});

describe('priceToCents', () => {
  it('accepts 0..1 and 0..100 inputs', () => {
    expect(priceToCents(0.42)).toBe(42);
    expect(priceToCents(85)).toBe(85);
  });

  it('clamps very small probabilities to 1c lower bound', () => {
    expect(priceToCents(0.005)).toBe(1);
  });

  it('rejects values that round to 0 or 100', () => {
    expect(priceToCents(0.999)).toBeNull();
    expect(priceToCents(0)).toBeNull();
  });

  it('rejects non-finite input', () => {
    expect(priceToCents(null)).toBeNull();
    expect(priceToCents(NaN)).toBeNull();
  });
});

describe('kalshiMarketUrl', () => {
  it('keeps a 3-segment event ticker as-is', () => {
    expect(kalshiMarketUrl('KXMENWORLDCUP-26-FRA')).toBe(
      'https://kalshi.com/markets/KXMENWORLDCUP-26-FRA?referral=b07a96ab-4b91-4bdc-8285-5ae1927b7000&m=true',
    );
  });

  it('trims a 4+-segment market ticker to the 3-segment event level', () => {
    // Site routes only on event level; PredictionMarketsPicks/CLAUDE.md locks this.
    expect(kalshiMarketUrl('KXWCGAME-26FRASEN-FRA')).toBe(
      'https://kalshi.com/markets/KXWCGAME-26FRASEN-FRA?referral=b07a96ab-4b91-4bdc-8285-5ae1927b7000&m=true',
    );
  });

  it('returns null on empty input', () => {
    expect(kalshiMarketUrl(null)).toBeNull();
    expect(kalshiMarketUrl('')).toBeNull();
  });
});

describe('polymarketMarketUrl', () => {
  it('builds /market/<slug>', () => {
    expect(polymarketMarketUrl('will-france-win-the-2026-fifa-world-cup-924')).toBe(
      'https://polymarket.com/market/will-france-win-the-2026-fifa-world-cup-924',
    );
  });
});
