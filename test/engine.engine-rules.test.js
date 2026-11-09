// Loop-engine rule consumption (LOOP_ENGINE_RULES §PR6).
// Safety properties matter more than features here: every branch must fail
// toward publishing the signal unchanged.

import { describe, it, expect } from 'vitest';
import {
  conditionMatches,
  matchingRules,
  applyEngineRules,
  __setRulesForTest,
} from '../src/engine/engine-rules.js';

const ctx = { commodity: 'bitcoin', dow: 2, hourUtc: 15, impliedProb: 0.5 };
const rule = (over = {}) => ({
  id: 'aaaaaaaa-1111',
  scope: 'bitcoin-edge',
  action: 'suppress',
  condition: { dow: 2 },
  status: 'active',
  ...over,
});

describe('conditionMatches', () => {
  it('matches on a known key', () => {
    expect(conditionMatches({ dow: 2 }, ctx)).toBe(true);
    expect(conditionMatches({ dow: 3 }, ctx)).toBe(false);
  });

  it('coerces string dow (the miner writes "2")', () => {
    expect(conditionMatches({ dow: '2' }, ctx)).toBe(true);
  });

  it('requires ALL keys of a conjunction', () => {
    expect(conditionMatches({ dow: 2, hour_utc: 15 }, ctx)).toBe(true);
    expect(conditionMatches({ dow: 2, hour_utc: 16 }, ctx)).toBe(false);
  });

  it('handles implied-prob bands', () => {
    expect(conditionMatches({ implied_prob_min: 0.45, implied_prob_max: 0.55 }, ctx)).toBe(true);
    expect(conditionMatches({ implied_prob_min: 0.6 }, ctx)).toBe(false);
    expect(
      conditionMatches({ implied_prob_min: 0.4 }, { ...ctx, impliedProb: null }),
    ).toBe(false);
  });

  it('an EMPTY condition never matches', () => {
    // An empty condition is "everything". Honouring it would suppress the whole
    // tool from a single malformed row.
    expect(conditionMatches({}, ctx)).toBe(false);
    expect(conditionMatches(null, ctx)).toBe(false);
  });

  it('an unknown key makes the whole condition fail', () => {
    expect(conditionMatches({ dow: 2, regime: 'crowded_equilibrium' }, ctx)).toBe(false);
  });
});

describe('matchingRules', () => {
  it('scopes by tool slug, and "all" matches every commodity', () => {
    expect(matchingRules(ctx, [rule()])).toHaveLength(1);
    expect(matchingRules({ ...ctx, commodity: 'gold' }, [rule()])).toHaveLength(0);
    expect(matchingRules({ ...ctx, commodity: 'gold' }, [rule({ scope: 'all' })])).toHaveLength(1);
  });

  it('SKIPS a rule whose condition it cannot fully evaluate', () => {
    // The live 6/24 proposal is exactly this shape. Applying it on the keys we
    // do understand would be strictly BROADER than the miner justified.
    const r = rule({
      scope: 'all',
      action: 'downgrade',
      condition: { regime: 'crowded_equilibrium', sentiment: 'one_sided_extreme', volume_skew_min: 0.85 },
    });
    expect(matchingRules(ctx, [r])).toHaveLength(0);
  });

  it('skips an unknown action', () => {
    expect(matchingRules(ctx, [rule({ action: 'upsize' })])).toHaveLength(0);
    expect(matchingRules(ctx, [rule({ action: 'create' })])).toHaveLength(0);
  });
});

describe('applyEngineRules', () => {
  it('is a NO-OP when the kill switch is off, even with a matching rule', () => {
    __setRulesForTest([rule()], false);
    const v = applyEngineRules(ctx);
    expect(v.suppress).toBe(false);
    expect(v.matched).toHaveLength(0);
  });

  it('suppresses when enabled and matched, and tags the rule id', () => {
    __setRulesForTest([rule()], true);
    const v = applyEngineRules(ctx);
    expect(v.suppress).toBe(true);
    expect(v.note).toContain('rule:suppress');
    expect(v.note).toContain('aaaaaaaa');
  });

  it('downgrade does not imply suppress', () => {
    __setRulesForTest([rule({ action: 'downgrade' })], true);
    const v = applyEngineRules(ctx);
    expect(v.suppress).toBe(false);
    expect(v.downgrade).toBe(true);
  });

  it('no active rules => no-op', () => {
    __setRulesForTest([], true);
    expect(applyEngineRules(ctx).matched).toHaveLength(0);
  });

  it('size_cap takes the most conservative (smallest) cap', () => {
    __setRulesForTest(
      [
        rule({ id: 'r1', action: 'size_cap', condition: { dow: 2, size_cap_pct: 0.5 } }),
        rule({ id: 'r2', action: 'size_cap', condition: { dow: 2, size_cap_pct: 0.2 } }),
      ],
      true,
    );
    const v = applyEngineRules(ctx);
    expect(v.matched).toHaveLength(2);
    expect(v.sizeCapPct).toBe(0.2);
    // size_cap does not change engine output — the engine does not size. It is
    // recorded and tagged; the bot is the sizer.
    expect(v.suppress).toBe(false);
    expect(v.downgrade).toBe(false);
  });

  it('a condition of ONLY action params never matches (no predicate = everything)', () => {
    __setRulesForTest([rule({ action: 'size_cap', condition: { size_cap_pct: 0.2 } })], true);
    expect(applyEngineRules(ctx).matched).toHaveLength(0);
  });

  it('a rule can only narrow: it never produces create/upsize', () => {
    __setRulesForTest([rule({ action: 'suppress' })], true);
    const v = applyEngineRules(ctx);
    expect(Object.keys(v)).not.toContain('upgrade');
    expect(v.suppress || v.downgrade).toBe(true);
  });
});

// 'direction' predicate (2026-08-29) — side-specific price-band rules.
// The oil YES 20-39c bucket bled while NO 20-39c profited; a band rule without
// a side key would suppress both. Safety property under test: a ctx with no
// direction NEVER matches a direction-keyed rule (fails toward publishing).
describe('direction predicate', () => {
  const dctx = { ...ctx, direction: 'BUY YES' };

  it('matches the publish direction case-insensitively', () => {
    expect(conditionMatches({ direction: 'BUY YES' }, dctx)).toBe(true);
    expect(conditionMatches({ direction: 'buy yes' }, dctx)).toBe(true);
    expect(conditionMatches({ direction: 'BUY NO' }, dctx)).toBe(false);
  });

  it('conjoins with a price band — the oil rule shape', () => {
    const cond = { direction: 'BUY YES', implied_prob_min: 0.2, implied_prob_max: 0.39 };
    expect(conditionMatches(cond, { ...dctx, impliedProb: 0.3 })).toBe(true);
    expect(conditionMatches(cond, { ...dctx, impliedProb: 0.3, direction: 'BUY NO' })).toBe(false);
    expect(conditionMatches(cond, { ...dctx, impliedProb: 0.5 })).toBe(false);
  });

  it('never matches when ctx has no direction (fail toward publishing)', () => {
    expect(conditionMatches({ direction: 'BUY YES' }, ctx)).toBe(false);
  });

  it('applies end to end through applyEngineRules', () => {
    __setRulesForTest([
      rule({ scope: 'oil-edge', condition: { direction: 'BUY YES', implied_prob_min: 0.2, implied_prob_max: 0.39 } }),
    ]);
    const oil = { commodity: 'oil', dow: 2, hourUtc: 15, impliedProb: 0.3, direction: 'BUY YES' };
    expect(applyEngineRules(oil).suppress).toBe(true);
    expect(applyEngineRules({ ...oil, direction: 'BUY NO' }).suppress).toBe(false);
    __setRulesForTest([], false);
  });
});

// Loop v2 (EDGE_LOOP_V2_2026-11-09 §2 / U4a): the new condition keys, pot_key, the ET
// clock, and the promote / unsuppress / alert actions. Same safety posture: every new key
// fails toward publishing when the ctx lacks the value; a suppress always beats a promote.
import { ruleContext, parsePotKey, etClock } from '../src/engine/engine-rules.js';

describe('Loop v2 — ruleContext + ET clock', () => {
  it('converts the snapshot instant to America/New_York (EST on 11-09: 17:30Z = 12 ET, Mon)', () => {
    const c = ruleContext({ commodity: 'bitcoin', now: new Date('2026-11-09T17:30:00Z'), direction: 'BUY YES', kalshiYes: 0.52, chosenEdge: 0.083, fusedTier: 'MODERATE' });
    expect([c.hourEt, c.dowEt, c.hourUtc]).toEqual([12, 'Mon', 17]);
    expect(c.impliedProb).toBe(0.52);
    expect(c.edgePp).toBeCloseTo(8.3);
    expect(c.tier).toBe(2);
    // EDT (10-09 17:30Z = 13 ET)
    expect(etClock(new Date('2026-10-09T17:30:00Z')).hourEt).toBe(13);
  });
  it('implied_prob is the SIDE cost: a NO at YES 0.30 costs 0.70; PASS rows read the YES price', () => {
    expect(ruleContext({ commodity: 'oil', now: new Date(), direction: 'BUY NO', kalshiYes: 0.3, chosenEdge: -0.1, fusedTier: 'MODERATE' }).impliedProb).toBe(0.7);
    expect(ruleContext({ commodity: 'oil', now: new Date(), direction: 'PASS', kalshiYes: 0.3, chosenEdge: 0.02, fusedTier: 'NO_EDGE' }).impliedProb).toBe(0.3);
    expect(ruleContext({ commodity: 'oil', now: new Date(), direction: 'PASS', kalshiYes: null, chosenEdge: null, fusedTier: 'NO_EDGE' }).impliedProb).toBeNull();
  });
});

describe('Loop v2 — condition keys', () => {
  const v2 = { commodity: 'bitcoin', dow: 1, hourUtc: 17, hourEt: 12, dowEt: 'Mon', impliedProb: 0.52, edgePp: 8.3, tier: 2, direction: 'BUY YES' };
  it('edge band, tier list, ET hour list, ET dow list', () => {
    expect(conditionMatches({ edge_pp_min: 7, edge_pp_max: 9 }, v2)).toBe(true);
    expect(conditionMatches({ edge_pp_min: 9 }, v2)).toBe(false);
    expect(conditionMatches({ tier_in: [1, 2] }, v2)).toBe(true);
    expect(conditionMatches({ tier_in: [3] }, v2)).toBe(false);
    expect(conditionMatches({ hour_et_in: [12] }, v2)).toBe(true);
    expect(conditionMatches({ hour_et_in: ['12'] }, v2)).toBe(true);
    expect(conditionMatches({ hour_et_in: [11] }, v2)).toBe(false);
    expect(conditionMatches({ dow_in: ['Fri'] }, v2)).toBe(false);
    expect(conditionMatches({ dow_in: ['mon'] }, v2)).toBe(true);
  });
  it('fails toward publishing when the ctx lacks the value', () => {
    expect(conditionMatches({ edge_pp_min: 7 }, { ...v2, edgePp: null })).toBe(false);
    expect(conditionMatches({ hour_et_in: [12] }, { ...v2, hourEt: undefined })).toBe(false);
    expect(conditionMatches({ tier_in: 2 }, v2)).toBe(false); // not a list
  });
  it('pot_key: a label always matches; a dim=value is a predicate; an unknown dim never matches', () => {
    expect(parsePotKey('bitcoin-edge|hour=11')).toEqual({ scope: 'bitcoin-edge', dim: 'hour', value: '11' });
    expect(parsePotKey('metals|reopen')).toEqual({ scope: 'metals', label: 'reopen' });
    expect(conditionMatches({ pot_key: 'bitcoin-edge|hour=12' }, v2)).toBe(true);
    expect(conditionMatches({ pot_key: 'bitcoin-edge|hour=11' }, v2)).toBe(false);
    expect(conditionMatches({ pot_key: 'bitcoin-edge|edge=7-9' }, v2)).toBe(true);
    expect(conditionMatches({ pot_key: 'bitcoin-edge|edge=12+' }, v2)).toBe(false);
    expect(conditionMatches({ pot_key: 'bitcoin-edge|entry=35-50' }, { ...v2, impliedProb: 0.42 })).toBe(true);
    expect(conditionMatches({ pot_key: 'bitcoin-edge|side=BUY YES' }, v2)).toBe(true);
    expect(conditionMatches({ pot_key: 'bitcoin-edge|dow=Mon' }, v2)).toBe(true);
    expect(conditionMatches({ pot_key: 'metals|reopen', edge_pp_min: 7 }, v2)).toBe(true);
    expect(conditionMatches({ pot_key: 'metals|reopen' }, v2)).toBe(false); // a bare label is not a predicate
    expect(conditionMatches({ pot_key: 'bitcoin-edge|regime=x' }, v2)).toBe(false);
  });
});

describe('Loop v2 — S1 synthetic end to end', () => {
  const S1 = rule({ id: 'ccccccc1-0000-4000-8000-000000000001', scope: 'bitcoin-edge', action: 'suppress', condition: { hour_et_in: [12] } });
  const pick = (iso) => ruleContext({ commodity: 'bitcoin', now: new Date(iso), direction: 'BUY YES', kalshiYes: 0.55, chosenEdge: 0.09, fusedTier: 'MODERATE' });
  it('suppresses a noon-ET pick and tags the rule id', () => {
    __setRulesForTest([S1], true);
    const v = applyEngineRules(pick('2026-11-09T17:30:00Z'));
    expect(v.suppress).toBe(true);
    expect(v.ruleIds).toEqual(['ccccccc1-0000-4000-8000-000000000001']);
    expect(v.note).toContain('rule:suppress ccccccc1');
  });
  it('a non-matching hour passes untouched', () => {
    __setRulesForTest([S1], true);
    const v = applyEngineRules(pick('2026-11-09T16:30:00Z')); // 11 ET
    expect(v.suppress).toBe(false);
    expect(v.matched).toHaveLength(0);
    __setRulesForTest([], false);
  });
});

describe('Loop v2 — promote / unsuppress / alert', () => {
  const v2 = { commodity: 'gold', dow: 1, hourUtc: 17, hourEt: 12, dowEt: 'Mon', impliedProb: 0.52, edgePp: 8.3, tier: 2, direction: 'BUY YES' };
  it('promote is reported; a surviving suppress always beats it', () => {
    __setRulesForTest([rule({ id: 'p1', scope: 'gold-edge', action: 'promote', condition: { edge_pp_min: 7 } })], true);
    expect(applyEngineRules(v2).promote).toBe(true);
    __setRulesForTest([
      rule({ id: 'p1', scope: 'gold-edge', action: 'promote', condition: { edge_pp_min: 7 } }),
      rule({ id: 's1', scope: 'gold-edge', action: 'suppress', condition: { hour_et_in: [12] } }),
    ], true);
    const v = applyEngineRules(v2);
    expect(v.suppress).toBe(true);
    expect(v.promote).toBe(false);
    expect(v.ruleIds.sort()).toEqual(['p1', 's1']);
  });
  it('unsuppress cancels only the rule it supersedes, and is itself recorded', () => {
    __setRulesForTest([
      rule({ id: 's1', scope: 'gold-edge', action: 'suppress', condition: { hour_et_in: [12] } }),
      rule({ id: 'u1', scope: 'gold-edge', action: 'unsuppress', condition: { hour_et_in: [12], supersedes: 's1' } }),
    ], true);
    const v = applyEngineRules(v2);
    expect(v.suppress).toBe(false);
    expect(v.ruleIds.sort()).toEqual(['s1', 'u1']);
    // a different suppress still stands
    __setRulesForTest([
      rule({ id: 's2', scope: 'gold-edge', action: 'suppress', condition: { tier_in: [2] } }),
      rule({ id: 'u1', scope: 'gold-edge', action: 'unsuppress', condition: { hour_et_in: [12], supersedes: 's1' } }),
    ], true);
    expect(applyEngineRules(v2).suppress).toBe(true);
  });
  it('alert names the hot pot (pot_key column, else condition.pot_key, else the id)', () => {
    __setRulesForTest([rule({ id: 'a1', scope: 'gold-edge', action: 'alert', condition: { pot_key: 'gold-edge|hour=12' } })], true);
    let v = applyEngineRules(v2);
    expect([v.alert, v.hotPot, v.suppress]).toEqual([true, 'gold-edge|hour=12', false]);
    __setRulesForTest([rule({ id: 'a2', scope: 'gold-edge', action: 'alert', condition: { edge_pp_min: 7, edge_pp_max: 9 }, pot_key: 'gold-edge|edge=7-9' })], true);
    v = applyEngineRules(v2);
    expect(v.hotPot).toBe('gold-edge|edge=7-9');
    expect(v.note).toContain('rule:alert');
  });
  it('size_rung / retire_lane rows are known (no warning) but never act on an engine row', () => {
    __setRulesForTest([rule({ id: 'r1', scope: 'all', action: 'size_rung', condition: { rung: 1 } })], true);
    const v = applyEngineRules(v2);
    expect(v.matched).toHaveLength(0); // params only — no predicate — never matches
    expect(v.suppress || v.promote || v.alert).toBe(false);
    __setRulesForTest([], false);
  });
});
