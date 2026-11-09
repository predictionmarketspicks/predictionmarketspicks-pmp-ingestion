// Oil variance clock, LIVE (site repo handoffs/OIL_EDGE_DEEP_DIVE_2026-11-09.md U2).
//
// config.clockGoverns + an ACTIVE, fresh clock row ⇒ prob_physical is priced on T_clock
// (direction/edge/tier/mint read it); prob_clock is written beside it and equals it.
// A SHADOW row (active=false) or a stale row (> 14 d) ⇒ prob_physical stays on calendar
// time and prob_clock is the shadow (or null). Gold/silver (no clockGoverns) never
// change prob_physical here — the metals promotion is the Loop v2 auto-promote's call.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const NOW = new Date('2026-11-10T14:36:00Z'); // Tue 9:36 ET — the morning mint minute
const NOW_MS = NOW.getTime();

vi.mock('../src/feeds/kalshi.js', () => ({ getQuote: () => null }));
vi.mock('../src/feeds/pyth.js', () => ({
  WTI_FRONT_MONTH_SYMBOL: 'WTI',
  getPrice: (sym) => (sym === 'XAU/USD' ? { price: 4100, source: 'pyth_xau_usd', publishTimeMs: NOW_MS - 2000 } : null),
}));
vi.mock('../src/feeds/wti-proxy.js', () => ({ WTI_PROXY_SYMBOL: 'WTI_PROXY/USD', wtiProxyRawAt: () => null }));
vi.mock('../src/feeds/options-provider.js', () => {
  const chainFor = (etf) => {
    const s = { GLD: 377.2, USO: 76.4 }[etf];
    const contracts = [];
    for (let i = -8; i <= 8; i++) {
      const strike = Math.round(s * (1 + i * 0.01) * 2) / 2;
      const iv = 0.22 + Math.abs(i) * 0.004 + (etf === 'USO' ? 0.12 : 0);
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
  getOilSpot: () => ({ price: 87.4, source: 'yahoo_cl_f', publishTimeMs: null }),
  getContractSpot: async () => ({ price: 87.4, source: 'yahoo_clz26_nym', symbol: 'CLZ26.NYM', publishTimeMs: null }),
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

// The measured WTI profile (OIL_EDGE_DEEP_DIVE §0.2), hour 17 = the break.
const OIL_W = [0.40, 0.36, 0.87, 0.91, 1.09, 1.18, 0.82, 1.02, 2.29, 1.73, 1.96, 2.71, 2.72, 1.06, 1.38, 0.67, 0.33, 0, 0.23, 0.13, 0.52, 0.79, 0.48, 0.24];

function eventFor(c, spot, step, closeIso) {
  const markets = [];
  for (let i = -10; i <= 10; i++) {
    const k = Math.round((spot + i * step) * 100) / 100;
    const z = (spot - k) / (step * 4);
    const p = 1 / (1 + Math.exp(-1.9 * z));
    const mid = Math.min(0.97, Math.max(0.03, Math.round(p * 100) / 100));
    markets.push({ ticker: `T-${c}-${k}`, floorStrike: k, yesBid: Math.max(0.01, mid - 0.01), yesAsk: Math.min(0.99, mid + 0.01), lastPrice: mid, volume24h: 400, openInterest: 900 });
  }
  return { eventTicker: `EV-${c}`, closeTime: closeIso, markets, fetchedAtMs: NOW_MS - 5000 };
}
const oilEvent = () => eventFor('oil', 87.5, 0.5, '2026-11-10T19:30:00Z'); // 9:36 → 14:30 ET, the morning horizon
const goldEvent = () => eventFor('gold', 4100, 10, '2026-11-10T22:00:00Z');

const clockRow = (commodity, over = {}) => ({
  id: 77, commodity, method: 'variance_clock_v1', active: true, shadow: false,
  fit_at: '2026-11-09T12:00:00Z', knots: { hours_et: OIL_W, calendar: 'metals_globex' }, ...over,
});

let computeSnapshot; let COMMODITIES; let __setClocksForTest; let __resetClockLogForTest;
beforeEach(async () => {
  ({ computeSnapshot } = await import('../src/engine/commodity-base.js'));
  ({ COMMODITIES } = await import('../src/engine/commodities.js'));
  ({ __setClocksForTest } = await import('../src/engine/calibration.js'));
  ({ __resetClockLogForTest } = await import('../src/engine/variance-clock.js'));
  __resetClockLogForTest();
  __setClocksForTest([]);
});
afterEach(() => __setClocksForTest([]));

const priced = (snap) => snap.rows.filter((r) => r.prob_physical != null);

describe('oil config', () => {
  it('runs the clock LIVE: varianceClock + clockGoverns; the metals keep clockGoverns unset', () => {
    expect(COMMODITIES.oil.varianceClock).toBe(true);
    expect(COMMODITIES.oil.clockGoverns).toBe(true);
    expect(COMMODITIES.gold.clockGoverns ?? false).toBe(false);
    expect(COMMODITIES.silver.clockGoverns ?? false).toBe(false);
    expect(COMMODITIES.bitcoin.varianceClock ?? false).toBe(false);
  });
});

describe('oil — ACTIVE clock row governs prob_physical', () => {
  it('prob_physical equals prob_clock on every priced row and differs from the calendar-time run', async () => {
    const base = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    expect(base.meta.clockGoverns).toBe(false);
    __setClocksForTest([['oil', clockRow('oil')]]);
    const live = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    expect(live.meta.clockGoverns).toBe(true);
    expect(live.meta.clockMapId).toBe(77);
    const a = priced(base); const b = priced(live);
    expect(b.length).toBe(a.length);
    expect(b.length).toBeGreaterThan(5);
    let moved = 0;
    for (let i = 0; i < b.length; i++) {
      expect(b[i].strike).toBe(a[i].strike);
      expect(b[i].prob_clock).toBeCloseTo(b[i].prob_physical, 12);
      if (Math.abs(b[i].prob_physical - a[i].prob_physical) > 1e-6) moved += 1;
      // Same σ and spot: the risk-neutral options_prob (calendar T) is untouched.
      expect(b[i].options_prob).toBeCloseTo(a[i].options_prob, 12);
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('on the morning horizon the clock WIDENS the distribution: ITM strikes less certain, OTM more likely', async () => {
    // 9:36 → 14:30 ET crosses hours 9–14 whose weights average ≈ 1.9, so T_clock > T.
    const base = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    __setClocksForTest([['oil', clockRow('oil')]]);
    const live = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    const a = priced(base); const b = priced(live);
    for (let i = 0; i < b.length; i++) {
      if (a[i].prob_physical > 0.6) expect(b[i].prob_physical).toBeLessThan(a[i].prob_physical);
      if (a[i].prob_physical < 0.4) expect(b[i].prob_physical).toBeGreaterThan(a[i].prob_physical);
    }
  });

  it('a SHADOW row (active=false) writes prob_clock only — prob_physical stays on calendar time', async () => {
    const base = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    __setClocksForTest([['oil', clockRow('oil', { active: false, shadow: true })]]);
    const shadow = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    expect(shadow.meta.clockGoverns).toBe(false);
    const a = priced(base); const b = priced(shadow);
    let moved = 0;
    for (let i = 0; i < b.length; i++) {
      expect(b[i].prob_physical).toBeCloseTo(a[i].prob_physical, 12);
      expect(b[i].prob_clock).not.toBeNull();
      // Deep-ITM/OTM strikes saturate at 0/1 on both clocks; the mid-range must differ.
      if (b[i].prob_physical > 0.1 && b[i].prob_physical < 0.9 && Math.abs(b[i].prob_clock - b[i].prob_physical) > 1e-4) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('a stale ACTIVE row (> 14 d) fails open: calendar time, prob_clock null', async () => {
    const base = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    __setClocksForTest([['oil', clockRow('oil', { fit_at: '2026-10-20T12:00:00Z' })]]);
    const stale = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    expect(stale.meta.clockGoverns).toBe(false);
    const a = priced(base); const b = priced(stale);
    for (let i = 0; i < b.length; i++) {
      expect(b[i].prob_physical).toBeCloseTo(a[i].prob_physical, 12);
      expect(b[i].prob_clock).toBeNull();
    }
  });

  it('no clock row at all: identical to the pre-clock engine, prob_clock null', async () => {
    const snap = await computeSnapshot(COMMODITIES.oil, oilEvent(), { now: NOW });
    expect(snap.meta.clockGoverns).toBe(false);
    expect(snap.meta.clockMapId).toBeNull();
    for (const r of snap.rows) expect(r.prob_clock).toBeNull();
  });
});

describe('gold — an ACTIVE clock row does NOT govern without config.clockGoverns', () => {
  it('prob_physical is unchanged; prob_clock is written (the metals shadow contract)', async () => {
    const base = await computeSnapshot(COMMODITIES.gold, goldEvent(), { now: NOW });
    __setClocksForTest([['gold', clockRow('gold')]]);
    const withClock = await computeSnapshot(COMMODITIES.gold, goldEvent(), { now: NOW });
    expect(withClock.meta.clockGoverns).toBe(false);
    const a = priced(base); const b = priced(withClock);
    expect(b.length).toBeGreaterThan(0);
    for (let i = 0; i < b.length; i++) {
      expect(b[i].prob_physical).toBeCloseTo(a[i].prob_physical, 12);
      expect(b[i].prob_clock).not.toBeNull();
    }
  });
});

describe('fit-variance-clock --commodity oil — the capture → mark mapping', () => {
  it('--live is oil-only; the metals keep their shadow + auto-promote path', async () => {
    const { parseClockArgs } = await import('../scripts/fit-variance-clock.js');
    expect(parseClockArgs(['node', 'x', '--commodity', 'oil', '--live'])).toEqual({ commodity: 'oil', dryRun: false, live: true });
    expect(parseClockArgs(['node', 'x', '--commodity', 'oil', '--dry-run'])).toEqual({ commodity: 'oil', dryRun: true, live: false });
    expect(parseClockArgs(['node', 'x', '--commodity', 'gold', '--live']).error).toMatch(/oil-only/);
    expect(parseClockArgs(['node', 'x', '--commodity', 'copper']).error).toMatch(/usage/);
    expect(parseClockArgs(['node', 'x']).error).toMatch(/usage/);
  });

  it('maps settlement_spot_captures rows to { mark_at, spot } and drops non-positive spots', async () => {
    const { marksFromWtiCaptures } = await import('../scripts/fit-variance-clock.js');
    const marks = marksFromWtiCaptures([
      { window_close_at: '2026-11-09T14:30:00+00:00', our_spot: '87.51' },
      { window_close_at: '2026-11-09T14:45:00+00:00', our_spot: 0 },
      { window_close_at: null, our_spot: '87.6' },
      { window_close_at: '2026-11-09T15:00:00+00:00', our_spot: '87.62' },
    ]);
    expect(marks).toEqual([
      { mark_at: '2026-11-09T14:30:00+00:00', spot: 87.51 },
      { mark_at: '2026-11-09T15:00:00+00:00', spot: 87.62 },
    ]);
  });
});
