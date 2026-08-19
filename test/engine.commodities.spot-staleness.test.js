// Spot staleness gate — config side.
//
// The gate exists because gold's FRED cross-check never ran: GOLDPMGBD228NLBM
// was deleted from FRED on 2022-01-31 (ICE Benchmark Administration licensing)
// and wired into this engine in 2026-05, so it returned 400 on every snapshot
// while the config claimed a guard was present. These assertions pin the
// replacement so the same "configured but inert" state can't recur silently.

import { describe, it, expect } from 'vitest';
import { COMMODITIES } from '../src/engine/commodities.js';

const PYTH_SOURCED = ['silver', 'gold', 'bitcoin'];

describe('spot staleness gate config', () => {
  it('every enabled Pyth-sourced commodity has a staleness gate', () => {
    for (const name of PYTH_SOURCED) {
      const c = COMMODITIES[name];
      expect(c, `${name} missing from COMMODITIES`).toBeTruthy();
      expect(c.pythSymbol, `${name} should be Pyth-sourced`).toBeTruthy();
      expect(c.useYahooSpot ?? false, `${name} should not use Yahoo spot`).toBe(false);
      expect(
        c.maxSpotAgeMs,
        `${name} is Pyth-sourced and enabled but has no maxSpotAgeMs — a dead ` +
        `spot feed would demote nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it('the threshold clears real Pyth cadence by a wide margin', () => {
    // Pyth publishes these feeds every few seconds; observed ~7s on 2026-08-19.
    // The gate must not fire on normal cadence, so demand >= 20x headroom.
    const OBSERVED_PYTH_INTERVAL_MS = 10_000;
    for (const name of PYTH_SOURCED) {
      expect(COMMODITIES[name].maxSpotAgeMs).toBeGreaterThanOrEqual(
        OBSERVED_PYTH_INTERVAL_MS * 20,
      );
    }
  });

  it('oil has NO staleness gate — its spot is a delayed Yahoo feed', () => {
    // yahoo_cl_f is ~15 minutes delayed by construction, so a Pyth-scale
    // threshold would flag every oil snapshot forever. Oil keeps DCOILWTICO,
    // which unlike the gold series still resolves.
    //
    // NOTE oil DOES carry pythSymbol: 'WTI' — it is "kept for shape parity" and
    // explicitly unused while useYahooSpot is true. So the invariant is the spot
    // SOURCE, not the presence of a Pyth symbol. Asserting on pythSymbol here is
    // what a first draft of this test did, and it was wrong.
    expect(COMMODITIES.oil.useYahooSpot).toBe(true);
    expect(COMMODITIES.oil.maxSpotAgeMs ?? null).toBeNull();
    expect(COMMODITIES.oil.fredSeriesId).toBe('DCOILWTICO');
  });

  it('gold no longer points at the deleted FRED series', () => {
    expect(COMMODITIES.gold.fredSeriesId).toBeNull();
  });
});
