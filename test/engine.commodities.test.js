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
import { BTC_MU_SCALE, BTC_MU_CAP_ANNUAL } from '../src/engine/thresholds.js';

describe('COMMODITIES registry', () => {
  it('has silver, gold, oil, bitcoin, spx, copper', () => {
    expect(Object.keys(COMMODITIES).sort()).toEqual([
      'bitcoin',
      'copper',
      'gold',
      'oil',
      'silver',
      'spx',
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
    expect(all).toHaveLength(6);
  });

  it('V2 cutover: all four commodities ON (bitcoin joined 2026-07-27)', () => {
    // Metals cut over 2026-05-21. Bitcoin joined 2026-07-27 after zero-mu
    // risk-neutral kept printing fade-the-trend NOs (0-fers 7/7, 7/14,
    // 7/24, 7/27) — the TWAP path now consumes short-horizon momentum via
    // resolveTwapMu. NO side disabled the same day (post-7/21 NO picks
    // 1-for-15 live; replay kept-NO hit <=14% under every mu variant).
    expect(COMMODITIES.silver.useV2Cutover).toBe(true);
    expect(COMMODITIES.gold.useV2Cutover).toBe(true);
    expect(COMMODITIES.oil.useV2Cutover).toBe(true);
    expect(COMMODITIES.bitcoin.useV2Cutover).toBe(true);
    expect(COMMODITIES.bitcoin.noSideEnabled).toBe(false);
  });

  it('V2.1: bitcoin momentum mu is SHRUNK (0.4/12), not the era-C 1.0/50', () => {
    // Pinned exactly, not as a range. The previous assertions here were
    // `>0` and `>=10`, which a revert to the era-C values (1.0/50) would have
    // passed silently — and those values are what produced a ~30pp phantom
    // edge live (claimed 0.794 vs market 0.498, realized hit 48.1% over 81
    // settled picks, 7/28-8/4). Momentum is a tilt now, not the thesis.
    // Plan: handoffs/BITCOIN_EDGE_V21_CALIBRATED_RELAUNCH_2026-08-05.md §2.
    expect(COMMODITIES.bitcoin.shortHorizonMuScale).toBe(0.4);
    expect(COMMODITIES.bitcoin.shortHorizonMuCapAnnual).toBe(12);
    // Config must match the module defaults so an override can never drift
    // silently away from the documented rationale.
    expect(BTC_MU_SCALE).toBe(0.4);
    expect(BTC_MU_CAP_ANNUAL).toBe(12);
  });

  it('V2.1 mu shrink: metals are byte-identical (no shortHorizon override)', () => {
    // The metals V2 model is a DIFFERENT model (realized_60d drift, daily
    // horizon). Its success never validated the bitcoin config and the
    // bitcoin fix must not touch it.
    for (const c of ['silver', 'gold', 'oil']) {
      expect(COMMODITIES[c].shortHorizonMuScale).toBeUndefined();
      expect(COMMODITIES[c].shortHorizonMuCapAnnual).toBeUndefined();
    }
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
