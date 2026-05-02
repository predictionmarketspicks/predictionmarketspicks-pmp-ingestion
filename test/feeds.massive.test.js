// Delta filter tests — `0.15 ≤ |Δ| ≤ 0.85` per plan §10, with passthrough on
// missing delta so the bridge-week 15-min-delayed Massive tier (greeks: {} on
// weekends and off-hours) still produces a chain. The passthrough flips off
// implicitly after Mon/Tue real-time cutover when greeks populate live.

import { describe, it, expect } from 'vitest';
import { passesDeltaFilter } from '../src/feeds/massive.js';

describe('passesDeltaFilter', () => {
  it('keeps contracts with |delta| in [0.15, 0.85]', () => {
    expect(passesDeltaFilter({ delta: 0.5 })).toBe(true);
    expect(passesDeltaFilter({ delta: -0.5 })).toBe(true);
    expect(passesDeltaFilter({ delta: 0.15 })).toBe(true);
    expect(passesDeltaFilter({ delta: 0.85 })).toBe(true);
  });

  it('drops contracts with |delta| < 0.15 (deep OTM)', () => {
    expect(passesDeltaFilter({ delta: 0.05 })).toBe(false);
    expect(passesDeltaFilter({ delta: -0.10 })).toBe(false);
  });

  it('drops contracts with |delta| > 0.85 (deep ITM)', () => {
    expect(passesDeltaFilter({ delta: 0.95 })).toBe(false);
    expect(passesDeltaFilter({ delta: -0.92 })).toBe(false);
  });

  it('passes through contracts with null delta (bridge-week off-hours)', () => {
    // The 15-min delayed Massive tier returns greeks: {} on weekends and
    // outside US options market hours. Filter must not zero out the chain.
    expect(passesDeltaFilter({ delta: null })).toBe(true);
    expect(passesDeltaFilter({ delta: undefined })).toBe(true);
  });
});
