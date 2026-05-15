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

  it('enables silver/gold/oil, leaves copper disabled until a spot source is wired', () => {
    expect(COMMODITIES.silver.enabled).toBe(true);
    expect(COMMODITIES.gold.enabled).toBe(true);
    expect(COMMODITIES.oil.enabled).toBe(true);
    expect(COMMODITIES.copper.enabled).toBe(false);
  });

  it('listEnabledCommodities filters to enabled only', () => {
    const enabled = listEnabledCommodities();
    expect(enabled.map((c) => c.commodity).sort()).toEqual(['gold', 'oil', 'silver']);
  });

  it('listAllCommodities returns every config', () => {
    const all = listAllCommodities();
    expect(all).toHaveLength(4);
  });

  it('getCommodityConfig throws on unknown', () => {
    expect(() => getCommodityConfig('platinum')).toThrow(/unknown commodity/);
  });
});
