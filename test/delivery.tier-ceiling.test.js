// Alert-tier ceiling for uncalibrated bitcoin.
// handoffs/BITCOIN_EDGE_V21_CALIBRATED_RELAUNCH_2026-08-05.md §2.4 + §4.5.

import { describe, it, expect } from 'vitest';
import { applyCalibrationTierCeiling } from '../src/delivery/tier-ceiling.js';

const shadow = { calibrationActive: false };
const active = { calibrationActive: true };

describe('applyCalibrationTierCeiling', () => {
  it('caps uncalibrated bitcoin STRONG down to MODERATE', () => {
    expect(applyCalibrationTierCeiling('bitcoin', 'STRONG', shadow)).toBe('MODERATE');
    expect(applyCalibrationTierCeiling('BITCOIN', 'STRONG', undefined)).toBe('MODERATE');
    expect(applyCalibrationTierCeiling('bitcoin', 'STRONG', {})).toBe('MODERATE');
  });

  it('leaves non-STRONG tiers alone (it is a ceiling, not a demotion)', () => {
    for (const t of ['MODERATE', 'SPECULATIVE', 'NO_EDGE']) {
      expect(applyCalibrationTierCeiling('bitcoin', t, shadow)).toBe(t);
    }
  });

  // SUPERSEDED 2026-08-31 (EDGE_MARKETS §1.1). The old assertion — and its
  // rationale, "different model, not implicated" — was falsified in production:
  // on 2026-08-28 a gold strike 0.5% OTM at T=2h printed model 99.1% against a
  // 79¢ book and shipped STRONG through edge_alerts. Same phantom-edge shape
  // bitcoin was ceilinged for; the metals model was never immune, it was just
  // never contained. Metals and oil now sit under the same ceiling and lift it
  // the same way: their OWN calibration map must be ACTIVE.
  it('ceilings silver/gold/oil too, until their own map is active', () => {
    for (const c of ['silver', 'gold', 'oil']) {
      expect(applyCalibrationTierCeiling(c, 'STRONG', shadow)).toBe('MODERATE');
      expect(applyCalibrationTierCeiling(c, 'STRONG', active)).toBe('STRONG');
      // A ceiling, never a demotion — non-STRONG tiers pass through untouched.
      expect(applyCalibrationTierCeiling(c, 'MODERATE', shadow)).toBe('MODERATE');
    }
  });

  it('leaves un-scoped commodities alone (spx/copper were never measured)', () => {
    for (const c of ['spx', 'copper']) {
      expect(applyCalibrationTierCeiling(c, 'STRONG', shadow)).toBe('STRONG');
    }
  });

  it('lifts ONLY when a calibration map governs the decision', () => {
    expect(applyCalibrationTierCeiling('bitcoin', 'STRONG', active)).toBe('STRONG');
  });

  it('a SHADOW map must NOT lift the ceiling', () => {
    // The regression this guards: §4.5 read literally ("ceiling applies only
    // when calibrated_prob is null") would lift the ceiling as soon as the
    // shadow map starts writing the column — while direction, edge and tier
    // are still computed from the raw uncalibrated prob. STRONG alerts would
    // resume on exactly the numbers the ceiling exists to contain.
    const shadowRowWithCalibratedProb = { calibrationActive: false, calibrated_prob: 0.62 };
    expect(applyCalibrationTierCeiling('bitcoin', 'STRONG', shadowRowWithCalibratedProb)).toBe(
      'MODERATE',
    );
  });

  it('only a literal true lifts it — no truthy coercion', () => {
    for (const v of ['true', 1, {}, 'yes']) {
      expect(applyCalibrationTierCeiling('bitcoin', 'STRONG', { calibrationActive: v })).toBe(
        'MODERATE',
      );
    }
  });
});
