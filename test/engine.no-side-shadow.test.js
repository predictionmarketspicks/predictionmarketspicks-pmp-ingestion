// Off-record Bitcoin Edge NO-side shadow (2026-10-24). The NO side stays OFF on
// the published record (noSideEnabled=false); these rows only ever go to
// commodity_longshot_shadow (reason 'no_side').
import { describe, it, expect } from 'vitest';
import { selectNoSideShadow, NO_SIDE_SHADOW } from '../src/engine/commodity-base.js';
import { getCommodityConfig } from '../src/engine/commodities.js';

const row = (o = {}) => ({
  snapshot_at: '2026-10-24T15:20:00.000Z', commodity: 'bitcoin', event_ticker: 'KXBTCD-26OCT2412',
  event_close_at: '2026-10-24T16:00:00.000Z', strike: 80000, kalshi_yes: 0.55, direction: 'PASS',
  quality_flag: null, pass_reason: 'no_side_disabled', model_version: 'v2_physical', ...o,
});
const cand = (o = {}) => ({ strike: 80000, noNet: 0.11, gross: -0.14, chosenProb: 0.41, yesBid: 0.54, minutesToClose: 40, calibrationGoverns: false, ...o });

describe('selectNoSideShadow', () => {
  it('bitcoin keeps the published NO side OFF and turns the shadow on', () => {
    const c = getCommodityConfig('bitcoin');
    expect(c.noSideEnabled).toBe(false);
    expect(c.noSideShadow).toBe(true);
  });
  it('logs a qualifying NO crossing at the mint cost basis, YES price stored', () => {
    const [s] = selectNoSideShadow([cand()], [row()]);
    expect(s).toMatchObject({ tool_slug: 'bitcoin-edge', reason: 'no_side', predicted_side: 'NO', market_price_at_pick: 0.55, cost: 0.45, confidence: 'watch' });
    expect(s.event_day_key).toBe('bitcoin:KXBTCD-26OCT2412:2026-10-24:no_side');
    expect(s.regime_tags.clears_no_floor).toBe(true);
    expect(s.regime_tags.no_ask).toBe(0.46);
  });
  it('logs 5–10pp NO net rows too, tagged below the coded floor', () => {
    const [s] = selectNoSideShadow([cand({ noNet: 0.06 })], [row({ pass_reason: 'no_net_below_floor' })]);
    expect(s.regime_tags.clears_no_floor).toBe(false);
  });
  it('drops rows a NO pick could not have been', () => {
    const drop = (c, r) => expect(selectNoSideShadow([cand(c)], [row(r)])).toEqual([]);
    drop({}, { kalshi_yes: 0.65 });                 // NO costs 35¢ < 40¢ floor
    drop({ noNet: 0.04 }, {});                      // under 5pp net
    drop({ gross: -0.06 }, {});                     // under the 7pp MODERATE gross
    drop({ minutesToClose: 9 }, {});                // under the MODERATE minutes ceiling
    drop({}, { quality_flag: 'smile_kalshi_diverged' });
    drop({}, { pass_reason: 'hard_suppress' });
    drop({}, { direction: 'BUY YES' });             // never shadows a published row
    expect(NO_SIDE_SHADOW.minCost).toBe(0.4);
  });
  it('best NO net first, so the writer keeps one row per event-day', () => {
    const out = selectNoSideShadow([cand({ strike: 1, noNet: 0.06 }), cand({ strike: 2, noNet: 0.12 })], [row({ strike: 1 }), row({ strike: 2 })]);
    expect(out.map((s) => s.strike)).toEqual([2, 1]);
  });
});
