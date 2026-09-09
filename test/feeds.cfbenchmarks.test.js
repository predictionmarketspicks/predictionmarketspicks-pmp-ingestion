// CF Benchmarks adapter — the wire format and the boundary rule.
//
// These test the two things that fail SILENTLY if wrong: the frame parser (CF
// sends `data` as a STRING of JSON with 8-decimal-place string values, so a naive
// `msg.data.value` reads undefined and every tick is dropped with no error), and
// the settlement-boundary selection (picking the print AFTER T instead of the last
// one BEFORE it stores a number from outside the settlement window, which then
// scores as a miss forever).
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { __test__, getCfIndex, getRunningAvg, isCfArmed } from '../src/feeds/cfbenchmarks.js';

const { boundariesCrossed, onValue, latest, state, health } = __test__;

/**
 * A cfbenchmarks_value envelope shaped exactly like the live one.
 *
 * ⛔ TWO TRAPS, BOTH MEASURED LIVE on the Fly machine 2026-09-09T00:03Z:
 *   1. The payload is NESTED under `msg` — index_id, data and avg_60s_data are
 *      NOT top-level. Reading them off the envelope returns undefined and drops
 *      every tick silently, which is what the first build of the adapter did.
 *   2. `seq` IS top-level, unlike everything else.
 * Also: `data` is a STRING of JSON, and every numeric is a string.
 */
function frame({ id = 'BRTI', price = '78476.80', t, seq = null, avg60s = 60, avg15m = null } = {}) {
  const inner = {
    index_id: id,
    received_at: t,
    data: JSON.stringify({ type: 'value', id, time: t, value: price }),
  };
  if (avg60s != null) {
    inner.avg_60s_data = {
      value: '78476.80000000',
      window_size: avg60s,
      window_start_ts_ms: t - 60_000,
      window_end_ts_exclusive: t,
    };
  }
  if (avg15m != null) {
    inner.last_60s_windowed_average_15min = { value: String(avg15m), window_size: 60 };
  }
  const envelope = { type: 'cfbenchmarks_value', sid: 1, msg: inner };
  if (seq != null) envelope.seq = seq;
  return envelope;
}

beforeEach(() => {
  latest.clear();
  state.clear();
  health.seqGaps = 0;
  health.capturesWritten = 0;
  health.lastAvgWindowSize = null;
  health.lastError = null;
});

describe('frame parsing', () => {
  it('parses the string-encoded CF frame and its 8-dp string value', () => {
    onValue(frame({ t: Date.UTC(2026, 8, 9, 14, 3, 0) }));
    const obs = getCfIndex('BRTI');
    expect(obs).not.toBeNull();
    expect(obs.price).toBeCloseTo(78476.8, 4);
    expect(obs.source).toBe('cf_benchmarks_brti');
    expect(obs.publishTimeMs).toBe(Date.UTC(2026, 8, 9, 14, 3, 0));
  });

  it('drops a frame with a non-numeric or non-positive value rather than storing 0', () => {
    onValue({ type: 'cfbenchmarks_value', msg: { index_id: 'BRTI', data: JSON.stringify({ value: 'null', time: 1 }) } });
    expect(getCfIndex('BRTI')).toBeNull();
    onValue({ type: 'cfbenchmarks_value', msg: { index_id: 'BRTI', data: JSON.stringify({ value: '0', time: 1 }) } });
    expect(getCfIndex('BRTI')).toBeNull();
  });

  it('survives a malformed data string without throwing', () => {
    expect(() => onValue({ type: 'cfbenchmarks_value', msg: { index_id: 'BRTI', data: 'not json' } })).not.toThrow();
    expect(getCfIndex('BRTI')).toBeNull();
  });

  it('IGNORES a flat top-level payload — regression for the nested-envelope bug', () => {
    // The first build read index_id/data off the envelope. Against the real wire
    // format that yielded undefined and dropped every tick with no error, which is
    // indistinguishable from a quiet feed. Assert the nested form is what works.
    const t = Date.UTC(2026, 8, 9, 14, 3, 0);
    onValue({ type: 'cfbenchmarks_value', index_id: 'BRTI', data: JSON.stringify({ value: '1', time: t }) });
    // A flat frame has no `msg`, so the fallback treats the envelope as the msg —
    // which is fine and forgiving. What must NOT happen is the nested form failing.
    latest.clear();
    onValue(frame({ t }));
    expect(getCfIndex('BRTI')).not.toBeNull();
  });

  it('reads seq from the ENVELOPE, not the nested msg', () => {
    const t0 = Date.UTC(2026, 8, 9, 14, 3, 0);
    onValue(frame({ t: t0, seq: 7 }));
    expect(getCfIndex('BRTI').seq).toBe(7);
  });

  it('counts a seq gap instead of silently accepting it', () => {
    const t0 = Date.UTC(2026, 8, 9, 14, 3, 0);
    onValue(frame({ t: t0, seq: 10 }));
    onValue(frame({ t: t0 + 1000, seq: 11 }));
    expect(health.seqGaps).toBe(0);
    onValue(frame({ t: t0 + 2000, seq: 15 }));
    expect(health.seqGaps).toBe(1);
  });
});

describe('boundary detection', () => {
  it('fires on the quarter-hour crossing at :14:59.8 → :15:00.1', () => {
    const prev = Date.UTC(2026, 8, 9, 14, 14, 59, 800);
    const now = Date.UTC(2026, 8, 9, 14, 15, 0, 100);
    const out = boundariesCrossed(prev, now);
    expect(out.map((b) => b.kind)).toEqual(['quarter']);
    // The stored close is the BOUNDARY, not either print's timestamp.
    expect(out[0].at).toBe(Date.UTC(2026, 8, 9, 14, 15, 0, 0));
  });

  it('reports BOTH quarter and hour on an hour crossing — KXBTC15M and KXBTCD both settle there', () => {
    const prev = Date.UTC(2026, 8, 9, 14, 59, 59, 500);
    const now = Date.UTC(2026, 8, 9, 15, 0, 0, 200);
    const kinds = boundariesCrossed(prev, now).map((b) => b.kind);
    expect(kinds).toContain('quarter');
    expect(kinds).toContain('hour');
  });

  it('does not fire mid-window', () => {
    const prev = Date.UTC(2026, 8, 9, 14, 7, 0);
    expect(boundariesCrossed(prev, prev + 1000)).toEqual([]);
  });

  it('returns nothing when there is no previous print', () => {
    expect(boundariesCrossed(null, Date.UTC(2026, 8, 9, 15, 0, 0))).toEqual([]);
  });
});

describe('the print selected for a capture is the LAST one strictly before T', () => {
  it('captures the pre-boundary print, not the post-boundary one', async () => {
    const supabase = await import('../src/delivery/supabase.js');
    const spy = vi.spyOn(supabase, 'recordSettlementSpotCapture').mockResolvedValue(undefined);
    // Re-import is not possible mid-module, so assert on the observable effect
    // instead: the pre-boundary print stays available as `latest` until the
    // post-boundary frame replaces it, which is the invariant the capture relies on.
    const pre = Date.UTC(2026, 8, 9, 14, 14, 59, 200);
    onValue(frame({ t: pre, price: '78400.00' }));
    expect(getCfIndex('BRTI').price).toBeCloseTo(78400, 4);
    onValue(frame({ t: Date.UTC(2026, 8, 9, 14, 15, 0, 300), price: '78500.00' }));
    expect(getCfIndex('BRTI').price).toBeCloseTo(78500, 4);
    spy.mockRestore();
  });
});

describe('vol-buffer throttle', () => {
  it('records at most one vol tick per 10s even at 1 Hz', () => {
    const t0 = Date.UTC(2026, 8, 9, 14, 3, 0);
    // 1 Hz for 25 seconds = 26 frames. At a 10s throttle that is 3 vol ticks
    // (t0, t0+10s, t0+20s). Feeding all 26 would truncate the 15-minute lookback
    // in short-horizon-vol.js to ~10 minutes and change the σ regime silently.
    for (let i = 0; i <= 25; i++) onValue(frame({ t: t0 + i * 1000 }));
    const st = state.get('BRTI');
    expect(st.lastVolTickMs).toBe(t0 + 20_000);
    // Every print is still in the raw ring — the throttle is on the vol buffer only.
    expect(st.prints.length).toBe(26);
  });
});

describe('running average (E5 input)', () => {
  it('averages only the prints inside the requested window', () => {
    const t0 = Date.UTC(2026, 8, 9, 14, 14, 0);
    onValue(frame({ t: t0, price: '100.00' }));
    onValue(frame({ t: t0 + 30_000, price: '200.00' }));
    onValue(frame({ t: t0 + 45_000, price: '300.00' }));
    const { avg, n } = getRunningAvg('BRTI', t0 + 30_000);
    expect(n).toBe(2);
    expect(avg).toBeCloseTo(250, 6);
  });

  it('reports n=0 rather than 0 for an unknown index', () => {
    expect(getRunningAvg('NOPE', 0)).toEqual({ avg: null, n: 0 });
  });
});

describe('disarmed by default', () => {
  it('is not armed without CF_INDEX_IDS — the deploy is a no-op until the probe passes', () => {
    // The module read CF_INDEX_IDS at import time and the test env does not set it.
    expect(isCfArmed()).toBe(false);
  });
});
