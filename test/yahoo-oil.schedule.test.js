// The off-hours poll must never overshoot the 09:30 ET open (yahoo-oil.js
// nextPollDelayMs). A flat 60min delay left the first session hour on a spot
// up to an hour old.
import { describe, it, expect } from 'vitest';
import { nextPollDelayMs, POLL_INTERVAL_MARKET_MS, POLL_INTERVAL_OFF_MS } from '../src/feeds/yahoo-oil.js';

const at = (iso) => new Date(iso).getTime();
const MIN = 60 * 1000;

describe('nextPollDelayMs', () => {
  it('uses the 15min cadence in session', () => {
    expect(nextPollDelayMs(at('2026-09-28T16:00:00Z'))).toBe(POLL_INTERVAL_MARKET_MS); // Mon 12:00 ET
  });
  it('uses the hourly cadence deep off-hours and on weekends', () => {
    expect(nextPollDelayMs(at('2026-09-28T06:00:00Z'))).toBe(POLL_INTERVAL_OFF_MS); // Mon 02:00 ET
    expect(nextPollDelayMs(at('2026-09-26T16:00:00Z'))).toBe(POLL_INTERVAL_OFF_MS); // Sat
  });
  it('lands a poll one minute before the open instead of an hour after', () => {
    // Mon 09:25 ET → next poll 09:29 (4 min), never 10:25.
    expect(nextPollDelayMs(at('2026-09-28T13:25:00Z'))).toBe(4 * MIN);
    // Mon 09:29 ET → 1 min, so a poll fires at the open itself.
    expect(nextPollDelayMs(at('2026-09-28T13:29:00Z'))).toBe(1 * MIN);
    // Mon 08:45 ET → 44 min.
    expect(nextPollDelayMs(at('2026-09-28T12:45:00Z'))).toBe(44 * MIN);
  });
});
