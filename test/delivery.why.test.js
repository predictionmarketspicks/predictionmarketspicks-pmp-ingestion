// The bitcoin "Why" block (src/delivery/why.js) + its embed and routing in discord.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildWhyBitcoin,
  bandRecordLine,
  summarizeBands,
  fetchBandRecord,
  _resetRecordCache,
  WHY_CHAR_BUDGET,
} from '../src/delivery/why.js';
import {
  buildCommodityEmbed,
  postCommodityAlert,
  commodityChannelFor,
  _resetCommoditySession,
} from '../src/delivery/discord.js';
import { BTC_EDGE_CHANNEL_ID, EDGE_FEED_CHANNEL_ID } from '../src/delivery/discord-budget.js';
import { assertBrandSafe } from '../src/lib/lint-strings.js';

const NOW = new Date('2026-11-12T13:46:00Z'); // 2h 14m before close
const CLOSE = '2026-11-12T16:00:00Z';

const meta = (o = {}) => ({
  commodity: 'bitcoin',
  eventTicker: 'KXBTCD-26NOV1211',
  eventCloseAt: CLOSE,
  hoursToClose: 2.23,
  strikeCount: 30,
  generatedAt: NOW.toISOString(),
  topTier: 'SPECULATIVE',
  publicPrice: 68719,
  spotPrice: 68733.12, // engine ref (licensed index) — must never print
  ...o,
});

const edge = (o = {}) => ({
  direction: 'BUY YES',
  strike: 68199.99,
  kalshi_yes: 0.29,
  prob_physical: 0.41,
  options_prob: 0.4,
  model_version: 'v2_physical',
  edge_pp: 0.12,
  fused_edge_pp: 0.12,
  sigma_blend: 0.44,
  sigma_iv: 0.47,
  sigma_rv20: 0.41,
  mu_used: 0,
  mu_source: 'pyth_short_horizon_15m',
  spot_price: 68719,
  spot_source: 'brti_basket',
  ref_spot: 68733.12,
  ref_spot_source: 'cf_benchmarks_brti',
  event_close_at: CLOSE,
  max_entry_cents: 35,
  min_entry_cents: 20,
  rationale: 'internal rule:R12 deribit',
  ...o,
});

// 77 picks at 60–70¢, 59 wins, +$0.10/contract; 32 at 20–30¢ losing; 12 at 40–50¢.
const record = {
  days: 90,
  bands: {
    6: { n: 77, wins: 59, netCents: 770 },
    2: { n: 32, wins: 5, netCents: -337 },
    4: { n: 12, wins: 7, netCents: 40 },
  },
};

const BANNED_FEEDS = /pyth|databento|deribit|massive|opra|tradier|yahoo|coinbase|kraken|bitstamp|gemini|swissquote|brti_basket|\bIV\b|implied|options chain|rule:R12/i;
const why = (m, e, r = record, now = NOW) => buildWhyBitcoin({ meta: m, edge: e, record: r, now });

describe('buildWhyBitcoin', () => {
  it('YES, spot above the strike: setup, vol, disagreement, holds-line', () => {
    const lines = why(meta(), edge());
    expect(lines[0]).toBe(
      'BTC is $68,719 — $519 (0.8%) above the $68,199.99 strike, with 2h 14m until it settles on the CF Benchmarks index Kalshi uses.',
    );
    expect(lines[1]).toMatch(/^At current volatility a typical BTC move over that window is about ±\$\d{3}\.$/);
    expect(lines[2]).toBe('Our model puts the chance BTC finishes above $68,199.99 at 41%; Kalshi prices it at 29% — YES is underpriced by 12 pts.');
    expect(lines[3]).toMatch(/^Holds if BTC stays above \$68,199\.99 — a \$519 \(0\.8%\) drop flips it, about [\d.]+× a typical move\.$/);
  });

  it('YES, spot below the strike: needs a rise in the time left', () => {
    const lines = why(meta({ publicPrice: 67000 }), edge());
    expect(lines[0]).toMatch(/^BTC is \$67,000 — \$1,200 \(1\.8%\) below the \$68,199\.99 strike/);
    expect(lines[3]).toMatch(/^Needs a \$1,200 \(1\.8%\) rise in 2h 14m — about [\d.]+× a typical move\.$/);
  });

  it('NO side mirrors the probabilities and the move', () => {
    const e = edge({ direction: 'BUY NO', kalshi_yes: 0.785, prob_physical: 0.726, strike: 68599.99 });
    const lines = why(meta({ publicPrice: 68643.83 }), e);
    expect(lines[2]).toBe('Our model puts the chance BTC finishes below $68,599.99 at 27%; Kalshi prices NO at 21% — NO is underpriced by 6 pts.');
    expect(lines[3]).toMatch(/^Needs a \$44 \(0\.06%\) drop in 2h 14m/);
    const below = why(meta({ publicPrice: 68000 }), e);
    expect(below[3]).toMatch(/^Holds if BTC stays below \$68,599\.99 — a \$600 \(0\.9%\) rise flips it/);
  });

  it('uses options_prob when the row is not v2_physical (same prob as the embed)', () => {
    const lines = why(meta(), edge({ model_version: 'v1_riskneutral', options_prob: 0.38 }));
    expect(lines.find((l) => l.startsWith('Our model'))).toMatch(/at 38%; Kalshi prices it at 29% — YES is underpriced by 9 pts/);
  });

  it('omits the disagreement when the numbers do not back the direction', () => {
    const lines = why(meta(), edge({ prob_physical: 0.2 }));
    expect(lines.some((l) => l.startsWith('Our model'))).toBe(false);
  });

  it('momentum: omitted at mu 0, one plain sentence when meaningful', () => {
    expect(why(meta(), edge()).some((l) => /momentum/i.test(l))).toBe(false);
    const up = why(meta(), edge({ mu_used: 40 }));
    expect(up.find((l) => /momentum/.test(l))).toMatch(/^Recent momentum points up — the model leans about \$[\d,]+ higher by the settle\.$/);
    const down = why(meta(), edge({ mu_used: -40 }));
    expect(down.find((l) => /momentum/.test(l))).toMatch(/points down — .* lower by the settle\.$/);
    // tiny drift is not "meaningful"
    expect(why(meta(), edge({ mu_used: 0.01 })).some((l) => /momentum/.test(l))).toBe(false);
  });

  it('missing sigma: volatility line omitted, no typical-move clause, no NaN anywhere', () => {
    for (const sigma of [null, undefined, NaN, 0, -1, 99, 'abc']) {
      const lines = why(meta(), edge({ sigma_blend: sigma, mu_used: 40 }));
      const blob = lines.join('\n');
      expect(blob).not.toMatch(/NaN|Infinity|undefined|null/);
      expect(blob).not.toMatch(/volatility|typical move/);
      expect(lines.find((l) => l.startsWith('Holds if'))).toBe('Holds if BTC stays above $68,199.99 — a $519 (0.8%) drop flips it.');
    }
  });

  it('missing spot / close: those lines go, the rest stay, still no NaN', () => {
    const lines = why(meta({ publicPrice: null, eventCloseAt: null }), edge({ spot_price: null, event_close_at: null }));
    expect(lines.join('\n')).not.toMatch(/NaN|Infinity|undefined|null/);
    expect(lines.some((l) => l.startsWith('BTC is'))).toBe(false);
    expect(lines.some((l) => l.startsWith('Our model'))).toBe(true);
  });

  it('never prints the licensed index (ref_spot / meta.spotPrice)', () => {
    const blob = why(meta(), edge()).join('\n');
    expect(blob).not.toContain('68,733');
    expect(blob).not.toContain('68733');
  });

  it('track record: band of the side price, n ≥ 20', () => {
    const lines = why(meta(), edge({ kalshi_yes: 0.655, prob_physical: 0.79 }));
    expect(lines.at(-1)).toBe('Bitcoin picks entered at 60–70¢ won 77% (59 of 77) over the last 90 days, +$0.10 per contract after fees.');
  });

  it('track record: missing record → line omitted', () => {
    expect(why(meta(), edge(), null).some((l) => /picks entered|history/.test(l))).toBe(false);
  });

  it('track record: thin and negative bands', () => {
    expect(bandRecordLine({ record, sidePrice: 0.45 })).toBe('Thin history at this price (n=12).');
    expect(bandRecordLine({ record, sidePrice: 0.95 })).toBe('Thin history at this price (n=0).');
    expect(bandRecordLine({ record, sidePrice: 0.29 })).toBe(
      'This price range has lost money: bitcoin picks entered at 20–30¢ won 16% (5 of 32) over the last 90 days, −$0.11 per contract after fees.',
    );
    // NO side bands on the NO price
    expect(why(meta(), edge({ direction: 'BUY NO', kalshi_yes: 0.35, prob_physical: 0.2 })).at(-1)).toMatch(/entered at 60–70¢/);
  });

  it('summarizeBands: YES price for YES picks, 1 − it for NO picks; ungraded rows ignored', () => {
    const r = summarizeBands([
      { predicted_side: 'YES', market_price_at_pick: '0.655', resolution: 'won', net_pnl_cents: 33 },
      { predicted_side: 'NO', market_price_at_pick: '0.35', resolution: 'lost', net_pnl_cents: -67 },
      { predicted_side: 'YES', market_price_at_pick: '0.22', resolution: 'void', net_pnl_cents: 0 },
    ]);
    expect(r.bands[6]).toEqual({ n: 2, wins: 1, netCents: -34 });
    expect(r.bands[2]).toBeUndefined();
  });

  it('stays within the char budget, dropping momentum then volatility first', () => {
    const long = { days: 90, bands: { 6: { n: 1234, wins: 999, netCents: -123456 } } };
    const lines = why(meta({ publicPrice: 123456789.12 }), edge({ strike: 1234.99, kalshi_yes: 0.655, prob_physical: 0.79, mu_used: 40 }), long);
    expect(lines.join('\n').length).toBeLessThanOrEqual(WHY_CHAR_BUDGET);
    const normal = why(meta(), edge({ kalshi_yes: 0.655, prob_physical: 0.79 }));
    expect(normal.join('\n').length).toBeLessThanOrEqual(WHY_CHAR_BUDGET);
  });
});

describe('bitcoin Why embed', () => {
  it('description is the Why block; title format unchanged; brand-safe; no feeds; no "implied"', () => {
    const p = buildCommodityEmbed(meta(), edge(), { record, now: NOW });
    const e = p.embeds[0];
    expect(e.title).toBe('Bitcoin Edge • BUY YES $68199.99 • +12pp • SPECULATIVE');
    expect(e.description.split('\n')[0]).toMatch(/^BTC is \$68,719/);
    expect(() => assertBrandSafe(p)).not.toThrow();
    const blob = JSON.stringify(p);
    expect(blob).not.toMatch(BANNED_FEEDS);
    expect(blob).not.toMatch(/\block\b|guarantee/i);
    expect(blob).not.toMatch(/NaN|Infinity|undefined/);
    expect(e.footer.text).toBe('KXBTCD-26NOV1211 • settles 11:00 AM ET • Market analysis, not financial advice');
  });

  it('keeps Entry range, drops Market price / Our model / Spot the Why block states', () => {
    const names = buildCommodityEmbed(meta(), edge(), { record, now: NOW }).embeds[0].fields.map((f) => f.name);
    expect(names).toEqual(['Entry range']);
  });

  it('keeps the model fields when the disagreement line was omitted', () => {
    const names = buildCommodityEmbed(meta(), edge({ prob_physical: 0.2 }), { now: NOW }).embeds[0].fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Market price', 'Our model', 'Entry range']));
  });

  it('silver keeps today\'s embed exactly (no Why, same fields, same footer)', () => {
    const m = { ...meta({ commodity: 'silver', eventTicker: 'KXSILVERD-26NOV1217', publicPrice: 35.4 }), hoursToClose: 3.2 };
    const e = { direction: 'BUY YES', strike: 35.99, edge_pp: 0.142, kalshi_yes: 0.31, options_prob: 0.452, rationale: '' };
    const p = buildCommodityEmbed(m, e, { record, now: NOW });
    expect(p.embeds[0].description).toBe('Our model 45% vs market 31% that silver is above $35.99 at settle · YES underpriced by 14.2 pts');
    expect(p.embeds[0].fields.map((f) => f.name)).toEqual(['Market price', 'Our model', 'Spot']);
    expect(p.embeds[0].footer.text).toMatch(/closes in 3\.2h • 30 strikes scanned$/);
  });
});

// Minimal supabase-js stand-in: rpc (budget), discord_posts_log reads/inserts, tool_settles record.
function fakeSb({ settles = [], settlesError = null } = {}) {
  const calls = { rpc: [], inserts: [], settlesReads: 0 };
  return {
    calls,
    rpc: async (fn, args) => {
      calls.rpc.push({ fn, args });
      return { data: 5, error: null };
    },
    from: (table) => {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        like: () => q,
        limit: () => {
          calls.settlesReads++;
          return Promise.resolve(settlesError ? { data: null, error: settlesError } : { data: settles, error: null });
        },
        gte: () => (table === 'tool_settles' ? q : Promise.resolve({ data: [], error: null })),
        insert: async (row) => {
          calls.inserts.push({ table, row });
          return { error: null };
        },
      };
      return q;
    },
  };
}

describe('routing + record fetch', () => {
  beforeEach(() => {
    _resetCommoditySession();
    _resetRecordCache();
  });

  it('bitcoin MODERATE/SPECULATIVE → #btc-edge; STRONG and silver unchanged', () => {
    expect(commodityChannelFor('bitcoin', 'SPECULATIVE')).toBe(BTC_EDGE_CHANNEL_ID);
    expect(commodityChannelFor('bitcoin', 'MODERATE')).toBe(BTC_EDGE_CHANNEL_ID);
    expect(commodityChannelFor('bitcoin', 'STRONG')).toBe('1487857828084584528');
    expect(commodityChannelFor('silver', 'MODERATE')).toBe(EDGE_FEED_CHANNEL_ID);
    expect(commodityChannelFor('silver', 'SPECULATIVE')).toBe(EDGE_FEED_CHANNEL_ID);
  });

  it('posts bitcoin to #btc-edge on its own cap (12), logs that channel, carries the record line', async () => {
    const settles = Array.from({ length: 25 }, (_, i) => ({
      resolution: i < 19 ? 'won' : 'lost',
      net_pnl_cents: i < 19 ? 30 : -70,
      tool_picks: { predicted_side: 'YES', market_price_at_pick: 0.29 },
    }));
    const sb = fakeSb({ settles });
    let payload;
    const post = vi.fn(async (_ch, p) => { payload = p; return { id: 'm1' }; });
    expect(await postCommodityAlert(meta({ topEdge: edge() }), { sb, post, now: NOW })).toBe(true);
    expect(post).toHaveBeenCalledWith(BTC_EDGE_CHANNEL_ID, expect.any(Object));
    expect(sb.calls.rpc[0].args).toEqual({ p_channel_id: BTC_EDGE_CHANNEL_ID, p_daily_cap: 12 });
    expect(sb.calls.inserts[0].row).toMatchObject({ channel_id: BTC_EDGE_CHANNEL_ID, subject_key: 'commodity:bitcoin:68199.99:YES' });
    expect(payload.embeds[0].description).toContain('Bitcoin picks entered at 20–30¢ won 76% (19 of 25)');
  });

  it('a failed record read omits the line and never blocks the alert; cached for the hour', async () => {
    const sb = fakeSb({ settlesError: new Error('boom') });
    let payload;
    const post = vi.fn(async (_ch, p) => { payload = p; return { id: 'm2' }; });
    expect(await postCommodityAlert(meta({ topEdge: edge() }), { sb, post, now: NOW })).toBe(true);
    expect(payload.embeds[0].description).not.toMatch(/picks entered|history/);
    await fetchBandRecord(sb, 'bitcoin', { now: new Date(NOW.getTime() + 30 * 60_000) });
    expect(sb.calls.settlesReads).toBe(1);
    await fetchBandRecord(sb, 'bitcoin', { now: new Date(NOW.getTime() + 61 * 60_000) });
    expect(sb.calls.settlesReads).toBe(2);
  });

  it('silver still routes to #edge-feed and never reads the record', async () => {
    const sb = fakeSb();
    const post = vi.fn(async () => ({ id: 'm3' }));
    const e = { direction: 'BUY YES', strike: 35.99, edge_pp: 0.09, kalshi_yes: 0.31, options_prob: 0.4, rationale: '' };
    await postCommodityAlert(meta({ commodity: 'silver', topTier: 'MODERATE', topEdge: e, publicPrice: 35.4 }), { sb, post, now: NOW });
    expect(post).toHaveBeenCalledWith(EDGE_FEED_CHANNEL_ID, expect.any(Object));
    expect(sb.calls.settlesReads).toBe(0);
  });
});

// Benny 2026-11-14 ("yes on 3"): disclose when calibration is more cautious than the model.
describe('calibration line', () => {
  const why = (o) => buildWhyBitcoin({ meta: meta(), edge: edge(o), now: NOW }).join('\n');
  it('says there is no edge when calibration lands below the market', () => {
    const t = why({ calibrated_prob: 0.27 });
    expect(t).toMatch(/more cautious at 27%, below Kalshi's price: on that read there is no edge here\./);
  });
  it('says unconfirmed when calibration sits on the market', () => {
    expect(why({ calibrated_prob: 0.3 })).toMatch(/more cautious at 30%, about where Kalshi is, so treat this edge as unconfirmed\./);
  });
  it('states the smaller edge when calibration lands between market and model', () => {
    expect(why({ calibrated_prob: 0.35 })).toMatch(/more cautious at 35%; on that read the edge is 6 pts, not 12\./);
  });
  it('is silent when calibration agrees (within 3 pts) or is more bullish', () => {
    expect(why({ calibrated_prob: 0.39 })).not.toMatch(/calibration/);
    expect(why({ calibrated_prob: 0.5 })).not.toMatch(/calibration/);
    expect(why({ calibrated_prob: null })).not.toMatch(/calibration/);
  });
  it('mirrors for BUY NO', () => {
    // model YES 0.41 → NO 59; market YES 0.55 → NO 45; calibrated YES 0.53 → NO 47 (12 pts more cautious)
    const t = buildWhyBitcoin({ meta: meta(), edge: edge({ direction: 'BUY NO', kalshi_yes: 0.55, calibrated_prob: 0.53 }), now: NOW }).join('\n');
    expect(t).toMatch(/more cautious at 47%; on that read the edge is 2 pts, not 14\.|more cautious at 47%, about where Kalshi is/);
  });
  it('survives the char budget with a full record line and stays brand-safe', () => {
    const record = summarizeBands([{ predicted_side: 'YES', market_price_at_pick: 0.29, resolution: 'lost', net_pnl_cents: -30 }]);
    const lines = buildWhyBitcoin({ meta: meta(), edge: edge({ calibrated_prob: 0.27 }), record, now: NOW });
    const t = lines.join('\n');
    expect(t).toMatch(/calibration/);
    expect(t.length).toBeLessThanOrEqual(WHY_CHAR_BUDGET);
    expect(() => assertBrandSafe({ embeds: [{ description: t }] })).not.toThrow();
  });
});
