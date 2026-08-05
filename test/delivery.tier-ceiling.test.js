// V2.1 stopgap alert-tier ceiling.
// handoffs/BITCOIN_EDGE_V21_CALIBRATED_RELAUNCH_2026-08-05.md §2.4.

import { describe, it, expect } from 'vitest';
import { applyCalibrationTierCeiling } from '../src/delivery/tier-ceiling.js';

describe('applyCalibrationTierCeiling', () => {
  it('caps uncalibrated bitcoin STRONG down to MODERATE', () => {
    expect(applyCalibrationTierCeiling('bitcoin', 'STRONG', {})).toBe('MODERATE');
    expect(applyCalibrationTierCeiling('bitcoin', 'STRONG', { calibrated_prob: null })).toBe(
      'MODERATE',
    );
    expect(applyCalibrationTierCeiling('BITCOIN', 'STRONG', undefined)).toBe('MODERATE');
  });

  it('leaves non-STRONG bitcoin tiers alone (it is a ceiling, not a demotion)', () => {
    for (const t of ['MODERATE', 'SPECULATIVE', 'NO_EDGE']) {
      expect(applyCalibrationTierCeiling('bitcoin', t, {})).toBe(t);
    }
  });

  it('never touches silver/gold/oil — different model, not implicated', () => {
    for (const c of ['silver', 'gold', 'oil']) {
      expect(applyCalibrationTierCeiling(c, 'STRONG', {})).toBe('STRONG');
    }
  });

  it('self-retires once an INTERIOR calibrated_prob is present (PR C)', () => {
    expect(applyCalibrationTierCeiling('bitcoin', 'STRONG', { calibrated_prob: 0.62 })).toBe(
      'STRONG',
    );
  });

  it('degenerate calibrated_prob does NOT lift the ceiling', () => {
    // 0, 1, NaN and non-numeric are absent-or-broken calibration, not a
    // result. Treating them as calibrated would re-open the exact hole this
    // ceiling exists to close.
    for (const p of [0, 1, NaN, 'abc', {}, Infinity, -0.2, 1.4]) {
      expect(applyCalibrationTierCeiling('bitcoin', 'STRONG', { calibrated_prob: p })).toBe(
        'MODERATE',
      );
    }
  });
});
