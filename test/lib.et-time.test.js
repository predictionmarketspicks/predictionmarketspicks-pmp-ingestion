import { describe, it, expect } from 'vitest';
import { nextEtSlot, etDayStart, etDateKey, etWallToUtc } from '../src/lib/et-time.js';

describe('et-time', () => {
  it('next 10:00/18:00 ET slot in EDT', () => {
    // 2026-10-25 13:44 UTC = 09:44 EDT → 10:00 EDT = 14:00 UTC
    expect(nextEtSlot([10, 18], new Date('2026-10-25T13:44:00Z')).toISOString()).toBe('2026-10-25T14:00:00.000Z');
    // 15:00 UTC = 11:00 EDT → 18:00 EDT = 22:00 UTC
    expect(nextEtSlot([18, 10], new Date('2026-10-25T15:00:00Z')).toISOString()).toBe('2026-10-25T22:00:00.000Z');
    // after 18:00 ET → next day 10:00
    expect(nextEtSlot([10, 18], new Date('2026-10-25T22:30:00Z')).toISOString()).toBe('2026-10-26T14:00:00.000Z');
  });

  it('handles the DST fall-back (EST after 2026-11-01)', () => {
    expect(nextEtSlot([10, 18], new Date('2026-11-01T12:00:00Z')).toISOString()).toBe('2026-11-01T15:00:00.000Z');
    expect(etWallToUtc(2026, 11, 2, 18).toISOString()).toBe('2026-11-02T23:00:00.000Z');
  });

  it('ET day start and key', () => {
    expect(etDayStart(new Date('2026-10-25T02:00:00Z')).toISOString()).toBe('2026-10-24T04:00:00.000Z');
    expect(etDateKey(new Date('2026-10-25T02:00:00Z'))).toBe('2026-10-24');
  });
});
