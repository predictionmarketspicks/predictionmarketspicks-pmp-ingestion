import { describe, it, expect, beforeEach } from 'vitest';
import { recordTick, bufferStats, _resetBuffers } from '../src/engine/short-horizon-vol.js';

/**
 * bufferStats exists to answer ONE question fast: when sigma is null, are ticks
 * not reaching the buffer, or is a full buffer being rejected? On 2026-09-10 the
 * three metals sat at sigma=null for ~9.7h and nothing exposed could tell those
 * apart — it took a live Pythnet poll and a local replay to rule out the feed,
 * the writer, the key mapping and the buffer code.
 */
describe('bufferStats', () => {
  beforeEach(() => _resetBuffers());

  it('is empty when nothing has ticked — the "not reaching the buffer" world', () => {
    expect(bufferStats()).toEqual({});
  });

  it('reports a shallow buffer as belowMinTicks, not as stale', () => {
    const now = Date.now();
    recordTick('gold', 2500, now - 20_000);
    recordTick('gold', 2501, now - 10_000);
    recordTick('gold', 2502, now);
    const s = bufferStats(now).gold;
    expect(s.nTicks).toBe(3);
    expect(s.belowMinTicks).toBe(true);
    expect(s.lastTickStale).toBe(false);
    expect(s.medianDtS).toBe(10);
    expect(s.lastTickAgeS).toBe(0);
    expect(s.oldestTickAgeS).toBe(20);
  });

  it('reports a deep but STALE buffer — the "rejected" world', () => {
    const now = Date.now();
    // 40 ticks (over MIN_TICKS_FOR_RV) but the newest is 5 minutes old.
    for (let i = 40; i >= 1; i--) recordTick('silver', 30 + i * 0.01, now - 300_000 - i * 10_000);
    const s = bufferStats(now).silver;
    expect(s.nTicks).toBe(40);
    expect(s.belowMinTicks).toBe(false);
    expect(s.lastTickStale).toBe(true);
  });

  it('carries the thresholds so a reader need not know them', () => {
    recordTick('wti', 70, Date.now());
    const s = bufferStats().wti;
    expect(s.capacity).toBeGreaterThan(0);
    expect(s.minTicksForRv).toBeGreaterThan(0);
  });

  it('is per-commodity', () => {
    const now = Date.now();
    recordTick('gold', 2500, now);
    recordTick('wti', 70, now);
    expect(Object.keys(bufferStats(now)).sort()).toEqual(['gold', 'wti']);
  });
});
