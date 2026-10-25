// #market-movers v2 selection (DISCORD_CLEANUP_AUTOPILOT_2026-10-25 F3).
import { describe, it, expect } from 'vitest';
import {
  collapseByEvent,
  applyRepostRule,
  selectMoverLines,
  moverLineText,
  moverPageUrl,
  eventKeyOf,
  MAX_LINES,
  MAX_SPORTS_LINES,
} from '../src/engine/movers.js';
import { latestMoverPostByEvent } from '../src/delivery/supabase.js';

const c = (o = {}) => ({
  source: 'kalshi',
  seriesOrSlug: 'KXNBAGAME',
  ticker: 'KXNBAGAME-26OCT25TORMIN-TOR',
  event_ticker: 'KXNBAGAME-26OCT25TORMIN',
  title: 'Toronto wins',
  yes_sub_title: 'Toronto',
  yes_price: 50,
  volume_24h: 200_000,
  price_change_24h: 9,
  category: 'Sports',
  ...o,
});
const MIN = c({ ticker: 'KXNBAGAME-26OCT25TORMIN-MIN', title: 'Minnesota wins', yes_sub_title: 'Minnesota', yes_price: 51, price_change_24h: -9 });

describe('collapseByEvent — one line per event', () => {
  it('Toronto ▲9 and Minnesota ▼9 are one move: keeps the side that moved up', () => {
    const out = collapseByEvent([MIN, c()]);
    expect(out).toHaveLength(1);
    expect(out[0].yes_sub_title).toBe('Toronto');
  });

  it('keeps the best-scored gainer in a multi-outcome event', () => {
    const a = c({ seriesOrSlug: 'KXFED', ticker: 'KXFED-27APR-T3.75', event_ticker: 'KXFED-27APR', price_change_24h: 4, category: 'Economics' });
    const b = c({ seriesOrSlug: 'KXFED', ticker: 'KXFED-27APR-T3.50', event_ticker: 'KXFED-27APR', price_change_24h: 7, category: 'Economics' });
    const d = c({ seriesOrSlug: 'KXFED', ticker: 'KXFED-27APR-T4.00', event_ticker: 'KXFED-27APR', price_change_24h: -12, category: 'Economics' });
    expect(collapseByEvent([a, b, d]).map((x) => x.ticker)).toEqual(['KXFED-27APR-T3.50']);
  });

  it('an event with only losers keeps its biggest loser', () => {
    const out = collapseByEvent([MIN]);
    expect(out[0].ticker).toBe(MIN.ticker);
  });

  it('swaps a loser-only event to its up side from the unfiltered pool', () => {
    const thinTor = c({ volume_24h: 100 }); // below the volume floor, so only MIN passed the filter
    const out = collapseByEvent([MIN], [MIN, thinTor]);
    expect(out[0].yes_sub_title).toBe('Toronto');
  });

  it('derives the event key from the ticker when event_ticker is missing', () => {
    expect(eventKeyOf({ ticker: 'KXNBAGAME-26OCT25TORMIN-TOR' })).toBe('KXNBAGAME-26OCT25TORMIN');
  });
});

describe('applyRepostRule — skip a market posted in 24h unless it moved ≥5pp more', () => {
  const last = new Map([['KXNBAGAME-26OCT25TORMIN', { market_id: 'KXNBAGAME-26OCT25TORMIN-TOR', alert_price: 50 }]]);

  it('suppresses an event posted in the window with < 5pp further move', () => {
    const prices = new Map([['KXNBAGAME-26OCT25TORMIN-TOR', 53]]);
    expect(applyRepostRule([c({ yes_price: 53 })], last, prices)).toHaveLength(0);
  });

  it('re-qualifies once the posted market moved ≥5pp since the post', () => {
    const prices = new Map([['KXNBAGAME-26OCT25TORMIN-TOR', 55]]);
    expect(applyRepostRule([c({ yes_price: 55 })], last, prices)).toHaveLength(1);
  });

  it('measures the posted side even when the other side is now the gainer', () => {
    const prices = new Map([['KXNBAGAME-26OCT25TORMIN-TOR', 42]]);
    const minUp = { ...MIN, price_change_24h: 8, yes_price: 58 };
    expect(applyRepostRule([minUp], last, prices)).toHaveLength(1);
  });

  it('passes events never posted', () => {
    expect(applyRepostRule([c({ event_ticker: 'X-1', ticker: 'X-1-A' })], last, new Map())).toHaveLength(1);
  });

  it('latestMoverPostByEvent keeps the newest row per event', () => {
    const m = latestMoverPostByEvent([
      { market_id: 'KXNBAGAME-26OCT25TORMIN-TOR', alert_price: '50', created_at: '2026-10-25 11:20:31+00' },
      { market_id: 'KXNBAGAME-26OCT25TORMIN-MIN', alert_price: '51', created_at: '2026-10-25 15:20:32+00' },
    ]);
    expect(m.get('KXNBAGAME-26OCT25TORMIN')).toMatchObject({ market_id: 'KXNBAGAME-26OCT25TORMIN-MIN', alert_price: 51 });
  });
});

describe('selectMoverLines — ≤4 sports, then econ/politics/crypto, ≤8', () => {
  const sports = Array.from({ length: 6 }, (_, i) => c({ ticker: `S-${i}-A`, event_ticker: `S-${i}`, price_change_24h: 10 + i }));
  const econ = Array.from({ length: 6 }, (_, i) => c({ ticker: `E-${i}-A`, event_ticker: `E-${i}`, category: i % 3 === 0 ? 'Economics' : i % 3 === 1 ? 'Politics' : 'Crypto', price_change_24h: 3 + i }));
  const other = [c({ ticker: 'W-1-A', event_ticker: 'W-1', category: 'Weather', price_change_24h: 40 })];

  it('caps sports at 4 and the post at 8, sports first', () => {
    const out = selectMoverLines([...sports, ...econ, ...other]);
    expect(out).toHaveLength(MAX_LINES);
    expect(out.filter((x) => x.category === 'Sports')).toHaveLength(MAX_SPORTS_LINES);
    expect(out.slice(0, 4).every((x) => x.category === 'Sports')).toBe(true);
    expect(out.find((x) => x.category === 'Weather')).toBeUndefined();
  });

  it('fills with non-sports when there are few sports moves', () => {
    const out = selectMoverLines([sports[0], ...econ]);
    expect(out).toHaveLength(7);
  });
});

describe('moverLineText / moverPageUrl', () => {
  it('renders the spec format', () => {
    expect(moverLineText(c(), 'Toronto vs Minnesota')).toBe('Toronto vs Minnesota — Toronto 50¢ (▲9 in 24h)');
  });

  it('renders a loser with ▼ and strips a trailing question mark', () => {
    const fed = c({ seriesOrSlug: 'KXFED', yes_sub_title: 'Above 3.75%', yes_price: 61, price_change_24h: -6, category: 'Economics' });
    expect(moverLineText(fed, 'Fed funds rate after Apr 2027 meeting?')).toBe('Fed funds rate after Apr 2027 meeting — Above 3.75% 61¢ (▼6 in 24h)');
  });

  it('falls back to the market title without an event title', () => {
    expect(moverLineText(c({ yes_sub_title: null }), null)).toBe('Toronto wins — 50¢ (▲9 in 24h)');
  });

  it('links our closest page with the market-movers UTMs, never Kalshi', () => {
    expect(moverPageUrl(c())).toBe('https://predictionmarketspicks.com/nba?utm_source=discord&utm_medium=feed&utm_campaign=market-movers');
    expect(moverPageUrl(c({ seriesOrSlug: 'KXFED' }))).toMatch(/\/tools\/fed-rate-tracker\?/);
    expect(moverPageUrl(c({ seriesOrSlug: 'KXNEW', category: 'Crypto' }))).toMatch(/\/crypto-markets\?/);
    expect(moverPageUrl(c({ seriesOrSlug: 'KXNEW', category: 'Nope' }))).toMatch(/\/kalshi\?/);
  });
});
