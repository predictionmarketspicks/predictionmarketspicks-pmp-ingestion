// Delta filter tests — `0.15 ≤ |Δ| ≤ 0.85` per plan §10, with passthrough on
// missing delta so the bridge-week 15-min-delayed Massive tier (greeks: {} on
// weekends and off-hours) still produces a chain. The passthrough flips off
// implicitly after Mon/Tue real-time cutover when greeks populate live.

import { describe, it, expect } from 'vitest';
import {
  passesDeltaFilter,
  passesQualityFilters,
  isSpeculativeOption,
  isOptionsMarketOpen,
  isUsMarketHoliday,
} from '../src/feeds/massive.js';

describe('passesDeltaFilter', () => {
  it('keeps contracts with |delta| in [0.15, 0.85]', () => {
    expect(passesDeltaFilter({ delta: 0.5 })).toBe(true);
    expect(passesDeltaFilter({ delta: -0.5 })).toBe(true);
    expect(passesDeltaFilter({ delta: 0.15 })).toBe(true);
    expect(passesDeltaFilter({ delta: 0.85 })).toBe(true);
  });

  it('drops contracts with |delta| < 0.15 (deep OTM)', () => {
    expect(passesDeltaFilter({ delta: 0.05 })).toBe(false);
    expect(passesDeltaFilter({ delta: -0.10 })).toBe(false);
  });

  it('drops contracts with |delta| > 0.85 (deep ITM)', () => {
    expect(passesDeltaFilter({ delta: 0.95 })).toBe(false);
    expect(passesDeltaFilter({ delta: -0.92 })).toBe(false);
  });

  it('passes through contracts with null delta (bridge-week off-hours)', () => {
    // The 15-min delayed Massive tier returns greeks: {} on weekends and
    // outside US options market hours. Filter must not zero out the chain.
    expect(passesDeltaFilter({ delta: null })).toBe(true);
    expect(passesDeltaFilter({ delta: undefined })).toBe(true);
  });
});

// Options chain quality filters (handoff §2.3). Drop strikes that produce
// "options imply 0%" phantom rows — bid ≤ 0, vol < 50, spread/mid > 25%, OI < 100.
// Null-field passthrough so cold-start / off-hours doesn't zero the chain.
describe('passesQualityFilters', () => {
  const good = { bid: 0.45, ask: 0.50, volume24h: 500, openInterest: 1000 };

  it('keeps a healthy contract', () => {
    expect(passesQualityFilters(good)).toBe(true);
  });

  it('drops bid <= 0', () => {
    expect(passesQualityFilters({ ...good, bid: 0 })).toBe(false);
    expect(passesQualityFilters({ ...good, bid: -0.01 })).toBe(false);
  });

  it('drops volume < 50', () => {
    expect(passesQualityFilters({ ...good, volume24h: 49 })).toBe(false);
    expect(passesQualityFilters({ ...good, volume24h: 0 })).toBe(false);
  });

  it('keeps volume >= 50', () => {
    expect(passesQualityFilters({ ...good, volume24h: 50 })).toBe(true);
  });

  it('drops spread/mid > 25%', () => {
    // bid 0.40, ask 0.60 → mid 0.50, spread 0.20 → 0.20/0.50 = 40%
    expect(passesQualityFilters({ ...good, bid: 0.40, ask: 0.60 })).toBe(false);
  });

  it('keeps spread/mid <= 25%', () => {
    // bid 0.45, ask 0.55 → mid 0.50, spread 0.10 → 20%
    expect(passesQualityFilters({ ...good, bid: 0.45, ask: 0.55 })).toBe(true);
  });

  it('drops open interest < 100', () => {
    expect(passesQualityFilters({ ...good, openInterest: 99 })).toBe(false);
    expect(passesQualityFilters({ ...good, openInterest: 0 })).toBe(false);
  });

  it('keeps open interest >= 100', () => {
    expect(passesQualityFilters({ ...good, openInterest: 100 })).toBe(true);
  });

  it('passes through null fields (cold-start / off-hours)', () => {
    expect(passesQualityFilters({})).toBe(true);
    expect(passesQualityFilters({ bid: null, ask: null, volume24h: null, openInterest: null })).toBe(true);
  });

  it('does not divide by zero on degenerate book', () => {
    // bid 0 disqualifies before the spread check, so we never see /0.
    // Belt-and-suspenders: a null bid with a non-null ask shouldn't compute spread.
    expect(passesQualityFilters({ ...good, bid: null, ask: 0.10 })).toBe(true);
  });
});

describe('isSpeculativeOption', () => {
  it('flags volume in (0, 150] as speculative', () => {
    expect(isSpeculativeOption({ volume24h: 50 })).toBe(true);
    expect(isSpeculativeOption({ volume24h: 100 })).toBe(true);
    expect(isSpeculativeOption({ volume24h: 150 })).toBe(true);
  });

  it('does not flag volume > 150 as speculative', () => {
    expect(isSpeculativeOption({ volume24h: 151 })).toBe(false);
    expect(isSpeculativeOption({ volume24h: 1000 })).toBe(false);
  });

  it('null volume is not speculative (passthrough — handled by quality filter)', () => {
    expect(isSpeculativeOption({})).toBe(false);
    expect(isSpeculativeOption({ volume24h: null })).toBe(false);
  });
});

// Market-hours gate — the single source of truth that keeps the trading bot
// from firing when OPRA is dark. Dates are constructed in UTC and map to ET
// (EDT = UTC-4 in June). Regression guard for the 2026-06-13 Saturday incident
// where bitcoin snapshotted every 15s on a closed market.
describe('isOptionsMarketOpen', () => {
  it('is CLOSED on a Saturday inside the 10–4 ET window', () => {
    // Sat 2026-06-13 13:51 ET (the incident timestamp) = 17:51 UTC
    expect(isOptionsMarketOpen(new Date('2026-06-13T17:51:00Z'))).toBe(false);
  });

  it('is CLOSED on a Sunday inside the 10–4 ET window', () => {
    expect(isOptionsMarketOpen(new Date('2026-06-14T18:00:00Z'))).toBe(false);
  });

  it('is OPEN on a normal weekday during RTH', () => {
    // Wed 2026-06-10 14:00 ET = 18:00 UTC
    expect(isOptionsMarketOpen(new Date('2026-06-10T18:00:00Z'))).toBe(true);
  });

  it('is CLOSED before 9:30 AM ET on a weekday', () => {
    // Wed 2026-06-10 09:00 ET = 13:00 UTC
    expect(isOptionsMarketOpen(new Date('2026-06-10T13:00:00Z'))).toBe(false);
  });

  it('is CLOSED at/after 4:00 PM ET on a weekday', () => {
    // Wed 2026-06-10 16:00 ET = 20:00 UTC (4pm is exclusive)
    expect(isOptionsMarketOpen(new Date('2026-06-10T20:00:00Z'))).toBe(false);
  });

  it('is CLOSED on a full-closure holiday that falls on a weekday', () => {
    // Juneteenth — Fri 2026-06-19 14:00 ET = 18:00 UTC
    expect(isOptionsMarketOpen(new Date('2026-06-19T18:00:00Z'))).toBe(false);
  });
});

describe('isUsMarketHoliday', () => {
  it('flags a verified 2026 NYSE full-closure holiday (Juneteenth)', () => {
    expect(isUsMarketHoliday(new Date('2026-06-19T18:00:00Z'))).toBe(true);
  });

  it('flags a verified 2027 holiday (Good Friday)', () => {
    // 2027-03-26 14:00 ET = 18:00 UTC (EDT)
    expect(isUsMarketHoliday(new Date('2027-03-26T18:00:00Z'))).toBe(true);
  });

  it('does not flag an ordinary trading day', () => {
    expect(isUsMarketHoliday(new Date('2026-06-10T18:00:00Z'))).toBe(false);
  });
});
