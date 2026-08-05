// metals-15m — fair value, fee band, field shapes, window classification.
//
// The contract worth protecting here is that fair value is ARITHMETIC once the
// window opens (mu = 0, strike locked) and that the fee band is wide enough to
// swallow most apparent edges. If a future change makes the band narrow or the
// model directional, these fail.

import { describe, it, expect } from 'vitest';
import {
  fairYes,
  feeCentsAt,
  feeBandPp,
  priceCents,
  fpNum,
  classifyWindows,
  buildPayload,
  METALS,
} from '../src/engine/metals-15m.js';

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const tau = (seconds) => seconds / SECONDS_PER_YEAR;

describe('fairYes', () => {
  it('is ~50% when spot sits exactly on the strike', () => {
    const p = fairYes({ spot: 4241.34, strike: 4241.34, sigmaAnnual: 0.15, tauYears: tau(450) });
    // Tiny negative drift from the -sigma^2*tau/2 Ito term, so just under 0.5.
    expect(p).toBeGreaterThan(0.49);
    expect(p).toBeLessThanOrEqual(0.5);
  });

  it('rises above 50% when spot is over the strike mid-window', () => {
    const p = fairYes({ spot: 4243.14, strike: 4241.34, sigmaAnnual: 0.15, tauYears: tau(720) });
    expect(p).toBeGreaterThan(0.5);
    // The whole product claim: three minutes in and $1.80 over, fair is NOT 50c.
    expect(p).toBeGreaterThan(0.6);
  });

  it('falls below 50% when spot is under the strike', () => {
    const p = fairYes({ spot: 4239.5, strike: 4241.34, sigmaAnnual: 0.15, tauYears: tau(720) });
    expect(p).toBeLessThan(0.4);
  });

  it('collapses to the indicator as time runs out', () => {
    expect(fairYes({ spot: 4242, strike: 4241.34, sigmaAnnual: 0.15, tauYears: 0 })).toBe(1);
    expect(fairYes({ spot: 4240, strike: 4241.34, sigmaAnnual: 0.15, tauYears: 0 })).toBe(0);
  });

  it('is monotonic in spot', () => {
    const at = (s) => fairYes({ spot: s, strike: 62.144, sigmaAnnual: 0.3, tauYears: tau(600) });
    expect(at(62.0)).toBeLessThan(at(62.144));
    expect(at(62.144)).toBeLessThan(at(62.3));
  });

  it('returns null on unusable inputs rather than guessing', () => {
    expect(fairYes({ spot: 0, strike: 100, sigmaAnnual: 0.2, tauYears: tau(300) })).toBeNull();
    expect(fairYes({ spot: 100, strike: 0, sigmaAnnual: 0.2, tauYears: tau(300) })).toBeNull();
  });

  it('carries NO drift term — a pure momentum thesis must not sneak back in', () => {
    // Same inputs, symmetric around the strike: the two sides must mirror.
    const up = fairYes({ spot: 101, strike: 100, sigmaAnnual: 0.2, tauYears: tau(450) });
    const down = fairYes({ spot: 100 * (100 / 101), strike: 100, sigmaAnnual: 0.2, tauYears: tau(450) });
    expect(up + down).toBeCloseTo(1, 2);
  });
});

describe('fees', () => {
  it('matches the published quadratic schedule', () => {
    expect(feeCentsAt(0.5)).toBeCloseTo(1.75, 6);
    expect(feeCentsAt(0.7)).toBeCloseTo(1.47, 6);
    expect(feeCentsAt(0.9)).toBeCloseTo(0.63, 6);
  });

  it('band at 50c is ~4-5c wide with a 3c spread — the honest headline', () => {
    const band = feeBandPp({ fair: 0.5, bidCents: 44, askCents: 47 });
    expect(band).toBeGreaterThan(4);
    expect(band).toBeLessThan(5.5);
  });

  it('band survives a one-sided book (no spread contribution)', () => {
    expect(feeBandPp({ fair: 0.5, bidCents: null, askCents: null })).toBeCloseTo(3.5, 6);
  });
});

describe('field shapes', () => {
  it('reads the *_dollars string shape', () => {
    expect(priceCents({ yes_bid_dollars: '0.4400' }, 'yes_bid')).toBe(44);
    expect(priceCents({ yes_ask_dollars: '0.4600' }, 'yes_ask')).toBe(46);
  });

  it('falls back to the legacy numeric cent shape', () => {
    expect(priceCents({ yes_bid: 44 }, 'yes_bid')).toBe(44);
  });

  it('reads *_fp volume/OI strings', () => {
    expect(fpNum({ volume_fp: '2921.65' }, 'volume')).toBeCloseTo(2921.65);
    expect(fpNum({ open_interest_fp: '1760.06' }, 'open_interest')).toBeCloseTo(1760.06);
    expect(fpNum({ volume: 12 }, 'volume')).toBe(12);
  });
});

describe('classifyWindows', () => {
  const now = Date.parse('2026-08-05T16:35:00Z');
  const markets = [
    { ticker: 'A', open_time: '2026-08-05T16:30:00Z', close_time: '2026-08-05T16:45:00Z' },
    { ticker: 'B', open_time: '2026-08-05T16:45:00Z', close_time: '2026-08-05T17:00:00Z' },
    { ticker: 'C', open_time: '2026-08-05T17:00:00Z', close_time: '2026-08-05T17:15:00Z' },
  ];

  it('picks the live window and the nearest next one', () => {
    const { active, next } = classifyWindows(markets, now);
    expect(active.ticker).toBe('A');
    expect(next.ticker).toBe('B');
  });

  it('returns no active window once everything is in the future', () => {
    const { active, next } = classifyWindows(markets, Date.parse('2026-08-05T16:00:00Z'));
    expect(active).toBeNull();
    expect(next.ticker).toBe('A');
  });
});

describe('buildPayload', () => {
  const now = Date.parse('2026-08-05T16:38:00Z');
  const active = {
    ticker: 'KXGOLD15M-26AUG051245-45',
    event_ticker: 'KXGOLD15M-26AUG051245',
    open_time: '2026-08-05T16:30:00Z',
    close_time: '2026-08-05T16:45:00Z',
    floor_strike: 4241.34,
    yes_bid_dollars: '0.4400',
    yes_ask_dollars: '0.4600',
    volume_fp: '2921.65',
    open_interest_fp: '1760.06',
  };
  const spot = { price: 4243.0, publishTimeMs: now - 3000 };
  const stats = { sigma_annual: 0.15 };

  it('emits the LOCKED envelope shape', () => {
    const env = buildPayload(METALS.gold, { markets: [active], spot, stats, now });
    expect(Object.keys(env).sort()).toEqual(['_raw', 'as_of', 'data', 'stale']);
    expect(env.stale).toBe(false);
    expect(env.data.strike).toBe(4241.34);
    expect(env.data.book.yes_bid).toBe(44);
    expect(env.data.book.mid).toBe(45);
    expect(env.data.window.seconds_remaining).toBe(420);
  });

  it('computes fair value above the mid when spot is over the strike', () => {
    const env = buildPayload(METALS.gold, { markets: [active], spot, stats, now });
    expect(env.data.fair_yes).toBeGreaterThan(0.5);
    expect(env.data.fee_band_pp).toBeGreaterThan(0);
    expect(env.data.divergence_pp).toBeGreaterThan(0);
  });

  it('flags warming while the vol buffer is cold instead of publishing a guess', () => {
    const env = buildPayload(METALS.gold, { markets: [active], spot, stats: null, now });
    expect(env.data.quality).toBe('warming');
    expect(env.data.fair_yes).toBeNull();
    expect(env.data.divergence_pp).toBeNull();
  });

  it('reports market_closed when Kalshi lists nothing at all', () => {
    const env = buildPayload(METALS.gold, { markets: [], spot, stats, now });
    expect(env.data.market_closed).toBe(true);
    expect(env.data.quality).toBe('closed');
    expect(env.data.next_window).toBeNull();
  });

  it('reports between_windows when only a future window is listed', () => {
    const future = { ...active, open_time: '2026-08-05T17:00:00Z', close_time: '2026-08-05T17:15:00Z' };
    const env = buildPayload(METALS.gold, { markets: [future], spot, stats, now });
    expect(env.data.market_closed).toBe(true);
    expect(env.data.quality).toBe('between_windows');
    expect(env.data.next_window.strike_locks_at).toBe('2026-08-05T17:00:00Z');
  });

  it('never emits a raw payload for a strike-less (unopened) market', () => {
    const noStrike = { ...active, floor_strike: null };
    const env = buildPayload(METALS.gold, { markets: [noStrike], spot, stats, now });
    expect(env.data.fair_yes).toBeNull();
    expect(env.data.quality).toBe('no_strike');
  });
});
