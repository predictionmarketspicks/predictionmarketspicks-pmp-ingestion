// F4: Fly commodity alerts go on the shared Discord budget
// (DISCORD_CLEANUP_AUTOPILOT_2026-10-25; contract = site _shared/discord.ts postWithBudget).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  commodityGate,
  commoditySubjectKey,
  EDGE_FEED_CHANNEL_ID,
  MAX_POSTS_PER_UNDERLYING_PER_DAY,
} from '../src/delivery/discord-budget.js';
import { postCommodityAlert, _resetCommoditySession } from '../src/delivery/discord.js';

const NOW = new Date('2026-10-26T15:00:00Z'); // 11:00 ET Monday
const edge = { direction: 'BUY YES', strike: 62.5, edge_pp: 0.09, kalshi_yes: 0.4, options_prob: 0.49, rationale: '' };
const meta = (o = {}) => ({
  commodity: 'oil',
  eventTicker: 'KXWTI-26OCT26',
  eventCloseAt: '2026-10-26T18:30:00Z', // 3.5h out
  hoursToClose: 3.5,
  strikeCount: 20,
  generatedAt: NOW.toISOString(),
  topTier: 'MODERATE',
  topEdge: edge,
  publicPrice: 61.9,
  spotLabel: 'Yahoo CL=F (contract-aware CLM26.NYM primary, CL=F continuous fallback)',
  ...o,
});

// Minimal supabase-js stand-in recording rpc + insert calls.
function fakeSb({ budget = 5, keys = [], rpcError = null, readError = null } = {}) {
  const calls = { rpc: [], inserts: [], likes: [] };
  const sb = {
    calls,
    rpc: async (fn, args) => {
      calls.rpc.push({ fn, args });
      return rpcError ? { data: null, error: rpcError } : { data: budget, error: null };
    },
    from: (table) => {
      const q = {
        select: () => q,
        eq: () => q,
        like: (_c, v) => { calls.likes.push(v); return q; },
        gte: async () => (readError ? { data: null, error: readError } : { data: keys.map((k) => ({ subject_key: k })), error: null }),
        insert: async (row) => { calls.inserts.push({ table, row }); return { error: null }; },
      };
      return q;
    },
  };
  return sb;
}

describe('commodityGate', () => {
  const base = { meta: meta(), edge, todayKeys: [], budgetLeft: 5, sessionKeys: new Set(), now: NOW };
  it('passes a fresh alert', () => expect(commodityGate(base)).toEqual({ ok: true }));
  it('holds with < 45 min to close', () => {
    expect(commodityGate({ ...base, meta: meta({ eventCloseAt: '2026-10-26T15:44:00Z' }) }).reason).toBe('near_close');
    expect(commodityGate({ ...base, meta: meta({ eventCloseAt: '2026-10-26T15:46:00Z' }) }).ok).toBe(true);
  });
  it('holds the 3rd post on one underlying in a day', () => {
    const keys = ['commodity:oil:60.00:YES', 'commodity:oil:61.00:NO'];
    expect(keys).toHaveLength(MAX_POSTS_PER_UNDERLYING_PER_DAY);
    expect(commodityGate({ ...base, todayKeys: keys }).reason).toBe('underlying_cap');
  });
  it('never repeats strike + direction in a session', () => {
    expect(commodityGate({ ...base, todayKeys: [commoditySubjectKey('oil', edge)] }).reason).toBe('repeat_session');
    // opposite direction on the same strike is a different subject
    expect(commodityGate({ ...base, todayKeys: ['commodity:oil:62.50:NO'] }).ok).toBe(true);
  });
  it('holds when the channel budget is spent', () => {
    expect(commodityGate({ ...base, budgetLeft: 0 }).reason).toBe('budget');
  });
  it('fails open when the ledger/budget reads failed (null)', () => {
    expect(commodityGate({ ...base, todayKeys: null, budgetLeft: null }).ok).toBe(true);
  });
});

describe('postCommodityAlert — budget contract', () => {
  beforeEach(() => _resetCommoditySession());

  it('checks discord_budget_remaining (#edge-feed, cap 12), posts, then logs discord_posts_log', async () => {
    const sb = fakeSb();
    const post = vi.fn(async () => ({ id: 'msg-1' }));
    expect(await postCommodityAlert(meta(), { sb, post, now: NOW })).toBe(true);
    expect(sb.calls.rpc).toEqual([{ fn: 'discord_budget_remaining', args: { p_channel_id: EDGE_FEED_CHANNEL_ID, p_daily_cap: 12 } }]);
    expect(post).toHaveBeenCalledWith(EDGE_FEED_CHANNEL_ID, expect.any(Object));
    expect(sb.calls.likes).toEqual(['commodity:oil:%']);
    expect(sb.calls.inserts).toHaveLength(1);
    expect(sb.calls.inserts[0]).toMatchObject({
      table: 'discord_posts_log',
      row: { channel_id: EDGE_FEED_CHANNEL_ID, feed: 'commodity', tier: 'MODERATE', message_id: 'msg-1', subject_key: 'commodity:oil:62.50:YES' },
    });
  });

  it('posts nothing and logs nothing when the budget is spent', async () => {
    const sb = fakeSb({ budget: 0 });
    const post = vi.fn(async () => ({ id: 'x' }));
    expect(await postCommodityAlert(meta(), { sb, post, now: NOW })).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(sb.calls.inserts).toHaveLength(0);
  });

  it('does not log when the send fails', async () => {
    const sb = fakeSb();
    const post = vi.fn(async () => false);
    expect(await postCommodityAlert(meta(), { sb, post, now: NOW })).toBe(false);
    expect(sb.calls.inserts).toHaveLength(0);
  });

  it('in-process guard blocks a repeat even when the ledger is unreadable', async () => {
    const sb = fakeSb({ readError: new Error('down'), rpcError: new Error('down') });
    const post = vi.fn(async () => ({ id: 'a' }));
    expect(await postCommodityAlert(meta(), { sb, post, now: NOW })).toBe(true);
    expect(await postCommodityAlert(meta(), { sb, post, now: NOW })).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('STRONG routes to #oracle-picks on its own cap (5)', async () => {
    const sb = fakeSb();
    const post = vi.fn(async () => ({ id: 'b' }));
    await postCommodityAlert(meta({ commodity: 'gold', topTier: 'STRONG', calibrationActive: true }), { sb, post, now: NOW });
    expect(sb.calls.rpc[0].args).toEqual({ p_channel_id: '1487857828084584528', p_daily_cap: 5 });
  });

  it('the posted embed carries no vendor, no spotLabel plumbing, no raw rationale', async () => {
    const sb = fakeSb();
    let payload;
    const post = vi.fn(async (_ch, p) => { payload = p; return { id: 'c' }; });
    await postCommodityAlert(meta({ topEdge: { ...edge, rationale: 'IV 31.2% from the USO chain (Databento)' } }), { sb, post, now: NOW });
    const blob = JSON.stringify(payload);
    expect(blob).not.toMatch(/Databento|OPRA|Tradier|Massive|Yahoo|CLM26|USO chain|IV 31/);
    expect(payload.embeds[0].fields.map((f) => f.name)).toEqual(expect.arrayContaining(['Market price', 'Our model', 'Spot']));
  });
});
