// fifteen-min-board — the `fifteen-min-open` row the site's 15-minute board reads first
// (handoffs/FIFTEEN_MIN_BOARD_ENGINE_FEED_2026-10-07.md §4 A3). Every guard is shown
// firing on a planted bad input next to its clean control.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FIFTEEN_MIN_BOARD_SERIES,
  SLIM_FIELDS,
  LISTED_INTERVAL_MS,
  EMPTY_INTERVAL_MS,
  SLUG,
  slimMarket,
  cadenceFor,
  isDue,
  applyRead,
  buildEnvelope,
  msUntilTurnover,
  runFifteenMinBoardOnce,
  __test__,
} from '../src/engine/fifteen-min-board.js';

const now = Date.parse('2026-10-07T16:05:00Z');
const live = {
  ticker: 'KXETH15M-26OCT071215-15',
  event_ticker: 'KXETH15M-26OCT071215',
  status: 'active',
  open_time: '2026-10-07T16:00:00Z',
  close_time: '2026-10-07T16:15:00Z',
  floor_strike: 2569.08,
  yes_bid_dollars: '0.7500',
  yes_ask_dollars: '0.7700',
  volume_fp: '1234.00',
  // fields that must never reach the anon-readable row:
  expiration_value: '2571.11',
  settlement_value: 1,
  result: 'yes',
  rules_primary: 'long text',
};

beforeEach(() => __test__.reset());

describe('whitelist', () => {
  it('a raw market carrying settle fields is written with exactly the whitelist keys', () => {
    const slim = slimMarket(live);
    expect(Object.keys(slim).sort()).toEqual(SLIM_FIELDS.filter((k) => k in live).sort());
    for (const k of Object.keys(slim)) expect(SLIM_FIELDS).toContain(k);
    expect(slim).not.toHaveProperty('expiration_value');
    expect(slim).not.toHaveProperty('settlement_value');
    expect(slim).not.toHaveProperty('result');
    expect(JSON.stringify(slim)).not.toMatch(/_value"/);
  });

  it('the whitelist itself names no *_value field', () => {
    expect(SLIM_FIELDS.some((k) => /_value$/.test(k))).toBe(false);
  });
});

describe('applyRead', () => {
  it('control: a good read replaces the markets and stamps fetched_at', () => {
    const e = applyRead(undefined, { ok: true, markets: [live] }, now);
    expect(e.fetched_at).toBe(new Date(now).toISOString());
    expect(e.markets).toHaveLength(1);
    expect(e.error).toBeUndefined();
  });

  it('a failed read keeps the previous markets + fetched_at and sets error', () => {
    const prev = applyRead(undefined, { ok: true, markets: [live] }, now - 30_000);
    const e = applyRead(prev, { ok: false, status: 502, error: 'kalshi KXETH15M HTTP 502' }, now);
    expect(e.markets).toEqual(prev.markets);
    expect(e.fetched_at).toBe(prev.fetched_at);
    expect(e.error).toMatch(/502/);
  });

  it('[] from Kalshi is stored as markets: [] (nothing listed), not an error', () => {
    const e = applyRead(undefined, { ok: true, markets: [] }, now);
    expect(e.markets).toEqual([]);
    expect(e.error).toBeUndefined();
    expect(e.fetched_at).toBe(new Date(now).toISOString());
  });

  it('a 404 (series not listed) is stored as [] too, never as an error', () => {
    const e = applyRead(undefined, { ok: false, status: 404, error: 'HTTP 404' }, now);
    expect(e.markets).toEqual([]);
    expect(e.error).toBeUndefined();
  });
});

describe('envelope', () => {
  it('stale is true when any series has an error; the errored series keeps its last markets', () => {
    const good = applyRead(undefined, { ok: true, markets: [live] }, now - 20_000);
    const series = {
      KXETH15M: applyRead(good, { ok: false, status: 500, error: 'HTTP 500' }, now),
      KXBTC15M: applyRead(undefined, { ok: true, markets: [] }, now),
    };
    const env = buildEnvelope(series, now);
    expect(env.stale).toBe(true);
    expect(env.data.v).toBe(1);
    expect(env.data.series.KXETH15M.markets).toHaveLength(1);
    expect(env.data.series.KXETH15M.error).toMatch(/500/);
    expect(env._raw).toEqual([]);
  });

  it('control: no errors → stale false', () => {
    const env = buildEnvelope({ KXBTC15M: applyRead(undefined, { ok: true, markets: [live] }, now) }, now);
    expect(env.stale).toBe(false);
    expect(env.as_of).toBe(new Date(now).toISOString());
  });

  it('a series never read successfully is left out (the site reads it live)', () => {
    const env = buildEnvelope({ KXBTC15M: applyRead(undefined, { ok: false, status: 500, error: 'x' }, now) }, now);
    expect(env.data.series).not.toHaveProperty('KXBTC15M');
    expect(env.stale).toBe(true);
  });
});

describe('cadence', () => {
  it('listed → 15 s, nothing listed → 120 s', () => {
    expect(cadenceFor({ markets: [live] })).toBe(15_000);
    expect(cadenceFor({ markets: [] })).toBe(120_000);
    expect(LISTED_INTERVAL_MS).toBe(15_000);
    expect(EMPTY_INTERVAL_MS).toBe(120_000);
  });

  it('isDue follows the cadence; forceAll (turnover) makes everything due', () => {
    const listed = { markets: [live], lastAttemptAt: now - 10_000 };
    const empty = { markets: [], lastAttemptAt: now - 60_000 };
    expect(isDue(listed, now)).toBe(false);
    expect(isDue(listed, now + 5_000)).toBe(true);
    expect(isDue(empty, now)).toBe(false);
    expect(isDue(empty, now + 60_000)).toBe(true);
    expect(isDue(empty, now, true)).toBe(true);
    expect(isDue(undefined, now)).toBe(true);
  });

  it('turnover pass lands 2 s after each quarter hour', () => {
    expect(msUntilTurnover(Date.parse('2026-10-07T16:14:50Z'))).toBe(12_000);
    expect(msUntilTurnover(Date.parse('2026-10-07T16:15:01Z'))).toBe(1_000);
    expect(msUntilTurnover(Date.parse('2026-10-07T16:15:02Z'))).toBe(15 * 60_000);
  });
});

describe('series list', () => {
  // Hard-coded from the site's lib/fifteen-min/series.ts `status: 'dormant'` rows.
  const DORMANT = ['KXADA15M', 'KXBCH15M', 'KXTON15M', 'KXCRYPTOCOMP15M'];

  it('contains no dormant ticker', () => {
    for (const t of DORMANT) expect(FIFTEEN_MIN_BOARD_SERIES).not.toContain(t);
  });

  it('is the 26 non-dormant series, no duplicates', () => {
    expect(FIFTEEN_MIN_BOARD_SERIES).toHaveLength(26);
    expect(new Set(FIFTEEN_MIN_BOARD_SERIES).size).toBe(26);
  });
});

describe('one pass', () => {
  const noSleep = async () => {};

  it('reads every due series and writes ONE row to fifteen-min-open/hero', async () => {
    const writes = [];
    const r = await runFifteenMinBoardOnce({
      now,
      fetcher: async (t) => (t === 'KXETH15M' ? [live] : []),
      writer: async (slug, env, variants) => writes.push({ slug, env, variants }),
      sleep: noSleep,
    });
    expect(r.written).toBe(true);
    expect(r.attempted).toBe(26);
    expect(writes).toHaveLength(1);
    expect(writes[0].slug).toBe(SLUG);
    expect(writes[0].variants).toEqual(['hero']);
    expect(Object.keys(writes[0].env.data.series)).toHaveLength(26);
    expect(JSON.stringify(writes[0].env)).not.toMatch(/expiration_value|settlement_value|"result"/);
  });

  it('a 429 pauses the rest of the pass; unread series keep their entries', async () => {
    let calls = 0;
    const r = await runFifteenMinBoardOnce({
      now,
      fetcher: async () => {
        calls += 1;
        const err = new Error('kalshi HTTP 429');
        err.status = 429;
        err.retryAfter = '30';
        throw err;
      },
      writer: async () => {},
      sleep: noSleep,
    });
    // Up to 4 workers were already past the pause check; nothing after them runs.
    expect(calls).toBeLessThanOrEqual(4);
    expect(r.attempted).toBe(calls);
    expect(__test__.state.pausedUntil).toBeGreaterThan(Date.now());
  });

  it('a pass where nothing is due still writes (as_of advances)', async () => {
    const t0 = Date.now();
    for (const t of FIFTEEN_MIN_BOARD_SERIES) __test__.state.series[t] = { fetched_at: new Date(t0).toISOString(), markets: [live], lastAttemptAt: t0 };
    let calls = 0;
    const r = await runFifteenMinBoardOnce({ now: t0, fetcher: async () => { calls += 1; return []; }, writer: async () => {}, sleep: noSleep });
    expect(calls).toBe(0);
    expect(r.written).toBe(true);
  });
});
