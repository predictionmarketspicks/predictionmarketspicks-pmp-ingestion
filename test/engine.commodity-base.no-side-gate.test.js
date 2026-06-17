// Post-spread, side-aware BUY gate (BITCOIN_EDGE_NO_SIDE_FIX_2026-06-16).
//
// Locks the fix that killed the BUY-NO bleed: the engine no longer flips to
// BUY NO on the edge sign alone. Each side is charged its actual ask-side spread
// off the live Kalshi book, and the NO side is held to a stricter net floor
// (10pp) until the IBIT-chain -> BTC TWAP prob is recalibrated.
//
//   YES net edge = chosenProb - yesAsk
//   NO  net edge = yesBid   - chosenProb   (NO ask = 1 - yesBid)

import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/engine/commodity-base.js';

const { postSpreadSideGate } = __test__;

// Bitcoin's live thresholds (commodities.bitcoin).
const YES = 0.05;
const NO = 0.1;

function gate(args) {
  return postSpreadSideGate({ minEdgeYes: YES, minEdgeNo: NO, ...args });
}

describe('postSpreadSideGate — NO side held to the post-spread floor', () => {
  it('criterion 3: optProb < kalshiProb by 3-5pp but post-spread NO edge < 10pp -> PASS, not BUY NO', () => {
    // The bleed cluster: model says 34.3%, market YES bid sits at 40c, so the
    // gross edge is -5.7pp (YES overpriced -> the old gate emitted BUY NO).
    // Post-spread NO edge = yesBid - chosenProb = 0.40 - 0.343 = 5.7pp < 10pp.
    const g = gate({ chosenProb: 0.343, yesBid: 0.4, yesAsk: 0.42 });
    expect(g.pass).toBe(false);
    expect(g.dirYes).toBeNull();
    // Sign-only legacy gate would have flipped to NO here (gross edge < 0).
    expect(0.343 - 0.41).toBeLessThan(0); // sanity: this IS a negative-gross-edge strike
  });

  it('criterion 4: a genuine >= 10pp post-spread NO dislocation still emits BUY NO', () => {
    // Model 25%, market YES bid 40c -> post-spread NO edge = 0.40 - 0.25 = 15pp.
    const g = gate({ chosenProb: 0.25, yesBid: 0.4, yesAsk: 0.42 });
    expect(g.pass).toBe(true);
    expect(g.dirYes).toBe(false); // BUY NO
    expect(g.netEdge).toBeCloseTo(0.15, 6);
  });

  it('exactly 10pp post-spread NO edge clears the floor (>=)', () => {
    const g = gate({ chosenProb: 0.3, yesBid: 0.4, yesAsk: 0.45 });
    expect(g.pass).toBe(true);
    expect(g.dirYes).toBe(false);
    expect(g.netEdge).toBeCloseTo(0.1, 6);
  });

  it('9.9pp post-spread NO edge is just under the floor -> PASS', () => {
    const g = gate({ chosenProb: 0.301, yesBid: 0.4, yesAsk: 0.45 });
    expect(g.pass).toBe(false);
  });
});

describe('postSpreadSideGate — YES side keeps the 5pp post-spread floor', () => {
  it('YES clears its ask-side spread by >= 5pp -> BUY YES', () => {
    // Model 60%, YES ask 50c -> YES net edge = 0.60 - 0.50 = 10pp.
    const g = gate({ chosenProb: 0.6, yesBid: 0.48, yesAsk: 0.5 });
    expect(g.pass).toBe(true);
    expect(g.dirYes).toBe(true);
    expect(g.netEdge).toBeCloseTo(0.1, 6);
  });

  it('YES gross edge eaten by the ask spread (net < 5pp) -> PASS', () => {
    // Model 52%, but the YES ask is 51c -> only 1pp left after the spread, and
    // the NO side is negative. Neither clears -> not actionable.
    const g = gate({ chosenProb: 0.52, yesBid: 0.49, yesAsk: 0.51 });
    expect(g.pass).toBe(false);
  });

  it('YES is preferred when both sides somehow qualify', () => {
    // Contrived wide-but-rich book where both nets clear; YES wins.
    const g = gate({ chosenProb: 0.5, yesBid: 0.62, yesAsk: 0.44 });
    expect(g.pass).toBe(true);
    expect(g.dirYes).toBe(true);
  });
});

describe('postSpreadSideGate — kill switch + missing book', () => {
  it('noSideEnabled=false suppresses an otherwise-valid BUY NO', () => {
    const g = gate({ chosenProb: 0.25, yesBid: 0.4, yesAsk: 0.42, noSideEnabled: false });
    expect(g.pass).toBe(false);
    // ...but the same dislocation on the YES side is unaffected by the NO switch.
    const yes = gate({ chosenProb: 0.6, yesBid: 0.48, yesAsk: 0.5, noSideEnabled: false });
    expect(yes.pass).toBe(true);
    expect(yes.dirYes).toBe(true);
  });

  it('one-sided / missing book never emits a BUY (no ghost-quote leans)', () => {
    expect(gate({ chosenProb: 0.25, yesBid: null, yesAsk: 0.42 }).pass).toBe(false); // can't price NO
    expect(gate({ chosenProb: 0.6, yesBid: 0.48, yesAsk: null }).pass).toBe(false); // can't price YES
    expect(gate({ chosenProb: null, yesBid: 0.4, yesAsk: 0.42 }).pass).toBe(false); // no model prob
  });
});
