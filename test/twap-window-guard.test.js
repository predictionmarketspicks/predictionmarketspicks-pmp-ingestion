// TWAP-aware probability model + final-window backstop locks.
// Anchors the 2026-05-22 bitcoin model rewrite + the oil USO-synthetic
// rollback (handoff: COMMODITY_EDGE_OIL_BITCOIN_FIX_2026-05-22.md).
//
// Three things load-bearing here:
//
//   1. Bitcoin uses TWAP-aware prob (config.twapWindowSeconds=60,
//      shortHorizonVolScale=3.5) — see probAboveTwap in options.js.
//      The point-in-time BS prob the engine used before collapsed to
//      0/1 inside the final ~10min before KXBTCD settle; the TWAP model
//      keeps σ honest at sub-hour scales.
//
//   2. minMinutesToClose=2 as the final-window backstop. With the model
//      fix the guard's job shrinks from "absorb every short-T failure"
//      (the 15-min band-aid) to "skip the literal TWAP averaging window
//      where past + future contributions to the average mix".
//
//   3. oil.useUsoSynthetic === false — rollback of the morning's USO-
//      synthetic spot path that read Databento's wrong-by-1.8× USO
//      number as truth and produced fake +20-50pp BUY YES signals.

import { describe, it, expect } from 'vitest';
import { COMMODITIES } from '../src/engine/commodities.js';
import { probAboveTwap, probAboveStrike, effectiveVolShortHorizon } from '../src/engine/options.js';

const HOUR_YR = 1 / (365 * 24);
const MIN_YR = 1 / (365 * 24 * 60);

describe('Bitcoin TWAP-aware prob + short-horizon RV + tier ceiling config', () => {
  it('bitcoin.twapWindowSeconds === 60 (KXBTCD settles on 60s TWAP)', () => {
    expect(COMMODITIES.bitcoin.twapWindowSeconds).toBe(60);
  });

  it('bitcoin.useShortHorizonRv === true (Pyth-tick-grounded σ/μ)', () => {
    expect(COMMODITIES.bitcoin.useShortHorizonRv).toBe(true);
  });

  it('bitcoin.shortHorizonLookbackMin === 15', () => {
    expect(COMMODITIES.bitcoin.shortHorizonLookbackMin).toBe(15);
  });

  it('bitcoin.shortHorizonVolScale === 3.5 (cold-buffer fallback only)', () => {
    // Empirical multiplier retained for the σ×scale fallback path that runs
    // when the Pyth buffer is cold (first ~5 min after a Fly redeploy).
    // Once warm, σ comes from realized data and this constant is unused.
    expect(COMMODITIES.bitcoin.shortHorizonVolScale).toBe(3.5);
  });

  it('bitcoin.tierCeilingByMinutes: STRONG 30 / MODERATE 10 / SPECULATIVE 2', () => {
    expect(COMMODITIES.bitcoin.tierCeilingByMinutes).toEqual({
      STRONG: 30,
      MODERATE: 10,
      SPECULATIVE: 2,
    });
  });

  it('bitcoin.smileKalshiCorrCheck === true', () => {
    expect(COMMODITIES.bitcoin.smileKalshiCorrCheck).toBe(true);
  });

  it('bitcoin.minMinutesToClose is gone (subsumed by tierCeilingByMinutes.SPECULATIVE)', () => {
    expect(COMMODITIES.bitcoin.minMinutesToClose).toBeUndefined();
  });

  it('silver / gold / oil / spx / copper opt out of every TWAP/short-horizon knob', () => {
    for (const c of ['silver', 'gold', 'oil', 'spx', 'copper']) {
      expect(COMMODITIES[c].twapWindowSeconds ?? null).toBe(null);
      expect(COMMODITIES[c].useShortHorizonRv ?? null).toBe(null);
      expect(COMMODITIES[c].tierCeilingByMinutes ?? null).toBe(null);
      expect(COMMODITIES[c].smileKalshiCorrCheck ?? null).toBe(null);
    }
  });
});

describe('Oil USO-synthetic rollback config', () => {
  it('oil.useUsoSynthetic === false', () => {
    expect(COMMODITIES.oil.useUsoSynthetic).toBe(false);
  });

  it('oil.useYahooSpot === true (fallback ladder active)', () => {
    expect(COMMODITIES.oil.useYahooSpot).toBe(true);
  });

  it('oil.spotLabel reflects the active Yahoo path', () => {
    expect(COMMODITIES.oil.spotLabel).toMatch(/yahoo/i);
    expect(COMMODITIES.oil.spotLabel).not.toMatch(/uso-synthetic/i);
  });
});

describe('effectiveVolShortHorizon — short-horizon vol inflation', () => {
  it('returns sigma unchanged when scale <= 1', () => {
    expect(effectiveVolShortHorizon(MIN_YR, 0.5, 1, 1)).toBe(0.5);
    expect(effectiveVolShortHorizon(MIN_YR, 0.5, 0.8, 1)).toBe(0.5);
  });

  it('full scale at T = 0+', () => {
    const T = 1e-9;
    const out = effectiveVolShortHorizon(T, 0.5, 3.5, 1);
    expect(out).toBeCloseTo(0.5 * 3.5, 3);
  });

  it('linear decay — at T = capHours / 2 the boost is midway', () => {
    const T = 0.5 * HOUR_YR;
    const out = effectiveVolShortHorizon(T, 0.5, 3.5, 1);
    const expectedBoost = 3.5 - (3.5 - 1) * 0.5;
    expect(out).toBeCloseTo(0.5 * expectedBoost, 6);
  });

  it('returns sigma unchanged at T >= capHours', () => {
    expect(effectiveVolShortHorizon(HOUR_YR, 0.5, 3.5, 1)).toBe(0.5);
    expect(effectiveVolShortHorizon(2 * HOUR_YR, 0.5, 3.5, 1)).toBe(0.5);
  });
});

describe('probAboveTwap — replicates live KXBTCD pathology', () => {
  // Pulled from the 2026-05-22 live diagnostic:
  //   t-7.4min, BTC spot $75,695, IV ~0.5 (50% annual from smile)
  //   $75,900 strike — Kalshi YES at 0.94. Engine (pre-fix) at 0.01.
  const S = 75_695;
  const T = 7.4 * MIN_YR;
  const sigma = 0.5;
  const mu = 0;
  const TAU_S = 60;

  it('without short-horizon boost the prob is the BS pathology — near 0', () => {
    // probAboveTwap with scale=1 ≈ probAboveStrike (TWAP variance correction
    // for τ << T is sub-percent). Both should produce the 0.01 pathology.
    const K = 75_900;
    const probTwap = probAboveTwap(S, K, T, mu, sigma, TAU_S, 1, 1);
    const probBs = probAboveStrike(S, K, T, 0, 0, sigma);
    expect(probTwap).toBeLessThan(0.10);
    expect(probBs).toBeLessThan(0.10);
    expect(Math.abs(probTwap - probBs)).toBeLessThan(0.01);
  });

  it('with shortHorizonScale=3.5 the prob lifts to a defensible mid range', () => {
    // The model fix: inflated σ moves the $75,900 strike from <1% to >25%.
    // Still a strong disagreement with Kalshi (0.94) but no longer the 0/1
    // collapse that was driving fake BUY NO STRONG -92pp signals.
    const K = 75_900;
    const prob = probAboveTwap(S, K, T, mu, sigma, TAU_S, 3.5, 1);
    expect(prob).toBeGreaterThan(0.25);
    expect(prob).toBeLessThan(0.50);
  });

  it('prob is monotone decreasing in strike at fixed S, T, sigma', () => {
    const strikes = [75_500, 75_700, 75_900, 76_100, 76_400];
    const probs = strikes.map((K) => probAboveTwap(S, K, T, mu, sigma, TAU_S, 3.5, 1));
    for (let i = 1; i < probs.length; i++) {
      expect(probs[i]).toBeLessThan(probs[i - 1]);
    }
  });

  it('prob does NOT collapse to {0, 1} for nearby strikes at short T', () => {
    // The pre-fix pathology: at T = 7.4min, every strike >$200 from spot
    // returned exactly 0 or 1. With the TWAP-aware model + σ inflation,
    // nearby strikes carry meaningful probability mass.
    const strikes = [75_900, 76_100, 76_300];
    for (const K of strikes) {
      const prob = probAboveTwap(S, K, T, mu, sigma, TAU_S, 3.5, 1);
      expect(prob).toBeGreaterThan(0.01);
      expect(prob).toBeLessThan(0.99);
    }
  });

  it('prob converges to standard BS at T >= 1 hour (no short-horizon boost)', () => {
    // shortHorizonVolCapHours=1: at T=1hr or longer, σ_eff = σ and the TWAP
    // correction (τ=60s vs T=3600s) is sub-percent. probAboveTwap should
    // approximately match probAboveStrike.
    const K = 76_500;
    const T1hr = 1 * HOUR_YR;
    const probTwap = probAboveTwap(S, K, T1hr, mu, sigma, TAU_S, 3.5, 1);
    const probBs = probAboveStrike(S, K, T1hr, 0, 0, sigma);
    expect(Math.abs(probTwap - probBs)).toBeLessThan(0.01);
  });

  it('T <= 0 returns indicator (S > K)', () => {
    expect(probAboveTwap(100, 99, 0, 0, 0.5, 60, 3.5, 1)).toBe(1);
    expect(probAboveTwap(100, 101, 0, 0, 0.5, 60, 3.5, 1)).toBe(0);
    expect(probAboveTwap(100, 99, -0.01, 0, 0.5, 60, 3.5, 1)).toBe(1);
  });

  it('zero sigma collapses to deterministic forward', () => {
    const out = probAboveTwap(100, 110, 0.01, 0, 0, 60, 3.5, 1);
    expect(out).toBe(0);
    const out2 = probAboveTwap(110, 100, 0.01, 0, 0, 60, 3.5, 1);
    expect(out2).toBe(1);
  });
});

describe('commodity-base.js wiring (smoke)', () => {
  it('still references the new TWAP + tier-ceiling + smile-kalshi machinery', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = url.fileURLToPath(import.meta.url);
    const src = fs.readFileSync(
      path.resolve(path.dirname(here), '..', 'src', 'engine', 'commodity-base.js'),
      'utf8',
    );
    expect(src).toMatch(/config\.tierCeilingByMinutes/);
    expect(src).toMatch(/twap_settle_window/);
    expect(src).toMatch(/config\.twapWindowSeconds/);
    expect(src).toMatch(/probAboveTwap/);
    expect(src).toMatch(/config\.useShortHorizonRv/);
    expect(src).toMatch(/smile_kalshi_diverged/);
    expect(src).toMatch(/spearmanCorr/);
    expect(src).toMatch(/cold_buffer/);
  });
});

describe('spearmanCorr — event-level surface sanity', () => {
  it('returns ~1 for monotone-increasing pairs', async () => {
    const { __test__ } = await import('../src/engine/commodity-base.js');
    const corr = __test__.spearmanCorr([1, 2, 3, 4, 5], [0.1, 0.3, 0.5, 0.7, 0.9]);
    expect(corr).toBeCloseTo(1, 6);
  });

  it('returns ~-1 for monotone-decreasing pairs (engine vs Kalshi inverted)', async () => {
    const { __test__ } = await import('../src/engine/commodity-base.js');
    const corr = __test__.spearmanCorr([0.1, 0.3, 0.5, 0.7, 0.9], [0.9, 0.7, 0.5, 0.3, 0.1]);
    expect(corr).toBeCloseTo(-1, 6);
  });

  it('returns null when arrays have a constant variable (degenerate)', async () => {
    const { __test__ } = await import('../src/engine/commodity-base.js');
    expect(__test__.spearmanCorr([1, 1, 1, 1], [0.1, 0.3, 0.5, 0.9])).toBe(null);
  });

  it('returns null on length mismatch', async () => {
    const { __test__ } = await import('../src/engine/commodity-base.js');
    expect(__test__.spearmanCorr([1, 2, 3], [0.1, 0.3])).toBe(null);
  });

  it('handles ties via average rank', async () => {
    const { __test__ } = await import('../src/engine/commodity-base.js');
    // [1, 1, 2, 3] vs [0.1, 0.2, 0.3, 0.4] — ties on the first array.
    const corr = __test__.spearmanCorr([1, 1, 2, 3], [0.1, 0.2, 0.3, 0.4]);
    expect(corr).toBeGreaterThan(0.9);
  });
});
