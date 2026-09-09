// getBtcSpot() — the ref/pub split.
//
// This is a LICENSING boundary, not a preference. `ref` is the CF Benchmarks index
// (licensed, internal calculation only) and `pub` is the free exchange basket
// (publishable). A bug that swaps them publishes licensed benchmark data; a bug
// that returns null when one feed is alive stops the engines pricing. Both are
// tested, including the four freshness combinations.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const NOW = Date.UTC(2026, 8, 9, 14, 30, 0);

function cfObs(ageMs) {
  return { symbol: 'BRTI', price: 78476.83, publishTimeMs: NOW - ageMs, source: 'cf_benchmarks_brti' };
}
function basketObs(ageMs) {
  return { symbol: 'BTC/USD', price: 78450.12, publishTimeMs: NOW - ageMs, source: 'brti_basket' };
}

let cfValue = null;
let basketValue = null;

vi.mock('../src/feeds/cfbenchmarks.js', () => ({
  getCfIndex: () => cfValue,
  CF_MAX_AGE_MS: 15_000,
}));
vi.mock('../src/feeds/brti-spot.js', () => ({
  getBrtiSpot: () => basketValue,
}));

const { getBtcSpot } = await import('../src/feeds/btc-spot.js');

beforeEach(() => {
  cfValue = null;
  basketValue = null;
});
afterEach(() => {
  delete process.env.BTC_PUBLIC_SPOT;
});

describe('the four freshness combinations', () => {
  it('both fresh → price on the index, publish the basket', () => {
    cfValue = cfObs(2_000);
    basketValue = basketObs(5_000);
    const s = getBtcSpot({ now: NOW });
    expect(s.refSource).toBe('cf_benchmarks_brti');
    expect(s.ref.price).toBeCloseTo(78476.83, 4);
    expect(s.pubSource).toBe('brti_basket');
    expect(s.pub.price).toBeCloseTo(78450.12, 4);
  });

  it('index stale, basket fresh → both fall back to the basket (exactly today’s behaviour)', () => {
    cfValue = cfObs(60_000);
    basketValue = basketObs(5_000);
    const s = getBtcSpot({ now: NOW });
    expect(s.refSource).toBe('brti_basket');
    expect(s.pubSource).toBe('brti_basket');
  });

  it('index fresh, basket dead → price on the index, publish it ROUNDED and relabelled', () => {
    cfValue = cfObs(2_000);
    basketValue = basketObs(10 * 60_000);
    const s = getBtcSpot({ now: NOW });
    expect(s.refSource).toBe('cf_benchmarks_brti');
    // $10 rounding: coarse enough not to be a redistributed benchmark, honest
    // enough to display, and the source tag says which it is.
    expect(s.pub.price).toBe(78480);
    expect(s.pubSource).toBe('cf_benchmarks_brti_rounded');
  });

  it('both dead → null, so the caller REFUSES to price rather than using a stale number', () => {
    cfValue = cfObs(90_000);
    basketValue = basketObs(20 * 60_000);
    expect(getBtcSpot({ now: NOW })).toBeNull();
  });

  it('nothing at all → null', () => {
    expect(getBtcSpot({ now: NOW })).toBeNull();
  });
});

describe('the display flag', () => {
  it('BTC_PUBLIC_SPOT=ref publishes the raw index — only valid once Kalshi grants display rights', () => {
    cfValue = cfObs(2_000);
    basketValue = basketObs(5_000);
    const s = getBtcSpot({ now: NOW, publicMode: 'ref' });
    expect(s.pubSource).toBe('cf_benchmarks_brti');
    expect(s.pub.price).toBeCloseTo(78476.83, 4);
  });

  it('defaults to basket when the flag is unset — the licensing-safe default', () => {
    cfValue = cfObs(2_000);
    basketValue = basketObs(5_000);
    expect(getBtcSpot({ now: NOW }).pubSource).toBe('brti_basket');
  });

  it('ref mode still falls back to the basket when the index is stale', () => {
    cfValue = cfObs(60_000);
    basketValue = basketObs(5_000);
    expect(getBtcSpot({ now: NOW, publicMode: 'ref' }).pubSource).toBe('brti_basket');
  });
});

describe('ages are reported per number', () => {
  it('refAgeS measures the reference, pubAgeS the published one', () => {
    cfValue = cfObs(3_000);
    basketValue = basketObs(8_000);
    const s = getBtcSpot({ now: NOW });
    expect(s.refAgeS).toBeCloseTo(3, 1);
    expect(s.pubAgeS).toBeCloseTo(8, 1);
  });
});
