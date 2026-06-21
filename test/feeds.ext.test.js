// External-benchmark feed normalizer tests (NFL grades/DVOA fusion Phase 1).
// Covers team resolution, string-number coercion, jsonb passthrough, intra-batch
// dedup, and the season-required guard. Pure normalizers — no Supabase needed.

import { describe, it, expect } from 'vitest';
import { resolveTeamCode } from '../src/lib/nfl-teams.js';
import { num, int, pct, dollars, bool, playerSlug } from '../src/lib/ext-parse.js';
import { normalizeTeamGrades } from '../src/feeds/grades-team.js';
import { normalizePlayerGrades } from '../src/feeds/grades-player.js';
import { normalizePowerRanks } from '../src/feeds/power-ranks.js';
import { normalizeFreeAgents } from '../src/feeds/free-agency.js';
import { normalizeTeamDvoa } from '../src/feeds/dvoa-team.js';

describe('resolveTeamCode', () => {
  it('maps names, cities, nicknames, abbrevs to gridiron codes', () => {
    expect(resolveTeamCode('Kansas City Chiefs')).toBe('KC');
    expect(resolveTeamCode('chiefs')).toBe('KC');
    expect(resolveTeamCode('San Francisco 49ers')).toBe('SF');
    expect(resolveTeamCode('niners')).toBe('SF');
    expect(resolveTeamCode('Washington Commanders')).toBe('WAS');
    expect(resolveTeamCode('Washington Football Team')).toBe('WAS');
    expect(resolveTeamCode('LA Rams')).toBe('LA');
    expect(resolveTeamCode('Los Angeles Chargers')).toBe('LAC');
    expect(resolveTeamCode('KC')).toBe('KC'); // idempotent
  });
  it('returns null for unresolved input', () => {
    expect(resolveTeamCode('London Jaguars Practice Squad')).toBeNull();
    expect(resolveTeamCode('')).toBeNull();
    expect(resolveTeamCode(null)).toBeNull();
  });
});

describe('ext-parse coercion', () => {
  it('num strips $ , %', () => {
    expect(num('18.2%')).toBe(18.2);
    expect(num('$1,250,000')).toBe(1250000);
    expect(num('—')).toBeNull();
    expect(num('N/A')).toBeNull();
  });
  it('int pulls first integer run', () => {
    expect(int('11th')).toBe(11);
    expect(int('R2')).toBe(2);
    expect(int('-3')).toBe(-3);
    expect(int('')).toBeNull();
  });
  it('pct returns a fraction', () => {
    expect(pct('62%')).toBeCloseTo(0.62);
    expect(pct('0.62')).toBeCloseTo(0.62);
    expect(pct(null)).toBeNull();
  });
  it('dollars handles M/K/B suffixes', () => {
    expect(dollars('$12.5M')).toBe(12500000);
    expect(dollars('900K')).toBe(900000);
    expect(dollars('$1.2B')).toBe(1200000000);
  });
  it('bool reads flag cells', () => {
    expect(bool('Y')).toBe(true);
    expect(bool('N')).toBe(false);
    expect(bool('')).toBeNull();
  });
  it('playerSlug is stable + url-safe', () => {
    expect(playerSlug('Patrick Mahomes', 'KC', 'QB')).toBe('patrick-mahomes-kc-qb');
  });
});

describe('normalizeTeamGrades', () => {
  it('coerces grades, resolves team, defaults week_scope', () => {
    const { rows, dropped } = normalizeTeamGrades(
      [{ team: 'Chiefs', overall: '88.4', def: '81.2', pf: '465' }],
      { season: 2025 },
    );
    expect(dropped).toHaveLength(0);
    expect(rows[0]).toMatchObject({ season: 2025, team: 'KC', week_scope: 'REGPO', overall: 88.4, def: 81.2, pf: 465 });
  });
  it('drops unresolved teams', () => {
    const { rows, dropped } = normalizeTeamGrades([{ team: 'Mars Rovers', overall: 50 }], { season: 2025 });
    expect(rows).toHaveLength(0);
    expect(dropped).toEqual(['Mars Rovers']);
  });
});

describe('normalizePlayerGrades', () => {
  it('builds synthetic id, passes jsonb, coerces flag', () => {
    const { rows } = normalizePlayerGrades(
      [{ name: 'Test QB', team: 'Chiefs', position: 'QB', war: '4.6', rs: 'N', snaps: { off: 1120 } }],
      { season: 2025 },
    );
    expect(rows[0]).toMatchObject({
      player_id: 'test-qb-kc-qb',
      team: 'KC',
      war: 4.6,
      rs_flag: false,
      week: 0,
      snaps: { off: 1120 },
    });
  });
  it('drops rows missing name or position', () => {
    const { rows, dropped } = normalizePlayerGrades([{ team: 'Chiefs', position: 'QB' }], { season: 2025 });
    expect(rows).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });
  it('collapses intra-batch dupes on the unique key', () => {
    const dup = { name: 'Test QB', team: 'Chiefs', position: 'QB' };
    const { rows } = normalizePlayerGrades([dup, { ...dup }], { season: 2025 });
    expect(rows).toHaveLength(1);
  });
});

describe('normalizePowerRanks', () => {
  it('stores probabilities as fractions', () => {
    const { rows } = normalizePowerRanks(
      [{ team: 'Chiefs', point_spread_rating: '5.7', win_super_bowl_pct: '14%' }],
      { season: 2025 },
    );
    expect(rows[0]).toMatchObject({ team: 'KC', point_spread_rating: 5.7, win_super_bowl_pct: 0.14 });
  });
});

describe('normalizeFreeAgents', () => {
  it('resolves from/to, parses contracts, keeps history array', () => {
    const { rows } = normalizeFreeAgents(
      [{
        name: 'Test ED', position: 'ED', status: 'Signed',
        team_from: 'Bengals', team_to: 'Titans',
        contract_avg_yr: '$22.5M', war: '1.8', war_rank: '11',
        history: [{ season: 2025, war: 1.8 }],
      }],
      { season: 2026 },
    );
    expect(rows[0]).toMatchObject({
      season: 2026,
      player_id: 'test-ed-cin-ed',
      team_from: 'CIN',
      team_to: 'TEN',
      contract_avg_yr: 22500000,
      war: 1.8,
      war_rank: 11,
    });
    expect(rows[0].history).toHaveLength(1);
  });
  it('keeps unsigned players with null destination', () => {
    const { rows } = normalizeFreeAgents(
      [{ name: 'Test FA', position: 'WR', status: 'Unsigned' }],
      { season: 2026 },
    );
    expect(rows[0].team_to).toBeNull();
    expect(rows[0].status).toBe('Unsigned');
  });
});

describe('normalizeTeamDvoa', () => {
  it('stores DVOA/VOA as fractions incl. negatives, keeps variance', () => {
    const { rows } = normalizeTeamDvoa(
      [{ team: 'Chiefs', tot_dvoa: '24.1%', def_dvoa: '-9.4%', tot_dvoa_rank: '2', variance: '4.8%', variance_rank: '9' }],
      { season: 2025 },
    );
    expect(rows[0]).toMatchObject({ team: 'KC', tot_dvoa_rank: 2, variance_rank: 9 });
    expect(rows[0].tot_dvoa).toBeCloseTo(0.241);
    expect(rows[0].def_dvoa).toBeCloseTo(-0.094);
    expect(rows[0].variance).toBeCloseTo(0.048);
  });
});
