// pass_reason — one binding cause per PASS row (site repo
// handoffs/EDGE_ALERTS_DARK_FEEDS_AND_MCP_SWEEP_2026-10-22.md P0 follow-up).
import { describe, it, expect } from 'vitest';
import { passReasonFor, PASS_REASONS, applyEntryFloor } from '../src/engine/commodity-base.js';

const base = { direction: 'PASS', qualityFlag: null, entryFloor: false, gateReason: null, edge: 0.08, noMarket: false };

describe('passReasonFor', () => {
  it('a BUY has no pass reason', () => {
    expect(passReasonFor({ ...base, direction: 'BUY YES' })).toBeNull();
    expect(passReasonFor({ ...base, direction: 'BUY NO' })).toBeNull();
  });
  it('the side gate names which side and why', () => {
    for (const g of ['yes_longshot', 'yes_net_below_floor', 'no_net_below_floor', 'no_side_disabled']) {
      expect(passReasonFor({ ...base, gateReason: g })).toBe(g);
    }
  });
  it('a gross edge under 5pp, or none at all', () => {
    expect(passReasonFor({ ...base, edge: 0.03 })).toBe('edge_under_5pp');
    expect(passReasonFor({ ...base, edge: -0.049 })).toBe('edge_under_5pp');
    expect(passReasonFor({ ...base, edge: null })).toBe('edge_under_5pp');
  });
  it('quality flags outrank the gates; edge_implausible is its own code', () => {
    expect(passReasonFor({ ...base, qualityFlag: 'edge_implausible', gateReason: 'no_net_below_floor' })).toBe('implausible_ceiling');
    expect(passReasonFor({ ...base, qualityFlag: 'kalshi_no_book', edge: null })).toBe('hard_suppress');
    expect(passReasonFor({ ...base, qualityFlag: 'twap_settle_window' })).toBe('hard_suppress');
    expect(passReasonFor({ ...base, noMarket: true })).toBe('hard_suppress');
  });
  it('a ≥5pp row no gate stopped was collapsed downstream', () => {
    expect(passReasonFor(base)).toBe('fused_no_edge');
  });
  it('every code it can return is in PASS_REASONS (the nine)', () => {
    expect(PASS_REASONS).toHaveLength(9);
    for (const r of ['edge_under_5pp', 'fused_no_edge', 'hard_suppress', 'implausible_ceiling', 'entry_floor', 'yes_longshot']) {
      expect(PASS_REASONS).toContain(r);
    }
  });
});

describe('applyEntryFloor stamps pass_reason', () => {
  it('a sub-floor BUY becomes entry_floor; a BUY above it keeps a null reason', () => {
    const [cheap, ok] = applyEntryFloor([
      { direction: 'BUY YES', kalshi_yes: 0.2, pass_reason: null },
      { direction: 'BUY YES', kalshi_yes: 0.5, pass_reason: null },
    ]);
    expect(cheap.pass_reason).toBe('entry_floor');
    expect(ok.pass_reason).toBeNull();
  });
});
