// Lock the arb mapping registry. These IDs were verified against gamma-api on
// 2026-05-02 — if they change here, someone took an explicit decision to remap
// the cross-platform pairings.

import { describe, it, expect } from 'vitest';
import {
  ARB_MAPPINGS,
  getKalshiTickers,
  getPolymarketYesTokenIds,
  getMappingByKalshiTicker,
  getMappingByPolyToken,
} from '../src/engine/arb-mappings.js';

describe('ARB_MAPPINGS', () => {
  it('has exactly the 4 verified Phase 2B pairings', () => {
    expect(ARB_MAPPINGS).toHaveLength(4);
    const slugs = ARB_MAPPINGS.map((m) => m.pair_slug).sort();
    expect(slugs).toEqual([
      'fed-jun-2026-cut-25bps',
      'fed-jun-2026-no-change',
      'fed-sep-2026-cut-25bps',
      'fed-sep-2026-no-change',
    ]);
  });

  it('every mapping has Kalshi ticker + Polymarket conditionId + yesTokenId', () => {
    for (const m of ARB_MAPPINGS) {
      expect(m.kalshi.ticker).toMatch(/^KXFEDDECISION-26(JUN|SEP)-(H0|C25)$/);
      expect(m.polymarket.conditionId).toMatch(/^0x[a-f0-9]{64}$/);
      expect(m.polymarket.yesTokenId).toMatch(/^[0-9]+$/);
      expect(m.polymarket.yesTokenId.length).toBeGreaterThan(40);
    }
  });

  it('Kalshi tickers are unique', () => {
    const tickers = getKalshiTickers();
    expect(new Set(tickers).size).toBe(tickers.length);
  });

  it('Polymarket YES token IDs are unique', () => {
    const ids = getPolymarketYesTokenIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lookup helpers find by Kalshi ticker', () => {
    const m = getMappingByKalshiTicker('KXFEDDECISION-26JUN-H0');
    expect(m?.pair_slug).toBe('fed-jun-2026-no-change');
    expect(getMappingByKalshiTicker('NOT_A_TICKER')).toBeNull();
  });

  it('lookup helpers find by Polymarket token', () => {
    const tokenId = ARB_MAPPINGS[0].polymarket.yesTokenId;
    const m = getMappingByPolyToken(tokenId);
    expect(m?.pair_slug).toBe(ARB_MAPPINGS[0].pair_slug);
    expect(getMappingByPolyToken('123')).toBeNull();
  });
});
