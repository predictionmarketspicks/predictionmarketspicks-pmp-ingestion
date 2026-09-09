// roster-status normalizer — the ext_player_status feed.
// handoffs/NFL_EXT_FEEDS_PFF_API_MIGRATION_2026-09-09.md

import { describe, it, expect } from 'vitest';
import { normalizeRosterStatus, fetchOnce } from '../src/feeds/roster-status.js';

const raw = (o = {}) => ({
  pff_player_id: 145059,
  name: 'TreVeyon Henderson',
  team: 'NE',
  position: 'HB',
  alignment: 'HB',
  unit: 'offense',
  depth_order: 3,
  status: 'out',
  snap_pct: null,
  snap_counts: null,
  jersey: '32',
  week: 1,
  ...o,
});

describe('roster-status normalizer', () => {
  it('keeps the vendor id as text and carries the availability triple', () => {
    const { rows } = normalizeRosterStatus([raw()], { season: 2026, source: 'api' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      season: 2026,
      week: 1,
      pff_player_id: '145059',   // text, not a number — it is a key, not a quantity
      player_name: 'TreVeyon Henderson',
      team: 'NE',
      depth_order: 3,
      status: 'out',
      source: 'api',
    });
  });

  it('passes the vendor status word through UNMAPPED', () => {
    // The engine's OUT/DOUBTFUL/QUESTIONABLE vocabulary is applied at READ time,
    // where the mapping table already lives. Normalising here would fork the
    // vocabulary into two places and destroy the vendor's original word.
    for (const s of ['out', 'questionable', 'active', 'ir']) {
      const { rows } = normalizeRosterStatus([raw({ status: s })], { season: 2026 });
      expect(rows[0].status).toBe(s);
    }
  });

  it('drops a row it cannot key, rather than inventing an id', () => {
    expect(normalizeRosterStatus([raw({ pff_player_id: null })], { season: 2026 }).rows).toHaveLength(0);
    expect(normalizeRosterStatus([raw({ name: null })], { season: 2026 }).rows).toHaveLength(0);
    const { dropped } = normalizeRosterStatus([raw({ name: null })], { season: 2026 });
    expect(dropped).toHaveLength(1);
  });

  it('collapses intra-batch dupes on the exact conflict key', () => {
    // Otherwise Postgres throws "ON CONFLICT ... cannot affect row a second time".
    const { rows } = normalizeRosterStatus([raw(), raw({ status: 'active' })], { season: 2026 });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('out');   // first wins
  });

  it('keeps a real 0 distinct from a missing value', () => {
    // ext-parse's rule: never a guessed 0. snap_pct 0 means "played none";
    // null means "we were not told".
    const zero = normalizeRosterStatus([raw({ snap_pct: 0 })], { season: 2026 }).rows[0];
    const miss = normalizeRosterStatus([raw({ snap_pct: null })], { season: 2026 }).rows[0];
    expect(zero.snap_pct).toBe(0);
    expect(miss.snap_pct).toBeNull();
  });

  it('leaves an unresolvable team null instead of dropping the player', () => {
    // The status is still true even if the team code is unfamiliar — same line
    // grades-player takes for player-keyed feeds.
    const { rows } = normalizeRosterStatus([raw({ team: 'ZZZ' })], { season: 2026 });
    expect(rows).toHaveLength(1);
    expect(rows[0].team).toBeNull();
  });

  it('stamps ingested_at on every row', () => {
    // The column's now() default fires on INSERT only, so an upsert that omits
    // it leaves the first-ever capture timestamp in place forever.
    const { rows } = normalizeRosterStatus([raw()], { season: 2026 });
    expect(Date.parse(rows[0].ingested_at)).not.toBeNaN();
  });

  it('fetchOnce is SYNCHRONOUS — the runner does not await it', () => {
    // scripts/ingest-ext-feeds.js:109 calls fetchOnce without await; returning a
    // Promise makes the runner destructure undefined and write nothing.
    const result = fetchOnce({
      stagingPath: new URL('../data/ext-staging/roster-status.example.json', import.meta.url).pathname,
      source: 'test',
    });
    expect(result).not.toBeInstanceOf(Promise);
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
