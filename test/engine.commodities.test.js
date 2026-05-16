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
  it('has silver, gold, oil, bitcoin, copper', () => {
    expect(Object.keys(COMMODITIES).sort()).toEqual([
      'bitcoin',
      'copper',
      'gold',
      'oil',
      'silver',
    ]);
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
    expect(COMMODITIES.bitcoin).toMatchObject({
      seriesTicker: 'KXBTCD',
      underlyingEtf: 'IBIT',
      pythSymbol: 'BTC/USD',
    });
    expect(COMMODITIES.copper).toMatchObject({
      seriesTicker: 'KXCOPPERMON',
      underlyingEtf: 'CPER',
      pythSymbol: 'XCU/USD',
    });
  });

  it('enables silver/gold/oil/bitcoin, leaves copper disabled until a spot source is wired', () => {
    expect(COMMODITIES.silver.enabled).toBe(true);
    expect(COMMODITIES.gold.enabled).toBe(true);
    expect(COMMODITIES.oil.enabled).toBe(true);
    expect(COMMODITIES.bitcoin.enabled).toBe(true);
    expect(COMMODITIES.copper.enabled).toBe(false);
  });

  it('listEnabledCommodities filters to enabled only', () => {
    const enabled = listEnabledCommodities();
    expect(enabled.map((c) => c.commodity).sort()).toEqual(['bitcoin', 'gold', 'oil', 'silver']);
  });

  it('listAllCommodities returns every config', () => {
    const all = listAllCommodities();
    expect(all).toHaveLength(5);
  });

  it('bitcoin pauses snapshots off-hours because IBIT chain is OPRA-only', () => {
    // BTC spot is 24/7 via Pyth but the IBIT chain freezes at 4pm ET;
    // running edge math against a stale IV smile + a moving spot would
    // surface basis-mismatch artifacts. Burst window still fires.
    expect(COMMODITIES.bitcoin.pauseSnapshotsOffHours).toBe(true);
  });

  it('getCommodityConfig throws on unknown', () => {
    expect(() => getCommodityConfig('platinum')).toThrow(/unknown commodity/);
  });
});
