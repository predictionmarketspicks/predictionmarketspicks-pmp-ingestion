// Calibration map math + governance semantics.
// handoffs/BITCOIN_EDGE_V21_CALIBRATED_RELAUNCH_2026-08-05.md §4

import { describe, it, expect, beforeEach } from 'vitest';
import {
  logit,
  sigmoid,
  applyCalibration,
  getCalibrationMap,
  isCalibrationActive,
  __setMapsForTest,
} from '../src/engine/calibration.js';

const IDENTITY = { id: 1, commodity: 'bitcoin', method: 'platt_pooled', knots: { a: 1, b: 0 } };

describe('logit / sigmoid', () => {
  it('round-trips', () => {
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      expect(sigmoid(logit(p))).toBeCloseTo(p, 10);
    }
  });

  it('clamps rather than returning +/-Infinity at the boundaries', () => {
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(1))).toBe(true);
  });

  it('does not overflow on large magnitudes', () => {
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(sigmoid(-800)).toBeGreaterThanOrEqual(0);
  });
});

describe('applyCalibration', () => {
  it('identity map is a no-op within clipping', () => {
    expect(applyCalibration(IDENTITY, 0.62)).toBeCloseTo(0.62, 6);
  });

  it('shrinks an overconfident prob toward the base rate when a < 1', () => {
    // This is the era-C shape: model says 0.79, calibration pulls it down.
    const map = { ...IDENTITY, knots: { a: 0.4, b: -0.2 } };
    const out = applyCalibration(map, 0.794);
    expect(out).toBeLessThan(0.794);
    expect(out).toBeGreaterThan(0.5);
  });

  it('returns null (no opinion) for a missing map', () => {
    expect(applyCalibration(null, 0.6)).toBeNull();
    expect(applyCalibration(undefined, 0.6)).toBeNull();
  });

  it('returns null for an UNKNOWN method rather than passing the input through', () => {
    // Passing through would mark an uncalibrated number as calibrated and lift
    // the alert ceiling on it.
    expect(applyCalibration({ ...IDENTITY, method: 'isotonic' }, 0.6)).toBeNull();
    expect(applyCalibration({ ...IDENTITY, method: null }, 0.6)).toBeNull();
  });

  it('returns null for non-interior or non-finite inputs', () => {
    for (const p of [0, 1, -0.1, 1.2, NaN, null, undefined, 'x']) {
      expect(applyCalibration(IDENTITY, p)).toBeNull();
    }
  });

  it('returns null for malformed knots', () => {
    for (const knots of [null, {}, { a: 1 }, { a: 'x', b: 0 }, { a: NaN, b: 0 }]) {
      expect(applyCalibration({ ...IDENTITY, knots }, 0.6)).toBeNull();
    }
  });

  it('output is always strictly interior, so downstream interiority checks hold', () => {
    const extreme = { ...IDENTITY, knots: { a: 50, b: 0 } };
    const hi = applyCalibration(extreme, 0.999);
    const lo = applyCalibration(extreme, 0.001);
    expect(hi).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThan(1);
  });
});

describe('map governance', () => {
  beforeEach(() => __setMapsForTest([]));

  it('no map => not active, no calibration', () => {
    expect(getCalibrationMap('bitcoin')).toBeNull();
    expect(isCalibrationActive('bitcoin')).toBe(false);
  });

  it('a SHADOW map does not govern', () => {
    __setMapsForTest([['bitcoin', { ...IDENTITY, active: false, shadow: true }]]);
    expect(getCalibrationMap('bitcoin')).not.toBeNull();
    // The map exists (so calibrated_prob gets stored and observed) but must not
    // claim to own the decision.
    expect(isCalibrationActive('bitcoin')).toBe(false);
  });

  it('an ACTIVE map governs', () => {
    __setMapsForTest([['bitcoin', { ...IDENTITY, active: true, shadow: false }]]);
    expect(isCalibrationActive('bitcoin')).toBe(true);
  });

  it('metals are unaffected by a bitcoin map', () => {
    __setMapsForTest([['bitcoin', { ...IDENTITY, active: true }]]);
    for (const c of ['silver', 'gold', 'oil']) {
      expect(getCalibrationMap(c)).toBeNull();
      expect(isCalibrationActive(c)).toBe(false);
    }
  });
});
