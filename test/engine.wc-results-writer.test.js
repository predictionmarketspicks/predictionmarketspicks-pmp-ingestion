// Result autofeed (handoffs/WC_RESULT_AUTOFEED_2026-06-18.md) — Phase 2/3.
// Locks the FT filter, the debounce (newlySettled diff), the upsert row shape,
// and the dispatch no-op-without-token guard. DB + GitHub network are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the supabase delivery layer the writer imports.
const upsertWcResults = vi.fn(async (rows) => ({ count: rows.length }));
const fetchExistingWcFtIds = vi.fn(async () => new Set());
vi.mock('../src/delivery/supabase.js', () => ({
  upsertWcResults: (...a) => upsertWcResults(...a),
  fetchExistingWcFtIds: (...a) => fetchExistingWcFtIds(...a),
}));

const { persistWcFtResults, dispatchSimRerun } = await import(
  '../src/engine/wc-results-writer.js'
);

const post = (id, h, a, hs, as_) => ({
  state: 'post',
  match_id: id,
  home_slug: h,
  away_slug: a,
  home_score: hs,
  away_score: as_,
  espn_event_id: `e-${id}`,
});

beforeEach(() => {
  upsertWcResults.mockClear();
  fetchExistingWcFtIds.mockClear();
  fetchExistingWcFtIds.mockResolvedValue(new Set());
});

describe('persistWcFtResults — FT filter', () => {
  it('keeps only post games with a match_id + finite scores', async () => {
    const games = [
      post('match:C-MD1-BRA-MOR', 'brazil', 'morocco', 2, 1),
      { ...post('x', 'a', 'b', 1, 0), state: 'in' }, // live → drop
      { ...post('y', 'a', 'b', 1, 0), state: 'pre' }, // pre → drop
      { ...post('z', 'a', 'b', 1, 0), match_id: null }, // no id → drop
      { ...post('w', 'a', 'b', null, 0) }, // null score → drop
    ];
    const res = await persistWcFtResults(games);
    expect(res.upserted).toBe(1);
    const rows = upsertWcResults.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      match_id: 'match:C-MD1-BRA-MOR',
      home_slug: 'brazil',
      away_slug: 'morocco',
      home_score: 2,
      away_score: 1,
      status: 'FT',
      source: 'espn',
    });
    // settled_at must NOT be set on the write (preserves first-settle time).
    expect(rows[0]).not.toHaveProperty('settled_at');
  });

  it('returns no-op for empty / all-non-FT input without touching the DB', async () => {
    const res = await persistWcFtResults([{ state: 'in', match_id: 'x' }]);
    expect(res).toEqual({ upserted: 0, newlySettled: [] });
    expect(upsertWcResults).not.toHaveBeenCalled();
  });
});

describe('persistWcFtResults — debounce', () => {
  it('flags only matches not already FT in the table as newlySettled', async () => {
    fetchExistingWcFtIds.mockResolvedValue(new Set(['match:C-MD1-BRA-MOR']));
    const games = [
      post('match:C-MD1-BRA-MOR', 'brazil', 'morocco', 2, 1), // already FT
      post('match:L-MD1-ENG-CRO', 'england', 'croatia', 1, 1), // new
    ];
    const res = await persistWcFtResults(games);
    expect(res.upserted).toBe(2); // both still upserted (idempotent)
    expect(res.newlySettled).toEqual(['match:L-MD1-ENG-CRO']);
  });

  it('second identical scan reports nothing newly settled', async () => {
    const games = [post('match:L-MD1-ENG-CRO', 'england', 'croatia', 1, 1)];
    fetchExistingWcFtIds.mockResolvedValue(new Set(['match:L-MD1-ENG-CRO']));
    const res = await persistWcFtResults(games);
    expect(res.newlySettled).toEqual([]);
  });
});

describe('dispatchSimRerun — no token', () => {
  it('no-ops (no fetch) when GH_DISPATCH_TOKEN is unset', async () => {
    const prev = process.env.GH_DISPATCH_TOKEN;
    delete process.env.GH_DISPATCH_TOKEN;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await dispatchSimRerun(['match:L-MD1-ENG-CRO']);
    expect(res).toEqual({ dispatched: false, reason: 'no-token' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    if (prev !== undefined) process.env.GH_DISPATCH_TOKEN = prev;
  });
});
