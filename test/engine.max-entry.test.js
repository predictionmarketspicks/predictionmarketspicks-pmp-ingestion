// Max entry — the commodity engines' own BUY rule solved for price (src/engine/max-entry.js).
import { describe, it, expect } from 'vitest';
import { maxEntryRange, commodityEntryRange, entryRangeLabel, entryRangeText, rangeOpen } from '../src/engine/max-entry.js';
import { feeFraction, __test__ } from '../src/engine/commodity-base.js';
import { COMMODITIES } from '../src/engine/commodities.js';
import { ENTRY_COST_FLOOR, MIN_EDGE_PP_NO } from '../src/engine/thresholds.js';

const { postSpreadSideGate, resolveYesFloor } = __test__;
const BTC = COMMODITIES.bitcoin;
const GOLD = COMMODITIES.gold;

// The engine's own gate at one price — the range must agree with it at every cent.
function yesPasses(cfg, probYes, askC) {
  const { minEdgeYes } = resolveYesFloor({
    yesAsk: askC / 100, enabled: cfg.yesFavoriteEnabled ?? true,
    favPrice: cfg.yesFavoritePrice ?? 0.7, favFloor: cfg.minEdgePpYesFavorite ?? 0.1, midFloor: 0.05, longshotMin: 0.15,
  });
  const g = postSpreadSideGate({ chosenProb: probYes, yesBid: 0.01, yesAsk: askC / 100, minEdgeYes, minEdgeNo: 9, chargeFees: cfg.chargeFees === true });
  return g.pass && g.dirYes;
}
function noPasses(cfg, probYes, noAskC) {
  const g = postSpreadSideGate({
    chosenProb: probYes, yesBid: 1 - noAskC / 100, yesAsk: 0.999, minEdgeYes: 9,
    minEdgeNo: cfg.minEdgePpNoSide ?? MIN_EDGE_PP_NO, noSideEnabled: true, chargeFees: cfg.chargeFees === true,
  });
  return g.pass && g.dirYes === false;
}

describe('maxEntryRange (pure solver)', () => {
  const fee = feeFraction;
  it('rounds DOWN to the last whole cent that passes', () => {
    // 0.6975 − 0.63 − fee(.63)=.02 → 0.0475 < .05; 0.62 − fee .02 → .0575 ≥ .05
    const r = maxEntryRange({ probSide: 0.6975, minEdgeAt: () => 0.05, feeAt: fee });
    expect(r.maxCents).toBe(62);
    // the boundary is exact at 62.75¢ before fee; never rounds up to 63
    expect(0.6975 - 0.63 - fee(0.63)).toBeLessThan(0.05);
  });
  it('fee at 50¢ is the 2¢ ceiling of 1.75¢, and 1¢ at the wings', () => {
    expect(fee(0.5)).toBe(0.02);
    expect(fee(0.95)).toBe(0.01);
    expect(fee(0.05)).toBe(0.01);
    // prob 0.575 at 50¢: 0.575 − 0.50 − 0.02 = 0.055 → passes at 50; at 51: .575−.51−.02 = .045 fails
    expect(maxEntryRange({ probSide: 0.575, minEdgeAt: () => 0.05, feeAt: fee }).maxCents).toBe(50);
    // wing: prob 0.995, 5pp floor → 93¢ (0.995 − .93 − .01 = .055; 94 → .045)
    expect(maxEntryRange({ probSide: 0.995, minEdgeAt: () => 0.05, feeAt: fee }).maxCents).toBe(93);
    // an exact float tie is decided the way the gate decides it (same arithmetic), never by an epsilon
    const tie = maxEntryRange({ probSide: 0.57, minEdgeAt: () => 0.05, feeAt: fee }).maxCents;
    expect(0.57 - tie / 100 - fee(tie / 100) >= 0.05).toBe(true);
    expect(0.57 - (tie + 1) / 100 - fee((tie + 1) / 100) >= 0.05).toBe(false);
  });
  it('a cap clips the range and a floor is reported as min', () => {
    const r = maxEntryRange({ probSide: 0.95, minEdgeAt: () => 0.06, feeAt: fee, floorCents: 40, capCents: 85 });
    expect(r).toEqual({ maxCents: 85, minCents: 40 });
    expect(entryRangeLabel('NO', r)).toBe('Buy NO 40–85¢');
  });
  it('past range: edge limit below the floor reads plainly', () => {
    const r = maxEntryRange({ probSide: 0.45, minEdgeAt: () => 0.1, feeAt: fee, floorCents: 40 });
    expect(r.maxCents).toBeLessThan(40);
    expect(rangeOpen(r)).toBe(false);
    expect(entryRangeLabel('YES', r)).toBe(`Past range: the edge is gone above ${r.maxCents}¢`);
  });
  it('past range against the live price', () => {
    const r = { maxCents: 58, minCents: 40 };
    expect(entryRangeText('YES', r, 61)).toBe('Past range: the edge is gone above 58¢');
    expect(entryRangeText('YES', r, 55)).toBe('Buy YES 40–58¢ · edge holds to 58¢');
    expect(entryRangeText('YES', { maxCents: 62, minCents: null })).toBe('Buy YES up to 62¢ · edge holds to 62¢');
  });
  it('no probability, no range', () => {
    expect(maxEntryRange({ probSide: null, minEdgeAt: () => 0.05, feeAt: fee })).toBeNull();
    expect(maxEntryRange({ probSide: 1, minEdgeAt: () => 0.05, feeAt: fee })).toBeNull();
  });
});

describe('commodityEntryRange agrees with postSpreadSideGate at every cent', () => {
  for (const [name, cfg] of [['bitcoin', BTC], ['gold', GOLD], ['silver', COMMODITIES.silver], ['oil', COMMODITIES.oil]]) {
    it(`${name} YES`, () => {
      for (const p of [0.48, 0.5554, 0.6975, 0.78, 0.83, 0.97]) {
        const r = commodityEntryRange(cfg, { side: 'YES', probYes: p, feeFraction });
        expect(r.minCents).toBe(Math.round(ENTRY_COST_FLOOR * 100));
        expect(yesPasses(cfg, p, r.maxCents)).toBe(true);
        if (r.maxCents < 99) expect(yesPasses(cfg, p, r.maxCents + 1)).toBe(false);
      }
    });
    it(`${name} NO — in the NO price`, () => {
      for (const p of [0.05, 0.2, 0.3139, 0.4]) {
        const r = commodityEntryRange(cfg, { side: 'NO', probYes: p, feeFraction });
        expect(noPasses(cfg, p, r.maxCents)).toBe(true);
        if (r.maxCents < 99) expect(noPasses(cfg, p, r.maxCents + 1)).toBe(false);
      }
    });
  }
  it('oil NO pick 2026-10-23 (prob YES 0.3139): NO edge holds to 56¢', () => {
    // NO prob 0.6861; at 57¢ NO: yesBid .43 − .3139 − fee(.43)=.02 = .0961 < .10; at 56¢: .44 − .3139 − .02 = .1061
    const r = commodityEntryRange(COMMODITIES.oil, { side: 'NO', probYes: 0.3139, feeFraction });
    expect(r).toEqual({ maxCents: 56, minCents: 40 });
  });
  it('bitcoin YES favorite band switches to the 10pp floor at 70¢', () => {
    // prob 0.835: 5pp would allow 76¢ (.835−.76−.02=.055), but ≥70¢ needs 10pp → 71¢ (.835−.71−.02=.105)
    const r = commodityEntryRange(BTC, { side: 'YES', probYes: 0.835, feeFraction });
    expect(r.maxCents).toBe(71);
  });
  it('reads the floor from config, not a copy', () => {
    const r = commodityEntryRange({ ...BTC, minEdgePpYesFavorite: 0.2 }, { side: 'YES', probYes: 0.835, feeFraction });
    expect(r.maxCents).toBe(69); // the favorite band is now unreachable; mid floor binds below 70
  });
});

import { stampEntryRange } from '../src/engine/commodity-base.js';
import { stripEntryCols, isMissingEntryColError } from '../src/delivery/supabase.js';

describe('stampEntryRange + writer tolerance', () => {
  it('stamps BUY rows only; a PASS row keeps its exact shape', () => {
    const rows = [
      { direction: 'BUY YES', model_version: 'v2_physical', prob_physical: 0.6975, options_prob: 0.5, kalshi_yes: 0.615 },
      { direction: 'BUY NO', model_version: 'v2_physical', prob_physical: 0.3139, kalshi_yes: 0.455 },
      { direction: 'PASS', model_version: 'v2_physical', prob_physical: 0.6975 },
    ];
    stampEntryRange(rows, COMMODITIES.oil);
    expect(rows[0].max_entry_cents).toBe(62);
    expect(rows[0].min_entry_cents).toBe(40);
    expect(rows[1]).toMatchObject({ max_entry_cents: 56, min_entry_cents: 40 });
    expect('max_entry_cents' in rows[2]).toBe(false);
  });
  it('strips the columns when the DDL is not applied yet', () => {
    expect(stripEntryCols({ a: 1, max_entry_cents: 5, min_entry_cents: 4 })).toEqual({ a: 1 });
    expect(isMissingEntryColError({ message: "Could not find the 'max_entry_cents' column of 'commodity_edge_signals' in the schema cache" })).toBe(true);
    expect(isMissingEntryColError({ message: 'duplicate key' })).toBe(false);
  });
});
