// EDGE_MARKETS 0.2 (2026-08-31): front-event selection must be chronological,
// never lexical — 26OCT02 sorts before 26SEP04 as a string, and every
// Sep 18–25 dual-listing window (plus inverted month-ends for daily series)
// would silently price the far event.
import { describe, it, expect } from 'vitest';
import { pickNextEvent, eventSortKey } from '../src/feeds/kalshi-event.js';

const ev = (ticker, extra = {}) => ({ event_ticker: ticker, ...extra });

describe('pickNextEvent', () => {
  // MCP_TRUTH_BUILD_STAMP_AND_CONVERSION_2026-11-10 U5: Kalshi lists KXGOLDD / KXSILVERD Mon–Thu
  // only, so on a Friday the only open event is Monday's — and that IS the right answer.
  it('on a Friday with only Monday\'s metals event open, Monday\'s event is the front event (no same-day guard)', () => {
    const fridayOpen = [ev('KXGOLDD-26NOV16', { close_time: '2026-11-16T22:00:00Z' })]; // Fri Nov 13: Thu settled, Mon listed
    expect(pickNextEvent(fridayOpen).event_ticker).toBe('KXGOLDD-26NOV16');
    const both = [ev('KXSILVERD-26NOV16', { close_time: '2026-11-16T22:00:00Z' }), ev('KXSILVERD-26NOV17', { close_time: '2026-11-17T22:00:00Z' })];
    expect(pickNextEvent(both).event_ticker).toBe('KXSILVERD-26NOV16');
  });
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
