// Only the quote firehose may be thinned — never once-per-session records.
//
// ⛔ WHY. on_record's drop and decimate filters were record-type-BLIND: every
// record carrying an instrument_id went through them, including StatMsg (how
// OPEN INTEREST arrives) and InstrumentDefMsg (how strikes arrive). Both are
// once per instrument per session. There is no retry, so a single drop loses
// that value for the whole day.
//
// Dealer gamma weights every strike by open interest, so an instrument whose OI
// print was dropped contributed nothing; with enough of them the net summed to
// exactly 0 and the engine published "NEUTRAL" — a fabricated reading, on four
// public tool pages, bitcoin on 77 of 78 days. Measured on the live sidecar
// 2026-09-10: stats=17,323 received, oi_updates=0, callback_dropped=1,416,953,
// decimated=199,230.
//
// Whether a given OI print survived came down to whether a quote for the same
// instrument landed within the preceding DATABENTO_DECIMATE_MS. That coin flip
// is why dealer gamma worked on some sessions and not others.
//
// The sidecar is Python, so this asserts on its source. A behavioural test would
// need a databento client; these are the four properties that actually broke.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  fileURLToPath(new URL('../python/databento_live.py', import.meta.url)), 'utf8');

describe('databento sidecar — throttle scope', () => {
  it('throttles quotes and trades, and nothing else', () => {
    const m = SRC.match(/_THROTTLED_RTYPES\s*=\s*frozenset\(\{([^}]*)\}\)/);
    expect(m, '_THROTTLED_RTYPES is gone — the filters are record-type-blind again').toBeTruthy();
    const set = m[1].split(',').map((t) => t.trim().replace(/['"]/g, '')).filter(Boolean).sort();
    expect(set).toEqual(['cmbp1msg', 'trademsg']);
  });

  it('gates on record type BEFORE both filters — order is the whole fix', () => {
    // ⚠️ Strip the docstring first. on_record's own docstring NAMES both filters
    // to explain them, so a naive indexOf finds the prose and compares comments
    // instead of code — the same self-counting trap as elsewhere in this repo.
    const whole = SRC.split('\ndef on_record')[1].split('\ndef ')[0];
    const cb = whole.slice(whole.indexOf('\"\"\"', whole.indexOf('\"\"\"') + 3) + 3);
    const gate = cb.indexOf('_THROTTLED_RTYPES');
    expect(gate, 'no type gate inside on_record').toBeGreaterThan(-1);
    expect(gate).toBeLessThan(cb.indexOf('_drop_instrument'));
    expect(gate).toBeLessThan(cb.indexOf('QUOTE_MIN_INTERVAL_NS'));
  });

  it('still reads open interest off StatType 9', () => {
    // Databento's StatType enum puts OPEN_INTEREST at 9. A wrong constant drops
    // every print with no error at all.
    expect(SRC).toMatch(/STAT_TYPE_OPEN_INTEREST\s*=\s*9\b/);
    expect(SRC).toContain('rtype_norm == "statmsg"');
  });

  it('still subscribes the statistics schema', () => {
    // cmbp-1 and trades carry no OI, so without this schema it cannot arrive.
    const m = SRC.match(/for schema in \(([^)]*)\)/);
    expect(m).toBeTruthy();
    const schemas = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect(schemas).toContain('statistics');
    expect(schemas).toContain('definition');
    expect(schemas).toContain('cmbp-1');
  });
});
