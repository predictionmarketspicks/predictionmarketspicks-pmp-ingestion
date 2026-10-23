// Golden snapshot: oil and bitcoin rows are byte-identical across the variance-clock
// change, and gold/silver differ ONLY by the added shadow prob_clock column
// (site repo handoffs/METALS_EDGE_VARIANCE_CLOCK_2026-10-23.md PART 2.3 / PART 7).
//
// Every feed computeSnapshot touches is mocked with fixed values, so the run is
// deterministic. The golden file was generated from the engine BEFORE the clock
// existed (commit 49a45e1); regenerate only on a deliberate output change:
//   UPDATE_GOLDEN=1 npx vitest run test/engine.variance-clock-golden.test.js
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NOW = new Date('2026-10-23T18:00:00Z'); // 2:00 PM ET, Friday
const SPOT = { gold: 4100, silver: 48.5, oil: 62.3, bitcoin: 110000 };
const ETF = { gold: 377.2, silver: 44.1, oil: 76.4, bitcoin: 62.5 };
const STEP = { gold: 10, silver: 0.25, oil: 0.5, bitcoin: 250 };

vi.mock('../src/feeds/kalshi.js', () => ({ getQuote: () => null }));
vi.mock('../src/feeds/pyth.js', () => ({
  WTI_FRONT_MONTH_SYMBOL: 'WTI',
  getPrice: (sym) => ({ price: sym === 'XAU/USD' ? 4100 : sym === 'XAG/USD' ? 48.5 : 62.3, source: `pyth_${sym}`, publishTimeMs: null }),
}));
vi.mock('../src/feeds/options-provider.js', () => {
  const chainFor = (etf) => {
    const s = { GLD: 377.2, SLV: 44.1, USO: 76.4, IBIT: 62.5 }[etf];
    const contracts = [];
    for (let i = -8; i <= 8; i++) {
      const strike = Math.round(s * (1 + i * 0.01) * 2) / 2;
      const iv = 0.22 + Math.abs(i) * 0.004 + (etf === 'SLV' ? 0.15 : etf === 'IBIT' ? 0.25 : etf === 'USO' ? 0.12 : 0);
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
vi.mock('../src/feeds/brti-spot.js', () => ({ getBrtiSpot: () => ({ price: 110000, source: 'basket', publishTimeMs: null }) }));
vi.mock('../src/feeds/btc-spot.js', () => ({
  getBtcSpot: () => ({ ref: { price: 110000, source: 'basket', publishTimeMs: null }, pub: { price: 110000 }, refSource: 'basket', pubSource: 'basket', refAgeS: 1 }),
}));
vi.mock('../src/feeds/yahoo-oil.js', () => ({ getOilSpot: () => ({ price: 62.3, source: 'yahoo_cl', publishTimeMs: null }), getContractSpot: async () => ({ price: 62.3, symbol: 'CLZ26.NYM' }) }));
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

function eventFor(c, closeIso) {
  const markets = [];
  for (let i = -10; i <= 10; i++) {
    const k = Math.round((SPOT[c] + i * STEP[c]) * 100) / 100;
    // A market curve slightly tighter than the model so edges and PASS rows both appear.
    const z = (SPOT[c] - k) / (STEP[c] * 4);
    const p = 1 / (1 + Math.exp(-1.9 * z));
    const mid = Math.min(0.97, Math.max(0.03, Math.round(p * 100) / 100));
    markets.push({ ticker: `T-${c}-${k}`, floorStrike: k, yesBid: Math.max(0.01, mid - 0.01), yesAsk: Math.min(0.99, mid + 0.01), lastPrice: mid, volume24h: 400, openInterest: 900 });
  }
  return { eventTicker: `EV-${c}`, closeTime: closeIso, markets, fetchedAtMs: NOW.getTime() - 5000 };
}

const CLOSES = {
  gold: '2026-10-26T21:00:00Z', // Monday 5 PM ET — the Friday→Monday shape
  silver: '2026-10-26T21:00:00Z',
  oil: '2026-10-26T18:30:00Z',
  bitcoin: '2026-10-23T19:00:00Z',
};

const goldenPath = fileURLToPath(new URL('./fixtures/variance-clock-golden.json', import.meta.url));

describe('variance clock: golden engine output', () => {
  let out;
  beforeAll(async () => {
    const { computeSnapshot } = await import('../src/engine/commodity-base.js');
    const { COMMODITIES } = await import('../src/engine/commodities.js');
    out = {};
    for (const c of ['gold', 'silver', 'oil', 'bitcoin']) {
      const snap = await computeSnapshot(COMMODITIES[c], eventFor(c, CLOSES[c]), { now: NOW });
      expect(snap, `${c} produced a snapshot`).not.toBeNull();
      out[c] = snap.rows;
    }
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(goldenPath)) writeFileSync(goldenPath, JSON.stringify(out, null, 1));
  });

  it('oil and bitcoin rows are byte-identical to the pre-clock engine', () => {
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
    for (const c of ['oil', 'bitcoin']) {
      expect(out[c].length).toBeGreaterThan(0);
      expect(JSON.stringify(out[c])).toBe(JSON.stringify(golden[c]));
      for (const r of out[c]) expect(r).not.toHaveProperty('prob_clock');
    }
  });

  it('gold and silver rows differ from the pre-clock engine only by prob_clock', () => {
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
    for (const c of ['gold', 'silver']) {
      const stripped = out[c].map(({ prob_clock, ...rest }) => rest);
      expect(JSON.stringify(stripped)).toBe(JSON.stringify(golden[c]));
    }
  });

  it('every PASS row carries a pass_reason; prob_clock is null (not 0) when no clock exists', () => {
    for (const c of ['gold', 'silver', 'oil', 'bitcoin']) {
      for (const r of out[c]) if (r.direction === 'PASS') expect(r.pass_reason, `${c} ${r.strike}`).toBeTruthy();
    }
    for (const c of ['gold', 'silver']) for (const r of out[c]) expect(r.prob_clock).toBeNull();
  });

  it('with a shadow clock installed, gold writes prob_clock beside an unchanged prob_physical', async () => {
    const { computeSnapshot } = await import('../src/engine/commodity-base.js');
    const { COMMODITIES } = await import('../src/engine/commodities.js');
    const { __setClocksForTest } = await import('../src/engine/calibration.js');
    const { CLOCK_METHOD, CALENDAR_METALS } = await import('../src/engine/variance-clock.js');
    const w = [0.6, 0.8, 1.1, 0.7, 0.7, 0.4, 0.6, 0.7, 3.7, 1.9, 2.5, 1.1, 1.0, 0.6, 0.6, 0.7, 0.31, 0, 0.25, 0.25, 0.9, 1.6, 1.1, 0.9];
    __setClocksForTest([['gold', { id: 99, commodity: 'gold', method: CLOCK_METHOD, active: false, shadow: true, fit_at: '2026-10-23T12:00:00Z', knots: { hours_et: w, calendar: CALENDAR_METALS } }]]);
    try {
      const snap = await computeSnapshot(COMMODITIES.gold, eventFor('gold', CLOSES.gold), { now: NOW });
      const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
      const priced = snap.rows.filter((r) => r.prob_physical != null);
      expect(priced.length).toBeGreaterThan(0);
      for (const r of priced) {
        expect(r.prob_clock).toBeGreaterThanOrEqual(0);
        expect(r.prob_clock).toBeLessThanOrEqual(1);
      }
      // Decisions untouched: everything but prob_clock matches the pre-clock engine.
      expect(JSON.stringify(snap.rows.map(({ prob_clock, ...rest }) => rest))).toBe(JSON.stringify(golden.gold));
      // The clock tightens a Fri→Mon horizon (weekend at 0): tails move toward 0/1.
      const otm = priced.filter((r) => r.strike > SPOT.gold + 50);
      for (const r of otm) expect(r.prob_clock).toBeLessThan(r.prob_physical);
      // Oil ignores the clock entirely even if a row existed for it.
      __setClocksForTest([['oil', { id: 98, commodity: 'oil', method: CLOCK_METHOD, active: false, shadow: true, fit_at: '2026-10-23T12:00:00Z', knots: { hours_et: w, calendar: CALENDAR_METALS } }]]);
      const oil = await computeSnapshot(COMMODITIES.oil, eventFor('oil', CLOSES.oil), { now: NOW });
      expect(JSON.stringify(oil.rows)).toBe(JSON.stringify(golden.oil));
    } finally {
      __setClocksForTest([]);
    }
  });
});
