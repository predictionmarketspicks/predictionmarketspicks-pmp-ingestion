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

  it('oil has a 120 s staleness gate ONLY because its spot is delta-bridged to the live proxy', () => {
    // Until 2026-11-09 oil had NO gate: yahoo_cl_f is ~15 minutes delayed by
    // construction, so a Pyth-scale threshold would have flagged every snapshot
    // forever. OIL_EDGE_DEEP_DIVE_2026-11-09 U1 bridges the Yahoo print to now
    // with the live WTI proxy's move, so the spot is as-of the proxy's last print
    // and a 120 s bar means "the bridge fell back to the raw delayed quote". The
    // two flags are a pair: a gate without the bridge demotes every oil row.
    //
    // NOTE oil DOES carry pythSymbol: 'WTI' — it is "kept for shape parity" and
    // explicitly unused while useYahooSpot is true. So the invariant is the spot
    // SOURCE, not the presence of a Pyth symbol.
    expect(COMMODITIES.oil.useYahooSpot).toBe(true);
    expect(COMMODITIES.oil.bridgeSpotWithProxy).toBe(true);
    expect(COMMODITIES.oil.maxSpotAgeMs).toBe(120_000);
    expect(COMMODITIES.oil.fredSeriesId).toBe('DCOILWTICO');
  });

  it('no other commodity bridges its spot — the bridge is oil-specific', () => {
    for (const name of Object.keys(COMMODITIES)) {
      if (name === 'oil') continue;
      expect(COMMODITIES[name].bridgeSpotWithProxy ?? false, `${name} must not bridge`).toBe(false);
    }
  });

  it('gold no longer points at the deleted FRED series', () => {
    expect(COMMODITIES.gold.fredSeriesId).toBeNull();
  });
});
