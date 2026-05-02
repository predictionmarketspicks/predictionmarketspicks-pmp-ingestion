// Commodity config registry tests — guards against accidental enable of
// commodities whose spot feed isn't verified, and locks the per-commodity
// constants (Kalshi series, ETF, Pyth symbol) plan §10 calls out.

import { describe, it, expect } from 'vitest';
import {
  COMMODITIES,
  getCommodityConfig,
  listEnabledCommodities,
  listAllCommodities,
} from '../src/engine/commodities.js';

describe('COMMODITIES registry', () => {
  it('has silver, gold, oil, copper', () => {
    expect(Object.keys(COMMODITIES).sort()).toEqual(['copper', 'gold', 'oil', 'silver']);
  });

  it('locks the Kalshi series + ETF + Pyth symbol per commodity', () => {
    expect(COMMODITIES.silver).toMatchObject({
      seriesTicker: 'KXSILVERW',
      underlyingEtf: 'SLV',
      pythSymbol: 'XAG/USD',
    });
    expect(COMMODITIES.gold).toMatchObject({
      seriesTicker: 'KXGOLDW',
      underlyingEtf: 'GLD',
      pythSymbol: 'XAU/USD',
    });
    expect(COMMODITIES.oil).toMatchObject({
      seriesTicker: 'KXWTI',
      underlyingEtf: 'USO',
      pythSymbol: 'WTI',
    });
    expect(COMMODITIES.copper).toMatchObject({
      seriesTicker: 'KXCOPPERMON',
      underlyingEtf: 'CPER',
      pythSymbol: 'XCU/USD',
    });
  });

  it('only enables commodities with verified Pyth feeds (silver, gold)', () => {
    // Phase 2A: oil + copper are scaffolded but disabled. Flip true once the
    // Pyth feed (or substitute spot source) is verified — see
    // docs/COMMODITY_FEEDS.md.
    expect(COMMODITIES.silver.enabled).toBe(true);
    expect(COMMODITIES.gold.enabled).toBe(true);
    expect(COMMODITIES.oil.enabled).toBe(false);
    expect(COMMODITIES.copper.enabled).toBe(false);
  });

  it('listEnabledCommodities filters to enabled only', () => {
    const enabled = listEnabledCommodities();
    expect(enabled.map((c) => c.commodity).sort()).toEqual(['gold', 'silver']);
  });

  it('listAllCommodities returns every config', () => {
    const all = listAllCommodities();
    expect(all).toHaveLength(4);
  });

  it('getCommodityConfig throws on unknown', () => {
    expect(() => getCommodityConfig('platinum')).toThrow(/unknown commodity/);
  });
});
