// Entry-cost floor (2026-10-02) — a sub-40c BUY is demoted to a non-play WATCH
// and stamped entry_floor with the ORIGINAL direction/tiers for the shadow ledger.
import { describe, it, expect } from 'vitest';
import { applyEntryFloor } from '../src/engine/commodity-base.js';
import { ENTRY_COST_FLOOR } from '../src/engine/thresholds.js';

describe('applyEntryFloor', () => {
  it('floor is 40c (same number as the mint migration and the site readers)', () => {
    expect(ENTRY_COST_FLOOR).toBe(0.4);
  });
  it('demotes a 15c YES and keeps the original side + tiers', () => {
    const [r] = applyEntryFloor([{ direction: 'BUY YES', kalshi_yes: 0.15, confidence: 'high', fused_confidence: 'STRONG' }]);
    expect([r.direction, r.confidence, r.fused_confidence]).toEqual(['PASS', 'watch', 'NO_EDGE']);
    expect(r.entry_floor).toEqual({ cost: 0.15, direction: 'BUY YES', confidence: 'high', fused_confidence: 'STRONG' });
  });
  it('prices a NO at 1 - YES', () => {
    const [keep, drop] = applyEntryFloor([
      { direction: 'BUY NO', kalshi_yes: 0.3, confidence: 'medium' },
      { direction: 'BUY NO', kalshi_yes: 0.62, confidence: 'high' },
    ]);
    expect(keep.direction).toBe('BUY NO');
    expect(keep.entry_floor).toBeUndefined();
    expect(drop.direction).toBe('PASS');
    expect(drop.entry_floor.cost).toBe(0.38);
  });
  // EDGE_TOOLS_DEEP_DIVE_2026-11-09 U1: the floor is per row and commodity-agnostic, so oil
  // obeys it exactly as gold does. An oil side costing 30c is demoted; 70c stays a play; the
  // same rows for gold are byte-identical (each tool is its own island — no oil-only rule).
  it('oil: 30c side demoted, 70c side kept; gold rows identical', () => {
    const mk = (commodity, yes) => ({
      commodity, direction: 'BUY YES', kalshi_yes: yes, confidence: 'medium', fused_confidence: 'MODERATE', rationale: 'x',
    });
    const [oil30, oil70, gold30, gold70] = applyEntryFloor([mk('oil', 0.30), mk('oil', 0.70), mk('gold', 0.30), mk('gold', 0.70)]);
    expect([oil30.direction, oil30.pass_reason, oil30.entry_floor.cost]).toEqual(['PASS', 'entry_floor', 0.3]);
    expect(oil70).toEqual(mk('oil', 0.70));
    expect({ ...gold30, commodity: 'oil' }).toEqual(oil30);
    expect({ ...gold70, commodity: 'oil' }).toEqual(oil70);
    // A NO side is priced at 1 - YES: oil NO at yes 0.30 costs 70c and is a play.
    const [oilNo] = applyEntryFloor([{ ...mk('oil', 0.30), direction: 'BUY NO' }]);
    expect(oilNo.direction).toBe('BUY NO');
    expect(oilNo.entry_floor).toBeUndefined();
  });
  it('exactly 40c is a play; PASS rows are untouched', () => {
    const [atFloor, pass] = applyEntryFloor([
      { direction: 'BUY YES', kalshi_yes: 0.4, confidence: 'high' },
      { direction: 'PASS', kalshi_yes: 0.05, confidence: 'skip' },
    ]);
    expect(atFloor.direction).toBe('BUY YES');
    expect(pass).toEqual({ direction: 'PASS', kalshi_yes: 0.05, confidence: 'skip' });
  });
});
