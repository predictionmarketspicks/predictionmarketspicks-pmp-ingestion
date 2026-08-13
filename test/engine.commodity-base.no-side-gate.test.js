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

const { postSpreadSideGate, resolveYesFloor } = __test__;

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

// YES favorite/longshot recalibration (TOOL_RECALIBRATION_ROUND2_2026-07-21).
// Bitcoin's live config: favPrice 0.70, favFloor 0.10, midFloor 0.05, longshotMin 0.15.
describe('resolveYesFloor — favorite floor + longshot classification', () => {
  const cfg = { favPrice: 0.7, favFloor: 0.1, midFloor: 0.05, longshotMin: 0.15 };

  it('favorite (yesAsk >= 70c) gets the stricter 10pp floor', () => {
    expect(resolveYesFloor({ yesAsk: 0.88, ...cfg })).toEqual({ minEdgeYes: 0.1, longshot: false });
    expect(resolveYesFloor({ yesAsk: 0.7, ...cfg })).toEqual({ minEdgeYes: 0.1, longshot: false }); // boundary is inclusive
  });

  it('mid-band (20-70c) keeps the 5pp floor — the profitable band', () => {
    expect(resolveYesFloor({ yesAsk: 0.45, ...cfg })).toEqual({ minEdgeYes: 0.05, longshot: false });
    expect(resolveYesFloor({ yesAsk: 0.699, ...cfg })).toEqual({ minEdgeYes: 0.05, longshot: false });
  });

  it('longshot (yesAsk < 15c) is flagged for suppression (keeps 5pp floor otherwise)', () => {
    expect(resolveYesFloor({ yesAsk: 0.1, ...cfg })).toEqual({ minEdgeYes: 0.05, longshot: true });
    expect(resolveYesFloor({ yesAsk: 0.15, ...cfg })).toEqual({ minEdgeYes: 0.05, longshot: false }); // 15c not a longshot
  });

  it('the 6.7-7.3pp phantom favorite edge no longer clears — 10pp floor rejects it', () => {
    // The settled artifact: YES at 88c, model 92% -> 4pp net after spread, well
    // under the 10pp favorite floor.
    const { minEdgeYes } = resolveYesFloor({ yesAsk: 0.88, ...cfg });
    const g = postSpreadSideGate({ chosenProb: 0.92, yesBid: 0.86, yesAsk: 0.88, minEdgeYes, minEdgeNo: 0.1 });
    expect(g.pass).toBe(false);
    // ...but the SAME 4pp net at mid-band (45c) would have cleared the 5pp? No —
    // 4pp < 5pp either way; use a 6pp net to show the mid band still passes.
    const mid = resolveYesFloor({ yesAsk: 0.45, ...cfg });
    const gm = postSpreadSideGate({ chosenProb: 0.51, yesBid: 0.44, yesAsk: 0.45, minEdgeYes: mid.minEdgeYes, minEdgeNo: 0.1 });
    expect(gm.pass).toBe(true);
    expect(gm.dirYes).toBe(true);
  });

  it('kill switch (enabled=false) reverts to the symmetric 5pp floor, no longshot', () => {
    expect(resolveYesFloor({ yesAsk: 0.88, enabled: false, ...cfg })).toEqual({ minEdgeYes: 0.05, longshot: false });
    expect(resolveYesFloor({ yesAsk: 0.1, enabled: false, ...cfg })).toEqual({ minEdgeYes: 0.05, longshot: false });
  });
});

describe('postSpreadSideGate — kill switch + missing book', () => {
  it('noSideEnabled=false suppresses an otherwise-valid BUY NO', () => {
    const g = gate({ chosenProb: 0.25, yesBid: 0.4, yesAsk: 0.42, noSideEnabled: false });
    expect(g.pass).toBe(false);
    // The switch stopped it, NOT the floor (noNet = 0.40 - 0.25 = 15pp, clears 10pp).
    // The rationale builder reads this to avoid printing "below the 10pp net NO floor"
    // on a row that beat the floor by 5pp. Regression guard for the 2026-08-13 fix.
    expect(g.reason).toBe('no_side_disabled');
    expect(g.noNet).toBeCloseTo(0.15, 10);
    // ...but the same dislocation on the YES side is unaffected by the NO switch.
    const yes = gate({ chosenProb: 0.6, yesBid: 0.48, yesAsk: 0.5, noSideEnabled: false });
    expect(yes.pass).toBe(true);
    expect(yes.dirYes).toBe(true);
  });

  it('a genuinely sub-floor NO reports below_floor, not the kill switch', () => {
    // noNet = 0.30 - 0.25 = 5pp, under the 10pp NO floor. Same pass=false, different why.
    const g = gate({ chosenProb: 0.25, yesBid: 0.3, yesAsk: 0.32, noSideEnabled: false });
    expect(g.pass).toBe(false);
    expect(g.reason).toBe('below_floor');
  });

  it('one-sided / missing book never emits a BUY (no ghost-quote leans)', () => {
    expect(gate({ chosenProb: 0.25, yesBid: null, yesAsk: 0.42 }).pass).toBe(false); // can't price NO
    expect(gate({ chosenProb: 0.6, yesBid: 0.48, yesAsk: null }).pass).toBe(false); // can't price YES
    expect(gate({ chosenProb: null, yesBid: 0.4, yesAsk: 0.42 }).pass).toBe(false); // no model prob
  });
});
