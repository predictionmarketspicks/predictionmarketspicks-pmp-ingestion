// The strike-band predicate and the near-expiry threshold.
// handoffs/BITCOIN_EDGE_MU_CAP_SATURATION_2026-08-13.md §7.3 / §7.4

import { describe, it, expect } from 'vitest';
import {
  keepStrike,
  BTC_STRIKE_BAND_PCT,
  BTC_WING_MIN_BID,
  BTC_WING_MAX_ASK,
  BTC_WING_MAX_SPREAD,
  BTC_MIN_SECONDS_TO_CLOSE,
} from '../src/engine/thresholds.js';

const SPOT = 63_338;
const BAND = BTC_STRIKE_BAND_PCT;
const m = (floorStrike, yesBid, yesAsk) => ({ floorStrike, yesBid, yesAsk });

describe('keepStrike — inside the band', () => {
  it('keeps an at-the-money strike whatever the book looks like', () => {
    expect(keepStrike(m(SPOT, null, null), SPOT, BAND)).toBe(true);
    expect(keepStrike(m(SPOT, 0, 0), SPOT, BAND)).toBe(true);
  });

  it('keeps both edges of the band and drops just outside it', () => {
    // Just inside the rails — an exact `SPOT * (1 + BAND)` round-trips through
    // the division a hair over BAND, which is float noise, not a rule.
    expect(keepStrike(m(SPOT * (1 + BAND) - 1, 0, 0), SPOT, BAND)).toBe(true);
    expect(keepStrike(m(SPOT * (1 - BAND) + 1, 0, 0), SPOT, BAND)).toBe(true);
    expect(keepStrike(m(SPOT * (1 + BAND) + 100, 0, 0), SPOT, BAND)).toBe(false);
    expect(keepStrike(m(SPOT * (1 - BAND) - 100, 0, 0), SPOT, BAND)).toBe(false);
  });
});

describe('keepStrike — the wing needs a TRADEABLE book, not any book', () => {
  // This is the regression the whole change exists for: every deep-ITM strike
  // permanently quotes 0.99/1.00, so `yesBid > 0 && yesAsk > 0` was always true
  // and the union readmitted ~90 dead strikes per snapshot, each printing an
  // identical +0.5pp — the "long-only-YES" wall on the 2026-08-13 board.
  it('drops a permanently-pinned deep-ITM quote beyond the band', () => {
    expect(keepStrike(m(SPOT * 0.85, 0.99, 1.0), SPOT, BAND)).toBe(false);
  });

  it('drops the mirror-image dead OTM quote beyond the band', () => {
    expect(keepStrike(m(SPOT * 1.2, 0.0, 0.01), SPOT, BAND)).toBe(false);
  });

  it('keeps a genuine wing quote a trader could cross', () => {
    expect(keepStrike(m(SPOT * 0.9, 0.4, 0.5), SPOT, BAND)).toBe(true);
  });

  it('drops a wing quote whose spread is uncrossable', () => {
    const wide = BTC_WING_MAX_SPREAD + 0.02;
    expect(keepStrike(m(SPOT * 0.9, 0.3, 0.3 + wide), SPOT, BAND)).toBe(false);
  });

  it('holds the bid/ask rails exactly', () => {
    expect(keepStrike(m(SPOT * 0.9, BTC_WING_MIN_BID, BTC_WING_MAX_ASK), SPOT, BAND)).toBe(false);
    expect(keepStrike(m(SPOT * 0.9, BTC_WING_MIN_BID, BTC_WING_MIN_BID + BTC_WING_MAX_SPREAD), SPOT, BAND)).toBe(true);
    expect(keepStrike(m(SPOT * 0.9, BTC_WING_MIN_BID - 0.001, 0.5), SPOT, BAND)).toBe(false);
    expect(keepStrike(m(SPOT * 0.9, 0.9, BTC_WING_MAX_ASK + 0.001), SPOT, BAND)).toBe(false);
  });
});

describe('keepStrike — degenerate inputs', () => {
  it('drops a strikeless or spotless market rather than dividing by zero', () => {
    expect(keepStrike(m(null, 0.4, 0.5), SPOT, BAND)).toBe(false);
    expect(keepStrike(m(SPOT, 0.4, 0.5), 0, BAND)).toBe(false);
    expect(keepStrike(null, SPOT, BAND)).toBe(false);
  });
});

describe('near-expiry threshold', () => {
  // §7.2: 16,174 of 16,177 rows over 30 days sat under one minute to close, and
  // at T → 0 the CDF is a step function — model 0.0011 against a two-sided
  // 0.45/0.55 book read as a 54.9pp edge. The guard has to cover that slice.
  it('covers the sub-minute slice the whole backtest was fit on', () => {
    expect(BTC_MIN_SECONDS_TO_CLOSE).toBeGreaterThan(60);
  });
});
