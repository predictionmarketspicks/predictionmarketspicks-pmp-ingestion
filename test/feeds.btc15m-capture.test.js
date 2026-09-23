// KXBTC15M one-second capture (feeds/kalshi-btc15m.js) + the 1s public spot
// (feeds/coinbase-ws.js). Message shapes are the live frames seen on the Fly
// machine 2026-09-23 (docs.kalshi.com/websockets channel names verified).

import { describe, it, expect } from 'vitest';
import {
  windowCloseMs,
  btc15mTicker,
  emptyBook,
  applySnapshot,
  applyDelta,
  bookTop,
  tradeRow,
  bookRow,
} from '../src/feeds/kalshi-btc15m.js';
import { parseCoinbaseTicker } from '../src/feeds/coinbase-ws.js';

describe('window + ticker', () => {
  it('the live window closes at the next quarter-hour strictly after now', () => {
    const t = Date.parse('2026-09-23T17:18:04Z');
    expect(new Date(windowCloseMs(t)).toISOString()).toBe('2026-09-23T17:30:00.000Z');
    // Exactly on a boundary, that window has closed — the next one is live.
    expect(new Date(windowCloseMs(Date.parse('2026-09-23T17:30:00Z'))).toISOString()).toBe('2026-09-23T17:45:00.000Z');
  });

  it('ticker encodes the ET close (matches Kalshi’s own listing)', () => {
    expect(btc15mTicker(Date.parse('2026-09-23T17:30:00Z'))).toEqual({
      market: 'KXBTC15M-26SEP231330-30',
      event: 'KXBTC15M-26SEP231330',
    });
    // Midnight ET rolls the date and prints hour 00 (listed: opens 03:45Z).
    expect(btc15mTicker(Date.parse('2026-09-24T04:00:00Z')).market).toBe('KXBTC15M-26SEP240000-00');
    expect(btc15mTicker(Date.parse('2026-09-24T03:45:00Z')).market).toBe('KXBTC15M-26SEP232345-45');
  });

  it('standard time shifts the ET offset to −5', () => {
    expect(btc15mTicker(Date.parse('2026-12-01T15:15:00Z')).market).toBe('KXBTC15M-26DEC011015-15');
  });
});

describe('order book', () => {
  const snap = {
    market_ticker: 'M',
    yes_dollars_fp: [['0.9850', '10.00'], ['0.9860', '2605.07']],
    no_dollars_fp: [['0.0120', '50.00'], ['0.0130', '4172.67']],
  };

  it('YES ask is 1 − best NO bid; deci-cent precision survives', () => {
    const b = emptyBook();
    applySnapshot(b, snap);
    expect(bookTop(b)).toEqual({ yesBid: 0.986, bidSize: 2605.07, yesAsk: 0.987, askSize: 4172.67 });
  });

  it('deltas add, subtract and remove levels', () => {
    const b = emptyBook();
    applySnapshot(b, snap);
    applyDelta(b, { side: 'yes', price_dollars: '0.9860', delta_fp: '-2605.07' });
    expect(bookTop(b).yesBid).toBe(0.985);
    applyDelta(b, { side: 'no', price_dollars: '0.0140', delta_fp: '5.00' });
    expect(bookTop(b)).toMatchObject({ yesAsk: 0.986, askSize: 5 });
  });

  it('an empty side is null, never zero', () => {
    const b = emptyBook();
    applySnapshot(b, { market_ticker: 'M', yes_dollars_fp: [['0.40', '1.00']] });
    expect(bookTop(b)).toEqual({ yesBid: 0.4, bidSize: 1, yesAsk: null, askSize: null });
  });
});

describe('rows', () => {
  const w = { market: 'KXBTC15M-26SEP231330-30', event: 'KXBTC15M-26SEP231330', closeMs: Date.parse('2026-09-23T17:30:00Z') };

  it('a book row carries tau, the averaging-window flag and the PUBLIC spot with its age', () => {
    const b = emptyBook();
    applySnapshot(b, { yes_dollars_fp: [['0.5000', '3.00']], no_dollars_fp: [['0.4900', '4.00']] });
    const r = bookRow(w, b, Date.parse('2026-09-23T17:29:30Z'), { price: 84010.025, ageMs: 812.4, source: 'coinbase_ws' });
    expect(r).toMatchObject({ tau_ms: 30_000, in_avg_window: true, yes_bid: 0.5, yes_ask: 0.51, pub_spot: 84010.025, pub_spot_age_ms: 812, pub_spot_source: 'coinbase_ws' });
    expect(Object.keys(r).some((k) => /ref|brti|cf_|avg_60/.test(k))).toBe(false);
    expect(bookRow(w, b, Date.parse('2026-09-23T17:20:00Z'), null).in_avg_window).toBe(false);
  });

  it('no row before the snapshot, or when the book is empty', () => {
    expect(bookRow(w, emptyBook(), Date.now(), null)).toBeNull();
    const b = emptyBook();
    applySnapshot(b, {});
    expect(bookRow(w, b, Date.now(), null)).toBeNull();
  });

  it('trade rows keep fractional contracts and refuse junk', () => {
    const msg = {
      trade_id: '0723f264-a371-9b3a-74d3-af1bf10c1d48', market_ticker: w.market,
      yes_price_dollars: '0.9880', count_fp: '0.01', taker_side: 'yes', ts_ms: 1790184251047,
    };
    expect(tradeRow(msg, () => w.event)).toMatchObject({ yes_price: 0.988, count: 0.01, taker_side: 'yes', event_ticker: w.event });
    expect(tradeRow({ ...msg, taker_side: 'up' }, () => w.event)).toBeNull();
    expect(tradeRow({ ...msg, trade_id: undefined }, () => w.event)).toBeNull();
  });
});

describe('coinbase 1s spot', () => {
  it('mid of the quote, never the last trade; future timestamps clamp to now', () => {
    const now = Date.parse('2026-09-23T17:19:02Z');
    const q = parseCoinbaseTicker({ type: 'ticker', price: '84010.02', best_bid: '84010.02', best_ask: '84010.03', time: '2026-09-23T17:19:01.643760Z' }, now);
    expect(q.price).toBeCloseTo(84010.025, 6);
    expect(q.publishTimeMs).toBe(Date.parse('2026-09-23T17:19:01.643Z'));
    expect(parseCoinbaseTicker({ type: 'ticker', best_bid: '1', best_ask: '2', time: '2026-09-23T17:20:00Z' }, now).publishTimeMs).toBe(now);
  });

  it('crossed, one-sided or non-ticker frames are not a price', () => {
    expect(parseCoinbaseTicker({ type: 'ticker', best_bid: '2', best_ask: '1' })).toBeNull();
    expect(parseCoinbaseTicker({ type: 'ticker', best_bid: '0', best_ask: '1' })).toBeNull();
    expect(parseCoinbaseTicker({ type: 'subscriptions' })).toBeNull();
  });
});
