import { describe, it, expect } from 'vitest';
import { HARD_SUPPRESS_FLAGS } from '../src/engine/commodity-base.js';
import {
  classifyFlagCounts,
  ceilingsFor,
  minSnapshotsPerDay,
  EXPECTED_FLAGS_FOR_TEST,
  CEILINGS_FOR_TEST,
} from '../scripts/soak-commodities.js';

/**
 * The soak's job is to notice when an engine breaks. It spent 84 of 85
 * scheduled runs failing for reasons that were not breakage, which is worse
 * than not running: every FAIL looked the same, so the one that mattered would
 * have looked the same too.
 *
 * These tests pin the two properties that state implies — it must not fire on
 * normal operation, and it must still fire on a genuine fault — plus the
 * vocabulary coupling that stops the drift recurring.
 */
describe('soak flag vocabulary is coupled to the engine', () => {
  it('every engine hard-suppress flag is classified by the soak', () => {
    // ⛔ THE POINT OF THIS TEST. A flag the engine suppresses but the soak has
    // never heard of gets ceiling 0 — so a WORKING guard fails the soak on its
    // first sighting. That happened twice: edge_implausible (added after the
    // soak was written) and near_expiry (2026-09-09, 450 bitcoin rows).
    const unclassified = [...HARD_SUPPRESS_FLAGS].filter(
      (f) => !EXPECTED_FLAGS_FOR_TEST.has(f) && CEILINGS_FOR_TEST[f] === undefined,
    );
    expect(unclassified, `engine flags the soak cannot classify: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('the two flags that caused the outage are treated as expected, not ceilinged', () => {
    // They are hard-suppressed BY DESIGN, so any count is fine. A raised
    // ceiling would only move the false failure, not remove it.
    for (const flag of ['edge_implausible', 'near_expiry']) {
      expect(EXPECTED_FLAGS_FOR_TEST.has(flag), `${flag} must be expected`).toBe(true);
      expect(classifyFlagCounts({ [flag]: 9999 })).toEqual([]);
    }
  });
});

describe('soak passes normal operation', () => {
  // The real counts from the run that went red on 2026-09-10.
  const REAL_TODAY = {
    silver: { edge_implausible: 2 },
    gold: { edge_implausible: 3 },
    oil: { edge_implausible: 21 },
    bitcoin: { kalshi_no_book: 254, edge_implausible: 1 },
  };
  for (const [commodity, counts] of Object.entries(REAL_TODAY)) {
    it(`${commodity}: today's real flag counts pass`, () => {
      expect(classifyFlagCounts(counts, { ceilings: ceilingsFor(commodity) })).toEqual([]);
    });
  }

  it('gold and silver write once a day and that is not a failure', () => {
    // Measured over 90 days: both are exactly 1/day, every day. The old flat
    // floor of 4 made them unpassable.
    expect(minSnapshotsPerDay('gold')).toBe(1);
    expect(minSnapshotsPerDay('silver')).toBe(1);
  });

  it('oil is 1, not 2 — it writes once on some days', () => {
    expect(minSnapshotsPerDay('oil')).toBe(1);
  });
});

describe('soak still fails a genuine fault', () => {
  it('an engine that stopped writing fails', () => {
    for (const c of ['bitcoin', 'oil', 'gold', 'silver']) {
      expect(0 < minSnapshotsPerDay(c), `${c}: zero snapshots must fail`).toBe(true);
    }
  });

  it('bitcoin losing most of its cadence fails', () => {
    // 8 is under the observed floor of 14, so a real collapse still trips it.
    expect(7 < minSnapshotsPerDay('bitcoin')).toBe(true);
  });

  it('kalshi_no_book far above any observed day still fails, per commodity', () => {
    // bitcoin's 90-day max is 281; the metals' is 19.
    expect(classifyFlagCounts({ kalshi_no_book: 500 }, { ceilings: ceilingsFor('bitcoin') })).toHaveLength(1);
    expect(classifyFlagCounts({ kalshi_no_book: 100 }, { ceilings: ceilingsFor('gold') })).toHaveLength(1);
  });

  it('a normal bitcoin day does NOT fail the metals ceiling by accident', () => {
    // The bug the per-commodity override exists for: 254 is ordinary for
    // bitcoin and a 13x anomaly for gold. One number cannot mean both.
    expect(classifyFlagCounts({ kalshi_no_book: 254 }, { ceilings: ceilingsFor('bitcoin') })).toEqual([]);
    expect(classifyFlagCounts({ kalshi_no_book: 254 }, { ceilings: ceilingsFor('gold') })).toHaveLength(1);
  });

  it('an unknown flag is still a violation — the default stays strict', () => {
    // Registering the two known-good flags must not turn the soak permissive.
    expect(classifyFlagCounts({ some_new_engine_flag: 1 })).toHaveLength(1);
  });
});
