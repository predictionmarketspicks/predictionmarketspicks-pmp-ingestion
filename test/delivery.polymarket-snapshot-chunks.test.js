// insertPolymarketSnapshots writes in 1,000-row statements (a ~6,000-row US tick
// in one statement hit PostgREST's 8s statement_timeout intermittently).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      upsert: (chunk, opts) => ({
        select: async () => {
          calls.push({ n: chunk.length, opts, stamps: new Set(chunk.map((r) => r.snapshot_at)) });
          if (process.env.__FAIL_CHUNK === String(calls.length)) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
          return { data: chunk.map((_, i) => ({ id: i })), error: null };
        },
      }),
    }),
  }),
}));

beforeEach(() => {
  calls.length = 0;
  delete process.env.__FAIL_CHUNK;
  process.env.SUPABASE_URL = 'http://x';
  process.env.SUPABASE_SERVICE_KEY = 'k';
});

const rows = (n) => Array.from({ length: n }, (_, i) => ({ condition_id: `c${i}`, venue: 'us' }));

describe('insertPolymarketSnapshots chunking', () => {
  it('splits 6,003 rows into 1,000-row statements sharing one snapshot_at', async () => {
    const { insertPolymarketSnapshots } = await import('../src/delivery/supabase.js');
    const { count } = await insertPolymarketSnapshots(rows(6003), { snapshotAt: '2026-09-28T04:12:19Z' });
    expect(count).toBe(6003);
    expect(calls.map((c) => c.n)).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 3]);
    expect(calls.every((c) => c.stamps.size === 1 && c.stamps.has('2026-09-28T04:12:19Z'))).toBe(true);
    expect(calls[0].opts).toMatchObject({ onConflict: 'condition_id,snapshot_at', ignoreDuplicates: true, defaultToNull: false });
  });

  it('throws naming the failed chunk', async () => {
    process.env.__FAIL_CHUNK = '3';
    const { insertPolymarketSnapshots } = await import('../src/delivery/supabase.js');
    await expect(insertPolymarketSnapshots(rows(3500))).rejects.toThrow(/rows 2000–2999.*statement timeout/);
  });
});
