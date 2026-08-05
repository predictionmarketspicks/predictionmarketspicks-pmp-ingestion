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
