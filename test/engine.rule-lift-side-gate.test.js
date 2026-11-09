// EDGE_LOOP_V2_2026-11-09 U5 (S8): a `promote` rule with lift_side_gate lifts the post-spread side
// gate on a row whose gross edge matched; one lifted strike per event survives. With no such rule
// the engine is byte-identical (the golden tests pin that).
import { describe, it, expect } from 'vitest';
import { applyEngineRules, conditionMatches, __setRulesForTest } from '../src/engine/engine-rules.js';
import { selectBestLiftedStrike, SOFT_SIDE_GATE_REASONS } from '../src/engine/commodity-base.js';

const S8 = {
  id: 's8-gold', scope: 'gold-edge', action: 'promote', status: 'active', pot_key: 'metals|reopen',
  condition: { edge_pp_min: 7, pot_key: 'metals|reopen', lift_side_gate: true },
};
const ctx = { commodity: 'gold', dow: 1, hourUtc: 15, hourEt: 10, dowEt: 'Mon', impliedProb: 0.55, edgePp: 8.2, tier: 2, direction: 'PASS' };

describe('promote + lift_side_gate (S8)', () => {
  it('lift_side_gate is a parameter, not a predicate: the rule still matches on edge_pp_min', () => {
    expect(conditionMatches(S8.condition, ctx)).toBe(true);
    expect(conditionMatches(S8.condition, { ...ctx, edgePp: 6.9 })).toBe(false);
  });
  it('the verdict carries liftSideGate only for a promote rule that asks for it', () => {
    __setRulesForTest([S8], true);
    expect(applyEngineRules(ctx)).toMatchObject({ promote: true, liftSideGate: true, ruleIds: ['s8-gold'] });
    __setRulesForTest([{ ...S8, condition: { edge_pp_min: 7 } }], true);
    expect(applyEngineRules(ctx)).toMatchObject({ promote: true, liftSideGate: false });
    // a surviving suppress beats the promote AND the lift
    __setRulesForTest([S8, { id: 'sup', scope: 'gold-edge', action: 'suppress', status: 'active', condition: { edge_pp_min: 7 } }], true);
    expect(applyEngineRules(ctx)).toMatchObject({ suppress: true, promote: false, liftSideGate: false });
    // no rule ⇒ nothing (the S8-less world)
    __setRulesForTest([], true);
    expect(applyEngineRules(ctx).liftSideGate).toBe(false);
  });
  it('the liftable refusals are the side gate\'s four — never a quality flag, never the entry floor', () => {
    expect([...SOFT_SIDE_GATE_REASONS].sort()).toEqual(['no_net_below_floor', 'no_side_disabled', 'yes_longshot', 'yes_net_below_floor']);
    for (const never of ['entry_floor', 'implausible_ceiling', 'hard_suppress', 'edge_under_5pp', 'fused_no_edge']) {
      expect(SOFT_SIDE_GATE_REASONS.has(never)).toBe(false);
    }
  });
});

describe('selectBestLiftedStrike — one lifted BUY per event per snapshot', () => {
  const prior = (pass_reason) => ({ prior: { direction: 'PASS', confidence: 'low', fused_confidence: 'NO_EDGE', pass_reason, rationale: 'gate held' } });
  const buy = (strike, edge) => ({ strike, direction: edge > 0 ? 'BUY YES' : 'BUY NO', confidence: 'low', fused_confidence: 'MODERATE', fused_edge_pp: edge, pass_reason: null, rationale: 'lifted' });

  it('keeps the best gross strike and restores the others to the gate\'s own pass_reason', () => {
    const rows = [buy(4000, 0.08), buy(4010, -0.11), buy(4020, 0.075), { strike: 4030, direction: 'PASS', pass_reason: 'entry_floor' }];
    const lifted = new Map([['4000', prior('no_net_below_floor')], ['4010', prior('no_net_below_floor')], ['4020', prior('yes_net_below_floor')]]);
    selectBestLiftedStrike(rows, lifted);
    expect(rows[1].direction).toBe('BUY NO');
    expect(rows[0]).toMatchObject({ direction: 'PASS', confidence: 'low', fused_confidence: 'NO_EDGE', pass_reason: 'no_net_below_floor' });
    expect(rows[2]).toMatchObject({ direction: 'PASS', pass_reason: 'yes_net_below_floor' });
    expect(rows[0].rationale).toMatch(/yielded to the best strike 4010/);
    expect(rows[3]).toEqual({ strike: 4030, direction: 'PASS', pass_reason: 'entry_floor' }); // untouched: not lifted
  });
  it('a single lifted strike, or none, is a no-op; an engine-side BUY that was never lifted is never demoted', () => {
    const rows = [buy(4000, 0.08), buy(4010, 0.2)];
    selectBestLiftedStrike(rows, new Map([['4000', prior('yes_longshot')]]));
    expect(rows.map((r) => r.direction)).toEqual(['BUY YES', 'BUY YES']);
    const same = JSON.stringify(rows);
    selectBestLiftedStrike(rows, new Map());
    selectBestLiftedStrike(rows, null);
    expect(JSON.stringify(rows)).toBe(same);
  });
});
