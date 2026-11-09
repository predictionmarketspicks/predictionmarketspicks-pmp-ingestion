// Oil delta-bridge (site repo handoffs/OIL_EDGE_DEEP_DIVE_2026-11-09.md U1).
//
//   spot = yahoo(t_q) + (proxy_raw(now) − proxy_raw(t_q)),  t_q = Yahoo regularMarketTime
//
// The Yahoo named-month print is the LEVEL (the contract KXWTI settles on); the
// live proxy supplies only the MOVE since that print. Frozen proxy (> 120 s), no
// sample at t_q, or an implausible move ⇒ the raw print is used and the 120 s
// age gate demotes the tier. The proxy's vendor never appears in spot_source.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const NOW = new Date('2026-11-10T15:36:00Z'); // Tue 10:36 ET
const NOW_MS = NOW.getTime();
const MIN = 60_000;

// Yahoo named-month print: $87.40 as of 12 minutes ago (10-min delay + cache).
const YAHOO_PRINT = { price: 87.4, publishTimeMs: NOW_MS - 12 * MIN, source: 'yahoo_clz26_nym', symbol: 'CLZ26.NYM' };

// Mutable proxy state the mocks read.
const proxy = { now: null, atAnchor: null };

vi.mock('../src/feeds/kalshi.js', () => ({ getQuote: () => null }));
vi.mock('../src/feeds/pyth.js', () => ({
  WTI_FRONT_MONTH_SYMBOL: 'WTI',
  getPrice: (sym) => (sym === 'WTI_PROXY/USD' ? proxy.now : null),
}));
vi.mock('../src/feeds/wti-proxy.js', () => ({
  WTI_PROXY_SYMBOL: 'WTI_PROXY/USD',
  wtiProxyRawAt: () => proxy.atAnchor,
}));
vi.mock('../src/feeds/options-provider.js', () => {
  const chainFor = () => {
    const s = 76.4;
    const contracts = [];
    for (let i = -8; i <= 8; i++) {
      const strike = Math.round(s * (1 + i * 0.01) * 2) / 2;
      const iv = 0.34 + Math.abs(i) * 0.004;
      for (const contractType of ['call', 'put']) {
        contracts.push({ strike, iv, contractType, volume24h: 500, openInterest: 2000, delta: contractType === 'call' ? 0.5 : -0.5, gamma: 0.01, underlyingPrice: s });
      }
    }
    return { contracts };
  };
  return { getChain: chainFor, fetchPrevClose: async () => null };
});
vi.mock('../src/engine/drift.js', () => ({ estimateDrift: async () => ({ mu: 0.05, source: 'test', confidence: 'low' }) }));
vi.mock('../src/engine/vol.js', () => ({
  warmVolCache: async () => {},
  estimateVol: (iv) => ({ sigma_blend: iv * 0.95, sigma_iv: iv, sigma_rv20: iv * 0.9, source: 'test_blend' }),
}));
vi.mock('../src/engine/short-horizon-vol.js', () => ({
  getShortHorizonStats: () => ({ sigma_annual: 0.45, mu_annual: 0, mu_annual_raw: 0, nTicks: 300, lookbackActualMin: 15, source: 'test' }),
}));
vi.mock('../src/engine/metals-15m.js', () => ({ getMetals15mReference: () => null }));
vi.mock('../src/feeds/brti-spot.js', () => ({ getBrtiSpot: () => null }));
vi.mock('../src/feeds/btc-spot.js', () => ({ getBtcSpot: () => null }));
vi.mock('../src/feeds/yahoo-oil.js', () => ({
  getOilSpot: () => ({ price: 87.1, source: 'yahoo_cl_f', publishTimeMs: NOW_MS - 14 * MIN }),
  getContractSpot: async () => YAHOO_PRINT,
}));
vi.mock('../src/feeds/uso-synthetic.js', () => ({ synthesizeWtiSpot: async () => null }));
vi.mock('../src/feeds/fred.js', () => ({ getFredDailyClose: async () => null }));
vi.mock('../src/feeds/kalshi-series.js', () => ({ getActiveSettleContract: async () => ({ yyyymm: '202612', contract: 'CLZ26' }) }));
vi.mock('../src/feeds/massive.js', () => ({ isOptionsMarketOpen: () => true }));
vi.mock('../src/feeds/kalshi-event.js', () => ({
  fetchEvent: async () => null,
  getNextEvent: async () => null,
  refetchEventMarkets: async () => ({ markets: [], fetchedAtMs: null }),
}));
vi.mock('../src/observability/health.js', () => ({ recordGuardRejection: async () => {}, recordGuardOk: async () => {} }));
vi.mock('../src/delivery/discord.js', () => ({ postBotLog: async () => {} }));
vi.mock('../src/delivery/supabase.js', () => ({ getClient: () => { throw new Error('no db in tests'); } }));

function oilEvent() {
  const markets = [];
  for (let i = -10; i <= 10; i++) {
    const k = Math.round((87.5 + i * 0.5) * 100) / 100;
    const z = (87.5 - k) / 2;
    const p = 1 / (1 + Math.exp(-1.9 * z));
    const mid = Math.min(0.97, Math.max(0.03, Math.round(p * 100) / 100));
    markets.push({ ticker: `KXWTI-26NOV10-${k}`, floorStrike: k, yesBid: Math.max(0.01, mid - 0.01), yesAsk: Math.min(0.99, mid + 0.01), lastPrice: mid, volume24h: 400, openInterest: 900 });
  }
  return { eventTicker: 'KXWTI-26NOV10', closeTime: '2026-11-10T19:30:00Z', markets, fetchedAtMs: NOW_MS - 5000 };
}

describe('bridgeOilSpot — the arithmetic', () => {
  let bridgeOilSpot;
  beforeEach(async () => ({ bridgeOilSpot } = await import('../src/engine/commodity-base.js')));

  it('adds the proxy move since the print to the Yahoo level and stamps _bridged', () => {
    const out = bridgeOilSpot(YAHOO_PRINT, {
      proxyNow: { price: 88.95, rawPrice: 87.95, publishTimeMs: NOW_MS - 4_000 },
      proxyAtAnchor: 87.6,
      nowMs: NOW_MS,
    });
    // level 87.40 + (87.95 − 87.60) = 87.75 — rawPrice is used, not the basis-adjusted price
    expect(out.price).toBeCloseTo(87.75, 6);
    expect(out.source).toBe('yahoo_clz26_nym_bridged');
    expect(out.publishTimeMs).toBe(NOW_MS - 4_000); // as-of the proxy's last print
    expect(out.bridge).toMatchObject({ delta: 0.35, anchorAgeS: 720, proxyAgeS: 4 });
  });

  it('a negative move bridges down', () => {
    const out = bridgeOilSpot(YAHOO_PRINT, {
      proxyNow: { price: 87.0, publishTimeMs: NOW_MS - 1_000 },
      proxyAtAnchor: 87.52,
      nowMs: NOW_MS,
    });
    expect(out.price).toBeCloseTo(86.88, 6);
  });

  it('falls back (null) when the proxy is frozen for more than 120 s', () => {
    expect(bridgeOilSpot(YAHOO_PRINT, {
      proxyNow: { price: 87.9, publishTimeMs: NOW_MS - 121_000 },
      proxyAtAnchor: 87.6,
      nowMs: NOW_MS,
    })).toBeNull();
    // 120 s exactly still bridges (≤).
    expect(bridgeOilSpot(YAHOO_PRINT, {
      proxyNow: { price: 87.9, publishTimeMs: NOW_MS - 120_000 },
      proxyAtAnchor: 87.6,
      nowMs: NOW_MS,
    })).not.toBeNull();
  });

  it('falls back when there is no proxy sample at the print time, no proxy at all, or no print timestamp', () => {
    const live = { price: 87.9, publishTimeMs: NOW_MS - 2_000 };
    expect(bridgeOilSpot(YAHOO_PRINT, { proxyNow: live, proxyAtAnchor: null, nowMs: NOW_MS })).toBeNull();
    expect(bridgeOilSpot(YAHOO_PRINT, { proxyNow: null, proxyAtAnchor: 87.6, nowMs: NOW_MS })).toBeNull();
    expect(bridgeOilSpot({ ...YAHOO_PRINT, publishTimeMs: null }, { proxyNow: live, proxyAtAnchor: 87.6, nowMs: NOW_MS })).toBeNull();
    expect(bridgeOilSpot({ ...YAHOO_PRINT, publishTimeMs: undefined }, { proxyNow: live, proxyAtAnchor: 87.6, nowMs: NOW_MS })).toBeNull();
  });

  it('refuses a move larger than 3% of the level (a bad print is not a move)', () => {
    expect(bridgeOilSpot(YAHOO_PRINT, {
      proxyNow: { price: 90.9, publishTimeMs: NOW_MS - 2_000 },
      proxyAtAnchor: 87.6, // +3.30 = 3.8%
      nowMs: NOW_MS,
    })).toBeNull();
  });

  it('never names the proxy vendor in the source stamp', () => {
    const out = bridgeOilSpot(YAHOO_PRINT, { proxyNow: { price: 87.7, publishTimeMs: NOW_MS }, proxyAtAnchor: 87.6, nowMs: NOW_MS });
    expect(out.source).not.toMatch(/hyperliquid|xyz|hl|perp/i);
    expect(JSON.stringify(out)).not.toMatch(/hyperliquid|xyz:CL/i);
  });
});

describe('computeSnapshot — the oil ladder with the bridge wired in', () => {
  let computeSnapshot;
  let COMMODITIES;
  beforeEach(async () => {
    ({ computeSnapshot } = await import('../src/engine/commodity-base.js'));
    ({ COMMODITIES } = await import('../src/engine/commodities.js'));
    vi.useFakeTimers({ now: NOW_MS, toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('live proxy ⇒ every row carries the bridged spot, the _bridged stamp and no stale demotion', async () => {
    proxy.now = { price: 87.95, rawPrice: 87.95, publishTimeMs: NOW_MS - 3_000 };
    proxy.atAnchor = 87.6;
    const snap = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    expect(snap).not.toBeNull();
    expect(snap.rows.length).toBeGreaterThan(0);
    for (const r of snap.rows) {
      expect(r.spot_price).toBeCloseTo(87.75, 6);
      expect(r.spot_source).toBe('yahoo_clz26_nym_bridged');
      expect(r.divergence_warning).toBe(false);
    }
    expect(snap.meta.spotPrice).toBeCloseTo(87.75, 6);
    expect(snap.meta.spotSource).toBe('yahoo_clz26_nym_bridged');
    expect(snap.meta.spotPublishTimeMs).toBe(NOW_MS - 3_000);
    expect(snap.meta.spotAgeS).toBe(3);
  });

  it('frozen proxy ⇒ raw Yahoo print, no _bridged stamp, and the 120 s gate demotes the tier', async () => {
    proxy.now = { price: 87.95, rawPrice: 87.95, publishTimeMs: NOW_MS - 10 * MIN };
    proxy.atAnchor = 87.6;
    const snap = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    expect(snap).not.toBeNull();
    for (const r of snap.rows) {
      expect(r.spot_price).toBeCloseTo(87.4, 6);
      expect(r.spot_source).toBe('yahoo_clz26_nym');
      expect(r.divergence_warning).toBe(true);
      // Demotion is one notch: nothing can be STRONG off a 12-minute-old print.
      expect(r.fused_confidence).not.toBe('STRONG');
      if (r.direction !== 'PASS') expect(r.rationale).toMatch(/last published 720s ago \(max 120s\)/);
    }
    expect(snap.meta.spotAgeS).toBe(720);
    expect(snap.meta.topTier).not.toBe('STRONG');
  });

  it('proxy never polled ⇒ same raw fallback (fail open, demoted)', async () => {
    proxy.now = null;
    proxy.atAnchor = null;
    const snap = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    expect(snap).not.toBeNull();
    expect(snap.rows[0].spot_source).toBe('yahoo_clz26_nym');
    expect(snap.rows[0].divergence_warning).toBe(true);
  });

  it('the bridge is oil-only: a metals config never calls it even with a live proxy', async () => {
    proxy.now = { price: 87.95, rawPrice: 87.95, publishTimeMs: NOW_MS - 3_000 };
    proxy.atAnchor = 87.6;
    expect(COMMODITIES.gold.bridgeSpotWithProxy ?? false).toBe(false);
    expect(COMMODITIES.silver.bridgeSpotWithProxy ?? false).toBe(false);
  });
});

describe('wtiProxyRawAt — the proxy history the bridge reads', () => {
  it('returns the last raw sample at or before t within the gap, else null', async () => {
    vi.doUnmock('../src/feeds/wti-proxy.js');
    vi.resetModules();
    const mod = await import('../src/feeds/wti-proxy.js');
    mod._resetWtiProxy();
    mod._seedWtiProxySamples([
      { t: 1_000_000, raw: 87.5 },
      { t: 1_010_000, raw: 87.55 },
      { t: 1_020_000, raw: 87.6 },
    ]);
    expect(mod.wtiProxyRawAt(1_012_000)).toBe(87.55);
    expect(mod.wtiProxyRawAt(1_020_000)).toBe(87.6);
    expect(mod.wtiProxyRawAt(1_070_000, 60_000)).toBe(87.6); // 50 s after the last sample, inside a 60 s gap
    expect(mod.wtiProxyRawAt(1_090_000, 60_000)).toBeNull(); // 70 s after — outside the gap
    expect(mod.wtiProxyRawAt(999_000)).toBeNull(); // before the first sample
    expect(mod.wtiProxyRawAt(NaN)).toBeNull();
  });
});
