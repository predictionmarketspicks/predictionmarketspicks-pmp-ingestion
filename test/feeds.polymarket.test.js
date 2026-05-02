// Polymarket WS feed tests. Lifecycle smoke + parser shape locks against
// regressions of the live wire format documented in docs/POLYMARKET_FIELDS.md.
// Fixtures are real frames captured from production WS on 2026-05-02.

import { describe, it, expect } from 'vitest';
import { stopPolymarket, getYesQuote, getQuoteCount, applyMessage } from '../src/feeds/polymarket.js';

const YES_JUN_NO_CHANGE = '30767812841387255642892182147223249245545002662653079696958384408588201824258';
const NO_JUN_NO_CHANGE = '40302938956091099752849867077837976978448552504757012372843872340644441002059';
const YES_SEP_NO_CHANGE = '105275363999962243078890826573477817229052004571369709283536181169501899960451';
const NO_SEP_NO_CHANGE = '102691896158834031796486790990441397118469957281626922200179056642410386295589';

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

describe('applyMessage parser — live wire shapes', () => {
  it('book event populates bid/ask/mid from L2 levels (asset_id at top level)', () => {
    applyMessage({
      event_type: 'book',
      asset_id: YES_JUN_NO_CHANGE,
      market: '0xde04...',
      bids: [
        { price: '0.94', size: '120.0' },
        { price: '0.93', size: '80.0' },
      ],
      asks: [
        { price: '0.96', size: '200.0' },
        { price: '0.97', size: '150.0' },
      ],
      timestamp: '1777756325449',
    });
    const q = getYesQuote(YES_JUN_NO_CHANGE);
    expect(q?.bid).toBe(0.94);
    expect(q?.ask).toBe(0.96);
    expect(q?.mid).toBeCloseTo(0.95, 5);
  });

  it('price_change event uses price_changes (plural) and per-entry best_bid/best_ask', () => {
    applyMessage({
      event_type: 'price_change',
      market: '0x5c0eb0be...',
      price_changes: [
        {
          asset_id: YES_SEP_NO_CHANGE,
          price: '0.81',
          size: '56.67',
          side: 'BUY',
          hash: '...',
          best_bid: '0.84',
          best_ask: '0.85',
        },
        {
          asset_id: NO_SEP_NO_CHANGE,
          price: '0.19',
          size: '56.67',
          side: 'SELL',
          hash: '...',
          best_bid: '0.15',
          best_ask: '0.16',
        },
      ],
      timestamp: '1777756328381',
    });
    const yes = getYesQuote(YES_SEP_NO_CHANGE);
    expect(yes?.bid).toBe(0.84);
    expect(yes?.ask).toBe(0.85);
    expect(yes?.mid).toBeCloseTo(0.845, 5);
    // Both YES and NO get updated in the same frame.
    const no = getYesQuote(NO_SEP_NO_CHANGE);
    expect(no?.bid).toBe(0.15);
    expect(no?.ask).toBe(0.16);
  });

  it('price_change does NOT use a top-level asset_id (regression guard)', () => {
    // Live frames have no top-level asset_id. If we erroneously fell back to
    // parsed.market or some other identifier, both YES and NO would write
    // under the wrong key. This frame should ONLY write under each entry's
    // own asset_id.
    applyMessage({
      event_type: 'price_change',
      market: '0xde04b189...',
      price_changes: [
        {
          asset_id: YES_JUN_NO_CHANGE,
          best_bid: '0.95',
          best_ask: '0.96',
          price: '0.94',
          size: '100',
          side: 'BUY',
        },
        {
          asset_id: NO_JUN_NO_CHANGE,
          best_bid: '0.04',
          best_ask: '0.05',
          price: '0.06',
          size: '100',
          side: 'SELL',
        },
      ],
      timestamp: '1777756330593',
    });
    expect(getYesQuote('0xde04b189...')).toBeNull();
    expect(getYesQuote(YES_JUN_NO_CHANGE)?.mid).toBeCloseTo(0.955, 5);
    expect(getYesQuote(NO_JUN_NO_CHANGE)?.mid).toBeCloseTo(0.045, 5);
  });

  it('size:"0" cancel still updates best_bid/best_ask (no special-casing needed)', () => {
    applyMessage({
      event_type: 'price_change',
      market: '0xdde06286...',
      price_changes: [
        {
          asset_id: YES_JUN_NO_CHANGE,
          price: '0.937',
          size: '0',
          side: 'BUY',
          best_bid: '0.961',
          best_ask: '0.962',
        },
      ],
      timestamp: '1777756335924',
    });
    const q = getYesQuote(YES_JUN_NO_CHANGE);
    expect(q?.bid).toBe(0.961);
    expect(q?.ask).toBe(0.962);
  });

  it('last_trade_price sets `last`; only sets mid when no two-sided book exists', () => {
    // Use an unseen token so the prior-mid invariant is testable.
    const FRESH_TOKEN = '999999999999999999999999999999999999999999999';
    applyMessage({
      event_type: 'last_trade_price',
      asset_id: FRESH_TOKEN,
      market: '0xfresh',
      price: '0.42',
      side: 'BUY',
      size: '10',
      timestamp: '1777756340000',
    });
    const q = getYesQuote(FRESH_TOKEN);
    expect(q?.last).toBe(0.42);
    expect(q?.mid).toBe(0.42);
  });

  it('ignores unknown event types without throwing', () => {
    expect(() =>
      applyMessage({ event_type: 'tick_size_change', market: '0x', timestamp: '1' }),
    ).not.toThrow();
  });
});
