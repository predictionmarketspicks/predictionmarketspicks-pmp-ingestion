// Commodity alert keys + the bitcoin "alert is the pick" mapping.
// handoffs/BITCOIN_EDGE_ALERT_IS_THE_PICK_2026-09-22.md §4–§5 (site repo).

import { describe, it, expect } from 'vitest';
import {
  commodityAlertKey,
  publishedTierFor,
  pickAlertKey,
  findPickRow,
  topEdgeFromPick,
  tierFromPick,
  settleTimeEt,
} from '../src/delivery/alert-key.js';
import { buildCommodityEmbed } from '../src/delivery/discord.js';

const edge = { direction: 'BUY YES', strike: 86599.99 };
const shadow = { calibrationActive: false };

describe('commodityAlertKey', () => {
  it('(a) same strike + tier on two hourly contracts gives two keys', () => {
    const k11 = commodityAlertKey('bitcoin', 'KXBTCD-26SEP2211', 'MODERATE', edge);
    const k12 = commodityAlertKey('bitcoin', 'KXBTCD-26SEP2212', 'MODERATE', edge);
    expect(k11).not.toBe(k12);
  });

  it('(b) raw STRONG and raw MODERATE that both publish MODERATE give one key', () => {
    const strong = publishedTierFor('bitcoin', 'STRONG', shadow);
    const moderate = publishedTierFor('bitcoin', 'MODERATE', shadow);
    expect(strong).toBe('MODERATE');
    expect(commodityAlertKey('bitcoin', 'KXBTCD-26SEP2214', strong, edge))
      .toBe(commodityAlertKey('bitcoin', 'KXBTCD-26SEP2214', moderate, edge));
  });

  it('(c) position [1] is the commodity (discord-potd-candidate parses it)', () => {
    for (const c of ['bitcoin', 'gold', 'silver', 'oil']) {
      expect(commodityAlertKey(c, 'EVT', 'MODERATE', edge).split(':')[1]).toBe(c);
      expect(pickAlertKey(c, 'ef415622-3f02-43d7-9eb8-fc544840e8ed').split(':')[1]).toBe(c);
    }
  });
});

describe('pick → alert', () => {
  const pick = {
    pick_id: 'ef415622-3f02-43d7-9eb8-fc544840e8ed',
    source_row_id: 'bitcoin:KXBTCD-26SEP2216:86699.99:2026-09-22',
    predicted_side: 'YES',
    predicted_prob: '0.3750',
    market_price_at_pick: '0.2650',
    edge_pp: '11.0000',
    confidence_tier: 2,
    regime_tags: { strike: 86699.99 },
  };

  it('finds the minted strike in the snapshot rows', () => {
    const rows = [{ strike: 86599.99 }, { strike: 86699.99, fused_confidence: 'MODERATE' }];
    expect(findPickRow(rows, pick)).toBe(rows[1]);
    expect(findPickRow([{ strike: 1 }], pick)).toBeNull();
  });

  it('rebuilds a postable top edge from the pick alone', () => {
    const t = topEdgeFromPick(pick);
    expect(t.direction).toBe('BUY YES');
    expect(t.strike).toBeCloseTo(86699.99);
    expect(t.kalshi_yes).toBeCloseTo(0.265);
    expect(t.prob_physical).toBeCloseTo(0.375);
    expect(t.edge_pp).toBeCloseTo(0.11);
    expect(tierFromPick(pick)).toBe('MODERATE');
  });

  it('falls back to the strike in source_row_id', () => {
    const t = topEdgeFromPick({ ...pick, regime_tags: null });
    expect(t.strike).toBeCloseTo(86699.99);
  });
});

describe('Discord footer settle time', () => {
  it('formats the contract close in ET', () => {
    expect(settleTimeEt('2026-09-22T18:00:00Z')).toBe('2:00 PM ET');
    expect(settleTimeEt(null)).toBeNull();
  });

  it('puts the settle time in the embed footer', () => {
    const meta = {
      commodity: 'bitcoin',
      topTier: 'MODERATE',
      eventTicker: 'KXBTCD-26SEP2214',
      eventCloseAt: '2026-09-22T18:00:00Z',
      hoursToClose: 0.9,
      strikeCount: 40,
      spotLabel: 'BTC',
      spotPrice: 86500,
      generatedAt: '2026-09-22T17:05:00Z',
    };
    const t = topEdgeFromPick({
      predicted_side: 'YES', predicted_prob: 0.37, market_price_at_pick: 0.27, edge_pp: 10,
      regime_tags: { strike: 86699.99 },
    });
    const footer = buildCommodityEmbed(meta, t).embeds[0].footer.text;
    expect(footer).toBe('KXBTCD-26SEP2214 • settles 2:00 PM ET • closes in 0.9h • 40 strikes scanned');
  });
});
