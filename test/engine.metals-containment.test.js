// EDGE_MARKETS §1.1 (2026-08-31) — the containment kit, replayed against the
// exact shape that shipped.
//
// On 2026-08-28 a gold weekly with ~2h to close printed model 99.1% against a
// 79¢ book — a +20pp "edge" — and published STRONG through edge_alerts. Every
// guard bitcoin carries for precisely this failure was bitcoin-only: the
// minutes-to-close tier ceiling, the post-spread side gate, and an
// implausibility suppressor that armed only inside 30 minutes and only above
// 25pp. 20pp cleared the bar and 120min cleared the arm, so nothing fired.
//
// These assertions replay that row. They are written to FAIL against the
// pre-fix configuration, not merely to pass against the new one.
import { describe, it, expect } from 'vitest';
import { COMMODITIES } from '../src/engine/commodities.js';
import { applyCalibrationTierCeiling } from '../src/delivery/tier-ceiling.js';
import {
  edgeImplausibleThreshold,
  EDGE_IMPLAUSIBLE_FLOOR_PP,
  EDGE_IMPLAUSIBLE_SIGMA_MULT,
} from '../src/engine/thresholds.js';

// The live row: gold, ~2h to close, σ_blend ≈ 0.14 annualized.
const T_2H = 2 / (24 * 365); // years
const SIGMA_GOLD = 0.14;
const OBSERVED_EDGE = 0.201; // model 0.991 vs book 0.79

describe('§1.1 containment — the Aug 28 gold row cannot publish STRONG', () => {
  it('the implausibility ceiling now FIRES on it (it did not before)', () => {
    const ceiling = edgeImplausibleThreshold(SIGMA_GOLD, T_2H);
    // σ√τ ≈ 0.21%, so 6·σ√τ ≈ 1.3pp — far under the floor, which governs.
    expect(ceiling).toBeCloseTo(EDGE_IMPLAUSIBLE_FLOOR_PP, 5);
    expect(OBSERVED_EDGE).toBeGreaterThan(ceiling);
    // The pre-fix form armed only ≤30min AND >25pp: at 120min it never ran, and
    // 20.1pp would not have cleared 25pp even if it had.
    expect(OBSERVED_EDGE).toBeLessThan(0.25);
  });

  it('and the tier ceiling caps it even if it did publish', () => {
    const shadow = { calibrationActive: false };
    expect(applyCalibrationTierCeiling('gold', 'STRONG', shadow)).toBe('MODERATE');
  });

  it('gold/silver/oil carry the minutes-to-close ceiling bitcoin had', () => {
    for (const c of ['gold', 'silver', 'oil']) {
      expect(COMMODITIES[c].tierCeilingByMinutes).toBeTruthy();
      expect(COMMODITIES[c].tierCeilingByMinutes.STRONG).toBeGreaterThan(0);
      expect(COMMODITIES[c].postSpreadGate).toBe(true);
    }
  });
});

describe('§1.1 ceiling shape — inert on honest edges, decisive on phantoms', () => {
  it('a long-dated high-vol row relaxes above the floor', () => {
    // 30 days, σ=0.6 (crypto cascade regime): σ√τ ≈ 17%, 6·σ√τ ≈ 103pp.
    const ceiling = edgeImplausibleThreshold(0.6, 30 / 365);
    expect(ceiling).toBeGreaterThan(EDGE_IMPLAUSIBLE_FLOOR_PP);
    expect(ceiling).toBeCloseTo(EDGE_IMPLAUSIBLE_SIGMA_MULT * 0.6 * Math.sqrt(30 / 365), 6);
  });

  it('a typical weekly-metals row is governed by the floor, above the STRONG cutoff', () => {
    // σ√τ ≈ 1-2% → 6·σ√τ = 6-12pp, under the 15pp floor. The floor must sit
    // ABOVE the 12pp STRONG cutoff or the guard would eat validated edges.
    const ceiling = edgeImplausibleThreshold(0.14, 5 / 365);
    expect(ceiling).toBe(EDGE_IMPLAUSIBLE_FLOOR_PP);
    expect(EDGE_IMPLAUSIBLE_FLOOR_PP).toBeGreaterThan(0.12);
  });

  it('degrades to the floor on junk inputs — fail-SAFE, never wide open', () => {
    for (const bad of [null, undefined, NaN, 0, -1, Infinity]) {
      expect(edgeImplausibleThreshold(bad, T_2H)).toBe(EDGE_IMPLAUSIBLE_FLOOR_PP);
      expect(edgeImplausibleThreshold(SIGMA_GOLD, bad)).toBe(EDGE_IMPLAUSIBLE_FLOOR_PP);
    }
  });
});
