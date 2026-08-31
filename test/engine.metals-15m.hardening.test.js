// metals-15m hardening — parity with crypto-15m (EDGE_MARKETS §1.3).
//
// Every guard here is proven to FIRE on a planted bad input, with a fresh-input
// control alongside — a gate only ever seen passing is not verified.

import { describe, it, expect } from 'vitest';
import {
  buildPayload,
  priceCents,
  METALS,
  __test__,
} from '../src/engine/metals-15m.js';
import { buildPayload as buildCryptoPayload, CRYPTO_15M } from '../src/engine/crypto-15m.js';
import { maxOnchainAgeMs } from '../src/feeds/pythnet.js';

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
const freshSpot = { price: 4243.0, publishTimeMs: now - 3000 };
const stats = { sigma_annual: 0.15 };

// ── Diff 1: stale-spot gate refuses fair value ───────────────────────────────

describe('stale-spot gate (diff 1)', () => {
  it('control: fresh spot still prices', () => {
    const env = buildPayload(METALS.gold, { markets: [active], spot: freshSpot, stats, now });
    expect(env.data.quality).toBe('ok');
    expect(env.data.fair_yes).toBeGreaterThan(0.5);
  });

  it('FIRES: a 2-minute-old spot yields quality stale_spot and fair null', () => {
    const frozen = { price: 4243.0, publishTimeMs: now - 120_000 };
    const env = buildPayload(METALS.gold, { markets: [active], spot: frozen, stats, now });
    expect(env.data.quality).toBe('stale_spot');
    expect(env.data.fair_yes).toBeNull();
    expect(env.data.divergence_pp).toBeNull();
    expect(env.data.divergence_beyond_band).toBeNull();
    // The frozen reading itself is still reported, honestly aged.
    expect(env.data.spot).toBe(4243.0);
    expect(env.data.spot_age_s).toBeCloseTo(120);
  });

  it('FIRES: exactly at the boundary prices, one tick past it does not', () => {
    const atLimit = { price: 4243.0, publishTimeMs: now - __test__.MAX_SPOT_AGE_S * 1000 };
    const pastLimit = { price: 4243.0, publishTimeMs: now - (__test__.MAX_SPOT_AGE_S * 1000 + 1000) };
    expect(
      buildPayload(METALS.gold, { markets: [active], spot: atLimit, stats, now }).data.fair_yes,
    ).not.toBeNull();
    expect(
      buildPayload(METALS.gold, { markets: [active], spot: pastLimit, stats, now }).data.fair_yes,
    ).toBeNull();
  });

  it('FIRES: no spot at all is stale_spot, not a silent ok', () => {
    const env = buildPayload(METALS.gold, { markets: [active], spot: null, stats, now });
    expect(env.data.quality).toBe('stale_spot');
    expect(env.data.fair_yes).toBeNull();
  });
});

// ── Diff 2: quality-ladder order — dead feed beats warm-up ───────────────────

describe('quality-ladder order (diff 2)', () => {
  it('FIRES: stale spot AND cold sigma reports stale_spot, never warming', () => {
    // The pre-fix ladder checked sigma first, so a dead feed during a redeploy
    // presented as a routine 5-minute warm-up. Plant both faults at once.
    const frozen = { price: 4243.0, publishTimeMs: now - 300_000 };
    const env = buildPayload(METALS.gold, { markets: [active], spot: frozen, stats: null, now });
    expect(env.data.quality).toBe('stale_spot');
  });

  it('cold sigma with a FRESH spot is still warming', () => {
    const env = buildPayload(METALS.gold, { markets: [active], spot: freshSpot, stats: null, now });
    expect(env.data.quality).toBe('warming');
  });

  it('no_strike outranks both, matching crypto-15m', () => {
    const noStrike = { ...active, floor_strike: null };
    const frozen = { price: 4243.0, publishTimeMs: now - 300_000 };
    const env = buildPayload(METALS.gold, { markets: [noStrike], spot: frozen, stats: null, now });
    expect(env.data.quality).toBe('no_strike');
  });
});

// ── Diff 3: '0.0000'/'1.0000' one-sided books are no-book ────────────────────

describe('book sentinel (diff 3)', () => {
  it("FIRES: the string '0.0000' is the absence of a price, not 0c", () => {
    expect(priceCents({ yes_bid_dollars: '0.0000' }, 'yes_bid')).toBeNull();
    expect(priceCents({ yes_ask_dollars: '1.0000' }, 'yes_ask')).toBeNull();
    // Legacy numeric shape carries the same sentinels.
    expect(priceCents({ yes_bid: 0 }, 'yes_bid')).toBeNull();
    expect(priceCents({ yes_ask: 100 }, 'yes_ask')).toBeNull();
  });

  it('control: real quotes still parse in both shapes', () => {
    expect(priceCents({ yes_bid_dollars: '0.4400' }, 'yes_bid')).toBe(44);
    expect(priceCents({ yes_bid: 44 }, 'yes_bid')).toBe(44);
    expect(priceCents({ yes_ask_dollars: '0.9900' }, 'yes_ask')).toBe(99);
  });

  it('FIRES: a one-sided book yields mid null, which blocks the observation write', () => {
    // Planted no-book market: bid sentinel, real ask. Pre-fix this produced
    // mid = (0 + 46) / 2 = 23c and recorded it as the market baseline the
    // Brier record grades against.
    const oneSided = { ...active, yes_bid_dollars: '0.0000' };
    const env = buildPayload(METALS.gold, { markets: [oneSided], spot: freshSpot, stats, now });
    expect(env.data.book.yes_bid).toBeNull();
    expect(env.data.book.mid).toBeNull();
    expect(env.data.divergence_pp).toBeNull();
    // runMetals15mOnce gates recordFifteenMinObservation on d.book?.mid != null,
    // so mid === null IS the no-record proof for the graded baseline.
  });

  it('FIRES: the fully empty 0.0000/1.0000 book records nothing', () => {
    const empty = { ...active, yes_bid_dollars: '0.0000', yes_ask_dollars: '1.0000' };
    const env = buildPayload(METALS.gold, { markets: [empty], spot: freshSpot, stats, now });
    expect(env.data.book.yes_bid).toBeNull();
    expect(env.data.book.yes_ask).toBeNull();
    expect(env.data.book.mid).toBeNull();
  });
});

// ── Diff 4: elapsed_pct unified on 0-100 in both engines ─────────────────────

describe('elapsed_pct scale parity (diff 4)', () => {
  it('metals reports 0-100', () => {
    const env = buildPayload(METALS.gold, { markets: [active], spot: freshSpot, stats, now });
    // 8 minutes into a 15-minute window.
    expect(env.data.window.elapsed_pct).toBeCloseTo((8 / 15) * 100, 6);
  });

  it('crypto reports the SAME 0-100 scale (was 0-1)', () => {
    const btcActive = { ...active, ticker: 'KXBTC15M-X', event_ticker: 'KXBTC15M-X' };
    const spot = { price: 4243.0, publishTimeMs: now - 3000 };
    const env = buildCryptoPayload(CRYPTO_15M.btc, {
      markets: [btcActive],
      spot,
      stats,
      gradedCount: 0,
      now,
    });
    expect(env.data.window.elapsed_pct).toBeCloseTo((8 / 15) * 100, 6);
  });
});

// ── Diff 5: weekend on-chain age widening for the metals pair ────────────────

describe('pythnet weekend age gate (diff 5)', () => {
  const saturday = new Date('2026-08-29T12:00:00Z'); // getUTCDay() === 6
  const sunday = new Date('2026-08-30T12:00:00Z'); // 0
  const wednesday = new Date('2026-08-26T12:00:00Z'); // 3

  it('widens to 72h for XAU/XAG on Sat/Sun only', () => {
    expect(maxOnchainAgeMs('XAU/USD', saturday)).toBe(72 * 3600 * 1000);
    expect(maxOnchainAgeMs('XAG/USD', sunday)).toBe(72 * 3600 * 1000);
    expect(maxOnchainAgeMs('XAU/USD', wednesday)).toBe(24 * 3600 * 1000);
  });

  it('never widens non-metal symbols — the mainnet-beta trap stays shut', () => {
    expect(maxOnchainAgeMs('WTIV6', saturday)).toBe(24 * 3600 * 1000);
    expect(maxOnchainAgeMs('BTC/USD', sunday)).toBe(24 * 3600 * 1000);
  });
});
