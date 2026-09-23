// KXBTC15M payload contract for the cockpit (site repo BITCOIN_15M_TECHNICAL_REBUILD
// T4.1 items 2–3): `velocity` rides on every payload (open or between windows), and
// `first_touch` is the live window's, keyed by the ACTIVE market ticker.
import { describe, it, expect } from 'vitest';
import { buildPayload, CRYPTO_15M } from '../src/engine/crypto-15m.js';

const cfg = Object.values(CRYPTO_15M)[0];
const now = Date.parse('2026-09-23T17:40:00Z');
const active = {
  ticker: 'KXBTC15M-26SEP231345-45',
  event_ticker: 'KXBTC15M-26SEP231345',
  open_time: '2026-09-23T17:30:00Z',
  close_time: '2026-09-23T17:45:00Z',
  floor_strike: 84000,
  yes_bid_dollars: '0.4000',
  yes_ask_dollars: '0.4200',
};
const velocity = { direction: 'up', pace: 'accelerating', ret_1m_pct: 0.05, ret_3m_pct: 0.09, flat_below_pct: 0.0154, source: 'coinbase_ws', as_of: '2026-09-23T17:39:59.000Z' };

describe('crypto-15m payload — velocity + first touch', () => {
  it('carries velocity and the active market’s first touch', () => {
    const seen = [];
    const env = buildPayload(cfg, {
      markets: [active], spot: null, stats: null, gradedCount: 0, velocity, now,
      firstTouchFor: (t) => { seen.push(t); return { from_open: true, yes: { 45: 700000 }, no: {} }; },
    });
    expect(env.data.velocity).toEqual(velocity);
    expect(env.data.first_touch).toEqual({ from_open: true, yes: { 45: 700000 }, no: {} });
    expect(seen).toEqual(['KXBTC15M-26SEP231345-45']);
  });

  it('between windows: velocity still published, no first touch', () => {
    const env = buildPayload(cfg, { markets: [], spot: null, stats: null, gradedCount: 0, velocity, now });
    expect(env.data.market_closed).toBe(true);
    expect(env.data.velocity).toEqual(velocity);
    expect(env.data.first_touch).toBeUndefined();
  });

  it('defaults are null, never a guessed read', () => {
    const env = buildPayload(cfg, { markets: [active], spot: null, stats: null, gradedCount: 0, now });
    expect(env.data.velocity).toBeNull();
    expect(env.data.first_touch).toBeNull();
  });
});
