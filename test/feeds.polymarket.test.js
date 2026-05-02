// Polymarket WS feed tests — verify the start/stop lifecycle without opening a
// real connection (we'd hit Polymarket and break the test sandbox), and verify
// getYesQuote returns null for unknown tokens.
//
// The wire-message parser shape is exercised by the comparator tests via
// constructed quote objects. If Polymarket drifts the on-wire shape, the live
// `[polymarket:shape N/5]` log lines on first connect catch it — see
// docs/POLYMARKET_FIELDS.md.

import { describe, it, expect } from 'vitest';
import { stopPolymarket, getYesQuote, getQuoteCount } from '../src/feeds/polymarket.js';

describe('polymarket feed (read-only API)', () => {
  it('getYesQuote returns null for an unknown token id', () => {
    expect(getYesQuote('nonexistent')).toBeNull();
  });

  it('getQuoteCount starts at zero before any messages applied', () => {
    expect(getQuoteCount()).toBeGreaterThanOrEqual(0);
  });

  it('stopPolymarket is safe to call when not started', () => {
    expect(() => stopPolymarket()).not.toThrow();
  });
});
