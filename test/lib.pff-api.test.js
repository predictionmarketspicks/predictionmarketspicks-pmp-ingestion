// PFF Developer API client tests (migration commit 621d3fe, 2026-09-09).
// Nothing covered src/lib/pff-api.js or scripts/capture-pff-api.js before this
// file — their only verification was one manual run written up in
// handoffs/NFL_EXT_FEEDS_PFF_API_MIGRATION_2026-09-09.md. This covers the
// highest-risk piece: the binary-search week resolution and the week-union
// query builder that exist specifically because the unfiltered season
// aggregate is preseason-inclusive (see the header comments in
// src/lib/pff-api.js) — that gap is what wrote 804 preseason rows into
// ext_team_grades/ext_player_grades(season=2026) before this logic existed.
// Also covers pffGet's 429 retry/backoff and error mapping, previously untested.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  pffGet,
  packedHeightToFeetInches,
  ageFromBirthDate,
  regWeekUnion,
  lastGradedRegWeek,
  NFL_REG_WEEKS,
} from '../src/lib/pff-api.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const h = {
    'x-ratelimit-remaining': null,
    'x-ratelimit-reset': null,
    'retry-after': null,
    ...headers,
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

describe('regWeekUnion — the only query form the API actually honors (§2b)', () => {
  it('builds a comma-joined 1..N list', () => {
    expect(regWeekUnion(1)).toBe('1');
    expect(regWeekUnion(4)).toBe('1,2,3,4');
    expect(regWeekUnion(18)).toBe('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18');
  });
});

describe('packedHeightToFeetInches', () => {
  it('unpacks feet*100+inches', () => {
    expect(packedHeightToFeetInches(603)).toBe('6-3');
    expect(packedHeightToFeetInches(511)).toBe('5-11');
  });
  it('returns null for missing input', () => {
    expect(packedHeightToFeetInches(null)).toBeNull();
    expect(packedHeightToFeetInches(undefined)).toBeNull();
  });
});

describe('ageFromBirthDate', () => {
  it('computes whole years as of a given date', () => {
    expect(ageFromBirthDate('1996-03-15', new Date('2026-09-09'))).toBe(30);
  });
  it('has not had this year\'s birthday yet', () => {
    expect(ageFromBirthDate('1996-12-25', new Date('2026-09-09'))).toBe(29);
  });
  it('counts the birthday itself', () => {
    expect(ageFromBirthDate('1996-09-09', new Date('2026-09-09'))).toBe(30);
  });
  it('returns null for missing or invalid input', () => {
    expect(ageFromBirthDate(null)).toBeNull();
    expect(ageFromBirthDate('not-a-date')).toBeNull();
  });
});

describe('pffGet (§2b client)', () => {
  beforeEach(() => {
    process.env.PFF_API_KEY = 'test-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PFF_API_KEY;
  });

  it('throws if PFF_API_KEY is not set', async () => {
    delete process.env.PFF_API_KEY;
    await expect(pffGet('/v1/auth/whoami')).rejects.toThrow(/PFF_API_KEY is not set/);
  });

  it('sends the bearer token and returns the parsed body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ entitled: true, tier: 'pro' }));
    vi.stubGlobal('fetch', fetchMock);
    const body = await pffGet('/v1/auth/whoami');
    expect(body).toEqual({ entitled: true, tier: 'pro' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.pff.com/v1/auth/whoami',
      expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } }),
    );
  });

  it('retries once on 429 honoring Retry-After, then returns the retried result', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ error: { code: 'rate_limited' } }, { status: 429, headers: { 'retry-after': '1' } });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const body = await pffGet('/v1/teams/overview');
    expect(body).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('throws a pointed error carrying the vendor status/code/request_id on a non-429 failure', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'not entitled', request_id: 'req_1' } }, { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(pffGet('/v1/teams/overview')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      requestId: 'req_1',
    });
  });
});

describe('lastGradedRegWeek — the preseason-contamination guard (§2b)', () => {
  beforeEach(() => {
    process.env.PFF_API_KEY = 'test-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PFF_API_KEY;
  });

  // Mirrors PFF's actual monotone has_stats behavior: weeks up to gradedThrough
  // are fully graded, everything after is not.
  function mockSeasonGradedThrough(gradedThrough) {
    return vi.fn(async (url) => {
      const week = Number(new URL(url).searchParams.get('week'));
      return jsonResponse({ games: [{ has_stats: week <= gradedThrough }] });
    });
  }

  it('returns 0 before week 1 is graded — the exact pre-kickoff case that produced the 2026-09-09 incident', async () => {
    const fetchMock = mockSeasonGradedThrough(0);
    vi.stubGlobal('fetch', fetchMock);
    expect(await lastGradedRegWeek(2026)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // short-circuits on week 1, no binary search needed
  });

  it('returns 18 (NFL_REG_WEEKS) when the full regular season is graded', async () => {
    const fetchMock = mockSeasonGradedThrough(18);
    vi.stubGlobal('fetch', fetchMock);
    expect(await lastGradedRegWeek(2025)).toBe(NFL_REG_WEEKS);
  });

  it('finds a mid-season boundary by binary search in well under 18 calls', async () => {
    const fetchMock = mockSeasonGradedThrough(10);
    vi.stubGlobal('fetch', fetchMock);
    expect(await lastGradedRegWeek(2026)).toBe(10);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('finds week 1 as the boundary when only week 1 is graded', async () => {
    const fetchMock = mockSeasonGradedThrough(1);
    vi.stubGlobal('fetch', fetchMock);
    expect(await lastGradedRegWeek(2026)).toBe(1);
  });
});
