// DB heartbeat state machine (prediction-marketspicks DB_FREEZE_ROOT_CAUSE_AND_HARDENING_2026-11-11 U1).
// Pure: a fake clock and fake beats, no database, no Discord.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/delivery/supabase.js', () => ({ getClient: () => ({}) }));
vi.mock('../src/delivery/discord.js', () => ({ postBotLog: async () => true }));

const hb = await import('../src/observability/db-heartbeat.js');
const health = await import('../src/observability/health.js');

const T0 = Date.parse('2026-11-12T15:00:00Z');
const at = (n) => T0 + n * hb.BEAT_MS;
const down = { kind: 'down', latencyMs: 5000, error: 'no answer in 5000 ms' };
const ok = { kind: 'ok', latencyMs: 40 };
const slow = { kind: 'slow', latencyMs: 2600 };

function run(beats, start = hb.initialHeartbeat()) {
  let s = start;
  const posts = [];
  beats.forEach((b, i) => {
    const r = hb.stepHeartbeat(s, b, at(i));
    s = r.next;
    r.posts.forEach((p) => posts.push({ i, p }));
  });
  return { s, posts };
}

describe('classifyBeat', () => {
  it('ok < 2 s, slow 2–5 s, down on error', () => {
    expect(hb.classifyBeat({ latencyMs: 1999, error: null })).toBe('ok');
    expect(hb.classifyBeat({ latencyMs: 2000, error: null })).toBe('slow');
    expect(hb.classifyBeat({ latencyMs: 300, error: 'boom' })).toBe('down');
  });
});

describe('stepHeartbeat', () => {
  it('3 consecutive downs → exactly one alarm, naming ≈ 90 s and the last error', () => {
    const { posts, s } = run([ok, down, down, down]);
    expect(posts).toHaveLength(1);
    expect(posts[0].i).toBe(3);
    expect(posts[0].p).toContain('Database not answering for 90 s');
    expect(posts[0].p).toContain('no answer in 5000 ms');
    expect(s.inOutage).toBe(true);
    expect(s.downSince).toBe(at(1));
  });

  it('a 4th down inside 10 min posts nothing more; it repeats after 10 min', () => {
    const beats = [down, down, down, down];
    expect(run(beats).posts).toHaveLength(1);
    const twenty = Array(3 + Math.ceil(hb.REPEAT_MS / hb.BEAT_MS)).fill(down);
    const { posts } = run(twenty);
    expect(posts).toHaveLength(2);
    expect(at(posts[1].i) - at(posts[0].i)).toBeGreaterThanOrEqual(hb.REPEAT_MS);
  });

  it('1–2 down blips never alarm and are forgotten', () => {
    const { posts, s } = run([down, down, ok, down, down, ok]);
    expect(posts).toHaveLength(0);
    expect(s.downSince).toBeNull();
    expect(s.inOutage).toBe(false);
  });

  it('recovery posts once, after 2 good beats, with the outage length', () => {
    const { posts, s } = run([down, down, down, down, ok, ok, ok, ok]);
    expect(posts.map((x) => x.i)).toEqual([2, 5]);
    expect(posts[1].p).toContain('Database answering again');
    expect(posts[1].p).toContain('150 s'); // first failed beat (0) → second good beat (5) = 5 × 30 s
    expect(s.inOutage).toBe(false);
  });

  it('one good beat in an outage does not recover; a down after it does not re-alarm early', () => {
    const { posts } = run([down, down, down, ok, down, down, down, ok, ok]);
    expect(posts.map((x) => x.i)).toEqual([2, 8]);
    expect(posts[1].p).toContain('Database answering again');
  });

  it('6 slow beats → one slow alarm per episode; ok resets it', () => {
    const six = Array(6).fill(slow);
    const first = run([...six, slow, slow]);
    expect(first.posts).toHaveLength(1);
    expect(first.posts[0].i).toBe(5);
    expect(first.posts[0].p).toContain('Database slow');
    const again = run([...six, ok, ...six]);
    expect(again.posts.map((x) => x.i)).toEqual([5, 12]);
  });

  it('5 slow beats stay quiet', () => {
    expect(run(Array(5).fill(slow)).posts).toHaveLength(0);
  });
});

describe('/health exposure', () => {
  it('db_heartbeat is a feed with state/lastLatencyMs/downSince and is NOT required', () => {
    health.registerFeed(hb.FEED);
    health.setFeedStatus(hb.FEED, { connected: true, lastError: null, extra: { state: 'ok', lastLatencyMs: 40, downSince: null } });
    const f = health.snapshot().feeds[hb.FEED];
    expect(f.state).toBe('ok');
    expect(f.lastLatencyMs).toBe(40);
    expect(f.downSince).toBeNull();
    expect(f.required).toBe(false);
  });
});
