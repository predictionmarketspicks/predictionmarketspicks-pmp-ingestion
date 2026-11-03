// P0-B (site repo handoffs/ENGINE_OUTAGE_ALARMS_AND_OPEN_FIXES_2026-11-03.md): the two
// silences. A dead options feed must leave a named missing input for index.js to
// alarm on; a healthy snapshot (quiet board or not) must leave none.
import { describe, it, expect, vi, afterEach } from 'vitest';

const NOW = new Date('2026-10-23T18:00:00Z');
const SPOT = { gold: 4100, silver: 48.5, oil: 62.3, bitcoin: 110000 };
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
  return { getChain: (etf) => (globalThis.__chainDead ? null : chainFor(etf)), fetchPrevClose: async () => null };
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

afterEach(() => { globalThis.__chainDead = false; });

describe('computeSnapshot: missing input is named, a computed board is not', () => {
  it('no options chain → null snapshot + no_options_chain', async () => {
    const { computeSnapshot, getLastInputSkip } = await import('../src/engine/commodity-base.js');
    const { COMMODITIES } = await import('../src/engine/commodities.js');
    globalThis.__chainDead = true;
    const snap = await computeSnapshot(COMMODITIES.gold, eventFor('gold', '2026-10-26T21:00:00Z'), { now: NOW });
    expect(snap).toBeNull();
    expect(getLastInputSkip('gold')).toMatchObject({ reason: 'no_options_chain', detail: { underlying: 'GLD', chain: 'null' } });
  });

  it('chain restored → snapshot computes and the missing input clears', async () => {
    const { computeSnapshot, getLastInputSkip } = await import('../src/engine/commodity-base.js');
    const { COMMODITIES } = await import('../src/engine/commodities.js');
    globalThis.__chainDead = true;
    await computeSnapshot(COMMODITIES.silver, eventFor('silver', '2026-10-26T21:00:00Z'), { now: NOW });
    expect(getLastInputSkip('silver')?.reason).toBe('no_options_chain');
    globalThis.__chainDead = false;
    const snap = await computeSnapshot(COMMODITIES.silver, eventFor('silver', '2026-10-26T21:00:00Z'), { now: NOW });
    expect(snap).not.toBeNull();
    expect(getLastInputSkip('silver')).toBeNull();
  });
});
