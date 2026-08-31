// EDGE_MARKETS §1.4 — a tier must mean money, not a gross gap.
//
// The spread was already charged by postSpreadSideGate. This pins the other
// real cost: the Kalshi taker fee, ceil(0.07·p·(1−p)·100) cents per contract.
// Why it changes outcomes rather than decorating them — the fee PEAKS at 50c
// and vanishes at the wings, so it bites hardest in the mid-band that produces
// this tool's entire realised profit. Oil showed a 46.7% win rate for a +1.4%
// return; a tier computed on gross was never a claim about money.
import { describe, it, expect } from 'vitest';
import { postSpreadSideGate, feeFraction } from '../src/engine/commodity-base.js';
import { COMMODITIES } from '../src/engine/commodities.js';

describe('§1.4 fee model', () => {
  it('matches the canonical schedule: ceil(0.07·p·(1−p)·100) cents', () => {
    expect(feeFraction(0.5)).toBeCloseTo(0.02, 10);   // ceil(1.75) = 2c
    expect(feeFraction(0.1)).toBeCloseTo(0.01, 10);   // ceil(0.63) = 1c
    expect(feeFraction(0.99)).toBeCloseTo(0.01, 10);  // ceil(0.069) = 1c
  });

  it('is symmetric, so the NO contract needs no separate branch', () => {
    for (const p of [0.05, 0.21, 0.37, 0.5]) {
      expect(feeFraction(p)).toBe(feeFraction(1 - p));
    }
  });

  it('degrades to zero on junk rather than inventing a cost', () => {
    for (const bad of [null, undefined, NaN, Infinity]) expect(feeFraction(bad)).toBe(0);
  });
});

describe('§1.4 the fee decides real rows', () => {
  const book = { yesBid: 0.48, yesAsk: 0.50, minEdgeYes: 0.05, minEdgeNo: 0.10 };

  it('a 6pp gross edge nets 4pp and stops clearing the 5pp floor', () => {
    const args = { ...book, chosenProb: 0.56 };
    const grossOnly = postSpreadSideGate({ ...args, chargeFees: false });
    expect(grossOnly.pass).toBe(true);
    expect(grossOnly.netEdge).toBeCloseTo(0.06, 10);

    const withFees = postSpreadSideGate({ ...args, chargeFees: true });
    expect(withFees.yesNet).toBeCloseTo(0.04, 10);
    expect(withFees.pass).toBe(false); // 4pp < the 5pp floor — the fee decided
  });

  it('a genuinely fat edge still passes — the guard is not a blanket suppressor', () => {
    const fat = postSpreadSideGate({ ...book, chosenProb: 0.62, chargeFees: true });
    expect(fat.pass).toBe(true);
    expect(fat.dirYes).toBe(true);
    expect(fat.netEdge).toBeCloseTo(0.10, 10); // 62 − 50 − 2
  });

  it('charges the NO side at its own contract price', () => {
    // NO ask = 1 − yesBid = 0.52; fee is symmetric so it is feeFraction(0.48).
    const no = postSpreadSideGate({ ...book, chosenProb: 0.30, chargeFees: true });
    expect(no.noNet).toBeCloseTo(0.48 - 0.30 - feeFraction(0.48), 10);
    expect(no.pass).toBe(true);
    expect(no.dirYes).toBe(false);
  });

  it('is opt-in: a commodity without chargeFees is byte-identical to before', () => {
    const args = { ...book, chosenProb: 0.56 };
    const off = postSpreadSideGate({ ...args, chargeFees: false });
    const legacy = postSpreadSideGate(args); // flag omitted entirely
    expect(legacy).toEqual(off);
  });
});

describe('§1.4 rollout', () => {
  it('is on for exactly the four flagship engines', () => {
    for (const c of ['bitcoin', 'gold', 'silver', 'oil']) {
      expect(COMMODITIES[c].chargeFees).toBe(true);
      // The fee charge lives INSIDE the post-spread gate, so enabling one
      // without the other would silently do nothing.
      expect(COMMODITIES[c].postSpreadGate).toBe(true);
    }
  });
});
