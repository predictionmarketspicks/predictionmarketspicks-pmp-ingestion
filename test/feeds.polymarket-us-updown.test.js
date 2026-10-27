// Polymarket US Up/Down capture — pure helpers.
// prediction-marketspicks/handoffs/FINAL_MINUTE_LANE_AND_5MIN_HUB_2026-10-27.md §4.6

import { describe, it, expect } from 'vitest';
import { eventSlug, windowStart, shouldSample, topOfBook, topFromEventMarket, midCents, windowPrices, resolvedResult, ledgerRow } from '../src/feeds/polymarket-us-updown.js';

const T = Date.parse('2026-10-27T12:30:00Z');

describe('slug + window', () => {
  it('names the window by its UTC start', () => {
    expect(eventSlug('btc', '5m', T)).toBe('btc-updown-5m-2026-10-27-1230z');
    expect(eventSlug('eth', '15m', Date.parse('2026-11-01T06:15:00Z'))).toBe('eth-updown-15m-2026-11-01-0615z'); // DST day: UTC, no shift
  });
  it('floors to the horizon', () => {
    expect(windowStart(T + 299_999, '5m')).toBe(T);
    expect(windowStart(T + 300_000, '5m')).toBe(T + 300_000);
    expect(windowStart(T + 14 * 60_000, '15m')).toBe(T);
  });
});

describe('cadence', () => {
  it('5m: every 15 s, then every 5 s in the final 90 s → 32 rows a window', () => {
    let n = 0;
    for (let b = T; b < T + 300_000; b += 5_000) if (shouldSample(T + 300_000 - b, '5m', b)) n++;
    expect(n).toBe(32);
  });
  it('15m: only the final 5 minutes', () => {
    expect(shouldSample(600_000, '15m', T)).toBe(false);
    expect(shouldSample(300_000, '15m', T)).toBe(true);
    expect(shouldSample(0, '5m', T)).toBe(false);
  });
});

describe('book', () => {
  const book = { marketData: { bids: [{ px: { value: '0.2700' }, qty: '42' }, { px: { value: '0.2900' }, qty: '60' }], offers: [{ px: { value: '0.3600' }, qty: '10' }, { px: { value: '0.3500' }, qty: '7' }] } };
  it('takes the best level on each side', () => {
    expect(topOfBook(book)).toEqual({ up_bid: 0.29, up_ask: 0.35, bid_size: 60, ask_size: 7 });
  });
  it('event fallback carries no size', () => {
    expect(topFromEventMarket({ bestBidQuote: { value: '0.35' }, bestAskQuote: { value: '0.36' } })).toEqual({ up_bid: 0.35, up_ask: 0.36, bid_size: null, ask_size: null });
  });
  it('mid only on a real two-sided book', () => {
    expect(midCents({ up_bid: 0.29, up_ask: 0.35 })).toBe(32);
    expect(midCents({ up_bid: 0.1, up_ask: 0.4 })).toBeNull();
    expect(midCents({ up_bid: null, up_ask: 0.4 })).toBeNull();
  });
});

describe('ledger', () => {
  const closed = (op, ptb, sp) => ({
    event: {
      slug: 'btc-updown-5m-2026-10-27-1230z',
      closed: true,
      markets: [{
        slug: 'cpc-btc-updown-5m-2026-10-27-1230z',
        closed: true,
        outcomes: '["Yes","No"]',
        outcomePrices: op,
        marketSides: [{ description: 'Yes', long: true }, { description: 'No', long: false }],
        assetPriceTerms: { horizon: '5m', windowStart: '2026-10-27T12:30:00Z', windowEnd: '2026-10-27T12:35:00Z', priceToBeat: { value: ptb }, settlementPrice: { value: sp } },
      }],
    },
  });
  it('reads the result by the long side', () => {
    expect(resolvedResult(closed('["1","0"]').event.markets[0])).toBe('up');
    expect(resolvedResult(closed('["0","1"]').event.markets[0])).toBe('down');
    expect(resolvedResult(closed('["0.5","0.5"]').event.markets[0])).toBeNull();
  });
  it('builds a row with move_bps and the four prices', () => {
    const samples = [
      { tau_ms: 300_000, up_bid: 0.49, up_ask: 0.51 },
      { tau_ms: 60_000, up_bid: 0.7, up_ask: 0.72 },
      { tau_ms: 30_000, up_bid: 0.8, up_ask: 0.82 },
      { tau_ms: 5_000, up_bid: 0.95, up_ask: 0.97 },
    ];
    const r = ledgerRow(closed('["1","0"]', '80063.00', '80116.24'), 'btc', '5m', samples);
    expect(r.result).toBe('up');
    expect(r.move_bps).toBe(6.65);
    expect([r.up_open_c, r.up_t60_c, r.up_t30_c, r.up_final_c]).toEqual([50, 71, 81, 96]);
    expect(r.observations).toBe(4);
    expect(r.source).toBe('worker');
  });
  it('refuses a settlement on the wrong side of the result', () => {
    expect(ledgerRow(closed('["1","0"]', '80063.00', '80000.00'), 'btc', '5m')).toBeNull();
  });
  it('no samples → a backfill-shaped row', () => {
    const r = ledgerRow(closed('["0","1"]', '80063.00', '80000.00'), 'btc', '5m');
    expect(r.source).toBe('backfill');
    expect(r.up_final_c).toBeNull();
  });
  it('windowPrices ignores unpriced reads', () => {
    expect(windowPrices([{ tau_ms: 200_000, up_bid: null, up_ask: 0.5 }]).up_open_c).toBeNull();
  });
});
