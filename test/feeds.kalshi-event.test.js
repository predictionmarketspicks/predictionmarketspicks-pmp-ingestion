// EDGE_MARKETS 0.2 (2026-08-31): front-event selection must be chronological,
// never lexical — 26OCT02 sorts before 26SEP04 as a string, and every
// Sep 18–25 dual-listing window (plus inverted month-ends for daily series)
// would silently price the far event.
import { describe, it, expect } from 'vitest';
import { pickNextEvent, eventSortKey } from '../src/feeds/kalshi-event.js';

const ev = (ticker, extra = {}) => ({ event_ticker: ticker, ...extra });

describe('pickNextEvent', () => {
  it('picks September over October despite lexical inversion (weekly)', () => {
    expect(pickNextEvent([ev('KXGOLDW-26OCT02'), ev('KXGOLDW-26SEP04')]).event_ticker)
      .toBe('KXGOLDW-26SEP04');
  });
  it('picks Sep 30 over Oct 1 (daily month-end)', () => {
    expect(pickNextEvent([ev('KXWTI-26OCT01'), ev('KXWTI-26SEP30')]).event_ticker)
      .toBe('KXWTI-26SEP30');
  });
  it('picks Jun 26 over Jul 3', () => {
    expect(pickNextEvent([ev('KXWTIW-26JUL03'), ev('KXWTIW-26JUN26')]).event_ticker)
      .toBe('KXWTIW-26JUN26');
  });
  it('same-month pairs behave as before', () => {
    expect(pickNextEvent([ev('KXGOLDW-26SEP11'), ev('KXGOLDW-26SEP04')]).event_ticker)
      .toBe('KXGOLDW-26SEP04');
  });
  it('prefers the API close_time over the ticker when present', () => {
    const chosen = pickNextEvent([
      ev('KXGOLDW-26SEP11', { close_time: '2026-09-04T21:00:00Z' }),
      ev('KXGOLDW-26SEP04', { close_time: '2026-09-11T21:00:00Z' }),
    ]);
    // deliberately contradictory: the API field wins
    expect(chosen.event_ticker).toBe('KXGOLDW-26SEP11');
  });
  it('parses the trailing hour segment (hourly series)', () => {
    expect(eventSortKey(ev('KXBTCD-26SEP0417')) - eventSortKey(ev('KXBTCD-26SEP0410')))
      .toBe(7 * 3600 * 1000);
  });
  it('excludes unparseable tickers instead of letting them sort first', () => {
    expect(pickNextEvent([ev('KXWEIRD-NODATE'), ev('KXGOLDW-26SEP04')]).event_ticker)
      .toBe('KXGOLDW-26SEP04');
  });
  it('falls back to lexical when nothing parses (never kills the feed)', () => {
    expect(pickNextEvent([ev('B-NODATE'), ev('A-NODATE')]).event_ticker).toBe('A-NODATE');
  });
});
