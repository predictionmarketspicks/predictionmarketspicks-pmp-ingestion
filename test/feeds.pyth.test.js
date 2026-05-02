// Pyth feed registry tests — locks the verified-feed ID list and exercises
// the unknown-symbol fail-open path used by oil/copper engines.

import { describe, it, expect } from 'vitest';
import { FEED_IDS, startPyth, stopAllPyth } from '../src/feeds/pyth.js';

describe('FEED_IDS', () => {
  it('publishes XAG/USD and XAU/USD only — WTI and copper omitted intentionally', () => {
    expect(FEED_IDS['XAG/USD']).toMatch(/^0x[a-f0-9]{64}$/);
    expect(FEED_IDS['XAU/USD']).toMatch(/^0x[a-f0-9]{64}$/);
    expect(FEED_IDS['WTI']).toBeUndefined();
    expect(FEED_IDS['XCU/USD']).toBeUndefined();
  });
});

describe('startPyth', () => {
  it('does not throw when given a symbol without a verified feed ID', () => {
    // Engines for oil/copper register their pyth symbols here; the poller
    // should warn-and-skip rather than crash the process.
    expect(() => {
      startPyth(['WTI', 'XCU/USD']);
      stopAllPyth();
    }).not.toThrow();
  });
});
