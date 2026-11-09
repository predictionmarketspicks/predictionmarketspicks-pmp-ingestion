// scripts/fit-btc-calibration.js — the pure pieces behind `--commodity oil`
// (site repo handoffs/OIL_EDGE_DEEP_DIVE_2026-11-09.md §4 U4, PREP ONLY).
import { describe, it, expect } from 'vitest';
import { parseCalibArgs, yesBasisOutcome } from '../scripts/fit-btc-calibration.js';

describe('parseCalibArgs', () => {
  it('defaults are the bitcoin invocation, byte for byte', () => {
    expect(parseCalibArgs(['node', 'x'])).toEqual({
      commodity: 'bitcoin', toolSlug: 'bitcoin-edge', modelVersion: 'v2_physical', since: null, dryRun: false,
    });
  });
  it('oil with an era floor and a dry run', () => {
    expect(parseCalibArgs(['node', 'x', '--commodity', 'oil', '--since', '2026-11-24', '--dry-run'])).toEqual({
      commodity: 'oil', toolSlug: 'oil-edge', modelVersion: 'v2_physical', since: '2026-11-24', dryRun: true,
    });
  });
  it('--model-version and --tool-slug override; a malformed --since is an error, not a silent full-history fit', () => {
    expect(parseCalibArgs(['node', 'x', '--commodity', 'oil', '--model-version', 'v2_physical_clock', '--tool-slug', 'oil-edge-x']))
      .toMatchObject({ modelVersion: 'v2_physical_clock', toolSlug: 'oil-edge-x' });
    expect(parseCalibArgs(['node', 'x', '--since', '11/24/2026']).error).toMatch(/YYYY-MM-DD/);
  });
});

describe('yesBasisOutcome — both sides on the YES basis', () => {
  const settled = (res) => ({ tool_settles: { resolution: res } });
  it('a YES pick: won → 1, lost → 0; p and m pass through', () => {
    expect(yesBasisOutcome({ predicted_side: 'YES', predicted_prob: '0.8242', market_price_at_pick: '0.675', ...settled('won') }))
      .toEqual({ p: 0.8242, m: 0.675, y: 1 });
    expect(yesBasisOutcome({ predicted_side: 'YES', predicted_prob: 0.5058, market_price_at_pick: 0.42, ...settled('lost') }))
      .toEqual({ p: 0.5058, m: 0.42, y: 0 });
  });
  it('a NO pick is NOT inverted on p/m (the mint already stores P(YES)); only the outcome flips', () => {
    // oil-edge 41e43cc6 (2026-11-09): NO, predicted_prob 0.0498 (P(YES)), market 0.195, entry 0.805.
    const row = { predicted_side: 'NO', predicted_prob: '0.0498', market_price_at_pick: '0.1950' };
    expect(yesBasisOutcome({ ...row, ...settled('won') })).toEqual({ p: 0.0498, m: 0.195, y: 0 });
    expect(yesBasisOutcome({ ...row, ...settled('lost') })).toEqual({ p: 0.0498, m: 0.195, y: 1 });
  });
  it('rejects unsettled, voided, degenerate-prob and side-less rows', () => {
    expect(yesBasisOutcome({ predicted_side: 'YES', predicted_prob: 0.5, market_price_at_pick: 0.5, tool_settles: { resolution: 'void' } })).toBeNull();
    expect(yesBasisOutcome({ predicted_side: 'YES', predicted_prob: 0.5, market_price_at_pick: 0.5 })).toBeNull();
    expect(yesBasisOutcome({ predicted_side: 'YES', predicted_prob: 1, market_price_at_pick: 0.5, ...settled('won') })).toBeNull();
    expect(yesBasisOutcome({ predicted_side: 'YES', predicted_prob: 0, market_price_at_pick: 0.5, ...settled('won') })).toBeNull();
    expect(yesBasisOutcome({ predicted_side: 'MAYBE', predicted_prob: 0.5, market_price_at_pick: 0.5, ...settled('won') })).toBeNull();
    expect(yesBasisOutcome({ predicted_side: 'YES', predicted_prob: 0.5, market_price_at_pick: 'n/a', ...settled('won') })).toBeNull();
  });
  it('reads the array form of the embedded settle too', () => {
    expect(yesBasisOutcome({ predicted_side: 'NO', predicted_prob: 0.3, market_price_at_pick: 0.4, tool_settles: [{ resolution: 'won' }] }))
      .toEqual({ p: 0.3, m: 0.4, y: 0 });
  });
});
