// External-benchmark feed normalizer tests (NFL grades/DVOA fusion Phase 1).
// Covers team resolution, string-number coercion, jsonb passthrough, intra-batch
// dedup, and the season-required guard. Pure normalizers — no Supabase needed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveTeamCode } from '../src/lib/nfl-teams.js';
import { resolveSeason, stagingAgeHours, isCapturedToday } from '../src/feeds/ext-shared.js';
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
    expect(resolveTeamCode('LA Rams')).toBe('LAR');
    expect(resolveTeamCode('Los Angeles Chargers')).toBe('LAC');
    expect(resolveTeamCode('KC')).toBe('KC'); // idempotent
    // LAR is canonical since 2026-08-05; legacy `LA` must still resolve to the
    // Rams (never to a bare code), and LAR must resolve to itself.
    expect(resolveTeamCode('LA')).toBe('LAR');
    expect(resolveTeamCode('LAR')).toBe('LAR');
    expect(resolveTeamCode('STL')).toBe('LAR');
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

// --- Reliability fixes, 2026-08-03 (handoffs/NFL_EXT_FEEDS_RELIABILITY_FIXES) ---

describe('ingested_at is written by every normalizer (§5)', () => {
  // The column's now() default fires on INSERT only, so an upsert that omits it
  // leaves the first-ever capture timestamp in place and the table reads stale
  // forever. Every feed must put it in the payload.
  const cases = [
    ['grades-team', () => normalizeTeamGrades([{ team: 'Chiefs', overall: '88.4' }], { season: 2025 })],
    ['grades-player', () => normalizePlayerGrades([{ name: 'Test QB', team: 'Chiefs', position: 'QB' }], { season: 2025 })],
    ['power-ranks', () => normalizePowerRanks([{ team: 'Chiefs', qb_rating: '90' }], { season: 2026 })],
    ['free-agency', () => normalizeFreeAgents([{ name: 'Test ED', position: 'ED' }], { season: 2026 })],
    ['dvoa-team', () => normalizeTeamDvoa([{ team: 'Chiefs', tot_dvoa: '24.1%' }], { season: 2025 })],
  ];
  it.each(cases)('%s stamps a fresh ISO timestamp', (_name, run) => {
    const before = Date.now();
    const { rows } = run();
    expect(rows[0].ingested_at).toEqual(expect.any(String));
    const stamped = Date.parse(rows[0].ingested_at);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('resolveSeason (§4)', () => {
  it('prefers the staging file over --season when they agree', () => {
    expect(resolveSeason('dvoa-team', 2025, 2025)).toBe(2025);
  });
  it('hard-errors when --season disagrees with the file', () => {
    // The 8/3 trap: --season=2025 applied across all feeds would have written
    // the 2026 power-ranks preseason projection into season 2025.
    expect(() => resolveSeason('power-ranks', 2025, 2026)).toThrow(/season mismatch/i);
    try {
      resolveSeason('power-ranks', 2025, 2026);
    } catch (err) {
      expect(err.code).toBe('SEASON_MISMATCH');
    }
  });
  it('falls back to --season when the file carries none', () => {
    expect(resolveSeason('dvoa-team', 2025, undefined)).toBe(2025);
  });
  it('uses the file season when no flag is passed', () => {
    expect(resolveSeason('free-agency', undefined, 2026)).toBe(2026);
  });
  it('throws when neither source supplies a season', () => {
    expect(() => resolveSeason('dvoa-team', undefined, undefined)).toThrow(/season is required/i);
  });
  it('treats a string file season as equal to a numeric flag', () => {
    expect(resolveSeason('dvoa-team', 2025, '2025')).toBe(2025);
  });
});

describe('stagingAgeHours (§3)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-staging-'));

  function write(name, ageHours) {
    const file = path.join(tmp, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ season: 2025, rows: [] }));
    if (ageHours) {
      const t = new Date(Date.now() - ageHours * 3_600_000);
      fs.utimesSync(file, t, t);
    }
    return file;
  }

  it('returns null for a file that does not exist', () => {
    expect(stagingAgeHours('nope', path.join(tmp, 'nope.json'))).toBeNull();
  });
  it('reads ~0 for a file just written', () => {
    // Can be a hair NEGATIVE — the filesystem's mtime occasionally lands a
    // fraction of a millisecond ahead of Date.now(). Harmless: the runner gates
    // on `age > limit`, so only a genuinely old file is ever blocked.
    const age = stagingAgeHours('fresh', write('fresh'));
    expect(Math.abs(age)).toBeLessThan(0.1);
  });
  it('measures a six-week-old fossil — the actual outage shape', () => {
    const age = stagingAgeHours('fossil', write('fossil', 42 * 24));
    expect(age).toBeCloseTo(1008, 0);
  });
});

describe('isCapturedToday — the DAY boundary, not a rolling window (§3)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-day-'));

  function writeAt(name, mtime) {
    const file = path.join(tmp, `${name}.json`);
    fs.writeFileSync(file, '[]');
    if (mtime) fs.utimesSync(file, mtime, mtime);
    return file;
  }

  it('returns null when the file does not exist', () => {
    expect(isCapturedToday('nope', path.join(tmp, 'nope.json'))).toBeNull();
  });

  it('counts a file written early THIS MORNING as fresh — the false positive a rolling window caused', () => {
    // The 8/3 regression in miniature: dvoa-team.json was captured at 02:09 and a
    // 60-minute (and a 6-hour) window both called it stale by evening. It was
    // that run's own file. Anything written since local midnight is fresh.
    const now = new Date(2026, 7, 3, 20, 45); // Aug 3, 20:45 local
    const morning = new Date(2026, 7, 3, 2, 9);
    expect(isCapturedToday('morning', writeAt('morning', morning), now)).toBe(true);
  });

  it('counts yesterday late-night as stale even though it is only hours old', () => {
    const now = new Date(2026, 7, 3, 0, 30); // 00:30, just after midnight
    const lastNight = new Date(2026, 7, 2, 23, 50); // 40 minutes earlier
    expect(isCapturedToday('lastnight', writeAt('lastnight', lastNight), now)).toBe(false);
  });

  it('flags the six-week fossil', () => {
    const now = new Date(2026, 7, 3, 11, 0);
    const june21 = new Date(2026, 5, 21, 19, 11);
    expect(isCapturedToday('fossil', writeAt('fossil', june21), now)).toBe(false);
  });
});
