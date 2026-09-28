// KXWTI15M proxy (2026-09-28) — parse, basis re-anchor, fail-closed paths.
// Fixture prices are from the live xyz dex payload captured 2026-09-28 ~03:20Z.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  parseHyperliquidCtx,
  computeBasis,
  rawAt,
  fetchWtiProxy,
  hasWtiProxyFeed,
  WTI_PROXY_SYMBOL,
  _resetWtiProxy,
} from '../src/feeds/wti-proxy.js';
import { hasPythFeed } from '../src/feeds/pyth.js';
import { METALS, METALS_15M_SYMBOLS } from '../src/engine/metals-15m.js';

const ctxPayload = (oraclePx, extra = {}) => [
  { universe: [{ name: 'xyz:ORCL' }, { name: 'xyz:CL' }, { name: 'xyz:BRENTOIL' }] },
  [
    { oraclePx: '135.4' },
    { oraclePx: String(oraclePx), midPx: '93.162', impactPxs: ['93.15', '93.17'], dayNtlVlm: '75698192.6', ...extra },
    { oraclePx: '98.3' },
  ],
];

describe('parseHyperliquidCtx', () => {
  it('reads xyz:CL by NAME (never by index) and halves the impact spread', () => {
    const p = parseHyperliquidCtx(ctxPayload(93.2));
    expect(p.price).toBe(93.2);
    expect(p.mid).toBeCloseTo(93.162, 6);
    expect(p.halfSpread).toBeCloseTo(0.01, 6);
  });
  it('throws when the coin is missing or the oracle is not a price', () => {
    expect(() => parseHyperliquidCtx([{ universe: [] }, []])).toThrow(/not listed/);
    expect(() => parseHyperliquidCtx(ctxPayload('0'))).toThrow(/oraclePx/);
    expect(() => parseHyperliquidCtx(null)).toThrow(/malformed/);
  });
});

describe('computeBasis', () => {
  const obs = (diffs) => diffs.map((d, i) => ({ t: i, settle: 93 + d, raw: 93 }));
  it('cold below the minimum observation count — raw price, basis 0', () => {
    expect(computeBasis(obs([0.5, 0.5]))).toMatchObject({ value: 0, status: 'cold' });
  });
  it('on-contract noise inside the deadband is NOT corrected', () => {
    expect(computeBasis(obs([0.03, -0.02, 0.04, 0.01]))).toMatchObject({ value: 0, status: 'ok' });
  });
  it('a roll mismatch is measured and applied', () => {
    const b = computeBasis(obs([3.2, 3.18, 3.25, 3.21, 3.19]));
    expect(b.status).toBe('rolled');
    expect(b.value).toBeCloseTo(3.2, 2);
  });
  it('uses only the last BASIS_WINDOW readings, so a roll heals in a few windows', () => {
    const b = computeBasis(obs([0, 0, 0, 0, 0, 0, 0, 0, 3.2, 3.2, 3.2, 3.2, 3.2]));
    expect(b.status).toBe('rolled');
    expect(b.value).toBeCloseTo(3.2, 6);
  });
  it('fails CLOSED when recent readings disagree with each other', () => {
    const b = computeBasis(obs([0, 1, -1, 0.9, -0.8, 1.2]));
    expect(b.status).toBe('unstable');
    expect(b.value).toBeNull();
  });
});

describe('rawAt', () => {
  const s = [{ t: 1000, raw: 1 }, { t: 11000, raw: 2 }, { t: 21000, raw: 3 }];
  it('last sample at or before the close, never after', () => {
    expect(rawAt(s, 15000)).toBe(2);
    expect(rawAt(s, 21000)).toBe(3);
  });
  it('null when the nearest prior sample is too old', () => {
    expect(rawAt(s, 60000)).toBeNull();
    expect(rawAt(s, 500)).toBeNull();
  });
});

describe('fetchWtiProxy', () => {
  beforeEach(() => _resetWtiProxy());
  afterEach(() => vi.unstubAllGlobals());

  it('pairs Kalshi settles with our own samples and re-anchors the level', async () => {
    const T0 = Date.parse('2026-09-28T03:00:00Z');
    const closes = [T0, T0 + 900_000, T0 + 1_800_000, T0 + 2_700_000];
    let oracle = 90.0; // a proxy sitting $3.30 below Kalshi's index (wrong month)
    let settled = [];
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).includes('hyperliquid')) return { ok: true, json: async () => ctxPayload(oracle) };
      return { ok: true, json: async () => ({ markets: settled }) };
    });
    // Sample 5s before each close; Kalshi then publishes that close at +3.30.
    let last;
    for (const c of closes) {
      oracle += 0.01;
      await fetchWtiProxy(c - 5000);
      settled = [
        ...settled,
        { close_time: new Date(c).toISOString(), expiration_value: (oracle + 3.3).toFixed(2) },
      ];
      last = await fetchWtiProxy(c + 61_000); // past the 60s refresh gate
    }
    expect(last.basisStatus).toBe('rolled');
    expect(last.basis).toBeCloseTo(3.3, 2);
    expect(last.price).toBeCloseTo(last.rawPrice + 3.3, 2);
  });

  it('marks a frozen oracle as not trading and keeps its real change time', async () => {
    vi.stubGlobal('fetch', async (url) =>
      String(url).includes('hyperliquid')
        ? { ok: true, json: async () => ctxPayload(93.2) }
        : { ok: true, json: async () => ({ markets: [] }) },
    );
    const t = 1_790_000_000_000;
    const a = await fetchWtiProxy(t);
    const b = await fetchWtiProxy(t + 300_000);
    expect(a.trading).toBe(true);
    expect(b.publishTimeMs).toBe(t);
    expect(b.trading).toBe(false);
  });
});

describe('wiring', () => {
  it('the 15-minute WTI engine asks for the proxy, and the poller can serve it', () => {
    expect(METALS.wti.pythSymbol).toBe(WTI_PROXY_SYMBOL);
    expect(METALS_15M_SYMBOLS).toContain(WTI_PROXY_SYMBOL);
    expect(hasWtiProxyFeed(WTI_PROXY_SYMBOL)).toBe(true);
    expect(hasPythFeed(WTI_PROXY_SYMBOL)).toBe(true);
  });
});
