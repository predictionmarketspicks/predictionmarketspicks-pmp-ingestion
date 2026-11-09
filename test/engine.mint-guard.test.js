// Oil mint-timing guard (site repo handoffs/OIL_EDGE_DEEP_DIVE_2026-11-09.md §4 U3).
// No oil BUY row before 10:00 ET; none on a spot older than 60 s. Oil only.
import { describe, it, expect } from 'vitest';
import { applyOilMintGuard, oilMintBlockReason, OIL_MINT_OPEN_HOUR_ET, OIL_MINT_MAX_SPOT_AGE_MS } from '../src/engine/mint-guard.js';
import { PASS_REASONS } from '../src/engine/commodity-base.js';

const at = (iso) => new Date(iso).getTime();
const fresh = (nowMs) => ({ spotPublishTimeMs: nowMs - 5_000 });

describe('oilMintBlockReason — the clock', () => {
  it('blocks the 9:36 ET mint minute, in EST and in EDT', () => {
    expect(oilMintBlockReason(fresh(at('2026-11-10T14:36:00Z')), { nowMs: at('2026-11-10T14:36:00Z') })).toMatch(/before 10:00 ET \(9h\)/); // EST
    expect(oilMintBlockReason(fresh(at('2026-07-14T13:36:00Z')), { nowMs: at('2026-07-14T13:36:00Z') })).toMatch(/before 10:00 ET \(9h\)/); // EDT
  });
  it('opens at 10:00 ET exactly, in EST and in EDT', () => {
    expect(oilMintBlockReason(fresh(at('2026-11-10T15:00:00Z')), { nowMs: at('2026-11-10T15:00:00Z') })).toBeNull(); // 10:00 EST
    expect(oilMintBlockReason(fresh(at('2026-12-01T14:59:00Z')), { nowMs: at('2026-12-01T14:59:00Z') })).not.toBeNull(); // 9:59 EST
    expect(oilMintBlockReason(fresh(at('2026-07-14T14:00:00Z')), { nowMs: at('2026-07-14T14:00:00Z') })).toBeNull(); // 10:00 EDT
    expect(oilMintBlockReason(fresh(at('2026-07-14T13:59:00Z')), { nowMs: at('2026-07-14T13:59:00Z') })).not.toBeNull(); // 9:59 EDT
  });
  it('the 2:40 PM next-day mint minute is NOT blocked by the clock gate (that lane is U5, a rule)', () => {
    expect(oilMintBlockReason(fresh(at('2026-11-10T19:40:00Z')), { nowMs: at('2026-11-10T19:40:00Z') })).toBeNull();
  });
  it('constants are the handoff values', () => {
    expect(OIL_MINT_OPEN_HOUR_ET).toBe(10);
    expect(OIL_MINT_MAX_SPOT_AGE_MS).toBe(60_000);
  });
});

describe('oilMintBlockReason — the spot age belt', () => {
  const now = at('2026-11-10T16:00:00Z'); // 11:00 ET, clock open
  it('61 s old blocks, 60 s passes, 59 s passes', () => {
    expect(oilMintBlockReason({ spotPublishTimeMs: now - 61_000 }, { nowMs: now })).toMatch(/spot 61s old \(max 60s\)/);
    expect(oilMintBlockReason({ spotPublishTimeMs: now - 60_000 }, { nowMs: now })).toBeNull();
    expect(oilMintBlockReason({ spotPublishTimeMs: now - 59_000 }, { nowMs: now })).toBeNull();
  });
  it('an unknown spot age blocks (a mint needs a timestamped spot)', () => {
    expect(oilMintBlockReason({ spotPublishTimeMs: null }, { nowMs: now })).toBe('spot age unknown');
    expect(oilMintBlockReason({}, { nowMs: now })).toBe('spot age unknown');
    expect(oilMintBlockReason(null, { nowMs: now })).toBe('spot age unknown');
  });
  it('a raw 12-minute Yahoo print (the pre-U1 world) can never mint', () => {
    expect(oilMintBlockReason({ spotPublishTimeMs: now - 12 * 60_000 }, { nowMs: now })).toMatch(/spot 720s old/);
  });
});

function snapWith(rows, nowMs) {
  return {
    meta: { commodity: 'oil', spotPublishTimeMs: nowMs - 3_000, topEdge: rows[0], topTier: 'STRONG' },
    rows: rows.map((r) => ({ ...r })),
  };
}
const buyYes = { strike: 87.99, direction: 'BUY YES', confidence: 'high', fused_confidence: 'STRONG', pass_reason: null, rationale: 'model 80% vs 62%' };
const buyNo = { strike: 88.49, direction: 'BUY NO', confidence: 'medium', fused_confidence: 'MODERATE', pass_reason: null, rationale: 'model 12% vs 30%' };
const pass = { strike: 86.99, direction: 'PASS', confidence: 'low', fused_confidence: 'NO_EDGE', pass_reason: 'edge_under_5pp', rationale: 'Edge 2.1pp below 5pp threshold' };
const watch = { strike: 89.99, direction: 'PASS', confidence: 'watch', fused_confidence: 'NO_EDGE', pass_reason: 'entry_floor', entry_floor: { direction: 'BUY YES' }, rationale: 'costs 22c' };

describe('applyOilMintGuard — the rows the trigger will see', () => {
  it('before 10:00 ET every BUY row is held as PASS; PASS and WATCH rows are untouched; meta has no top edge', () => {
    const now = at('2026-11-10T14:36:00Z');
    const snap = snapWith([buyYes, buyNo, pass, watch], now);
    const out = applyOilMintGuard({ commodity: 'oil' }, snap, { nowMs: now });
    expect(out.blocked).toMatch(/before 10:00 ET/);
    expect(out.demoted).toBe(2);
    for (const r of snap.rows.slice(0, 2)) {
      expect(r.direction).toBe('PASS');
      expect(r.confidence).toBe('skip');
      expect(r.fused_confidence).toBe('NO_EDGE');
      expect(r.pass_reason).toBe('fused_no_edge');
      expect(PASS_REASONS).toContain(r.pass_reason); // the DB CHECK vocabulary
      expect(r.rationale).toMatch(/mint guard: before 10:00 ET/);
    }
    expect(snap.rows[2]).toEqual(pass);
    expect(snap.rows[3]).toEqual(watch);
    expect(snap.meta.topEdge).toBeNull();
    expect(snap.meta.topTier).toBe('NO_EDGE');
    expect(snap.meta.mintGuard).toMatch(/before 10:00 ET/);
  });

  it('after 10:00 ET with a fresh spot nothing changes', () => {
    const now = at('2026-11-10T15:05:00Z');
    const snap = snapWith([buyYes, buyNo, pass], now);
    const before = JSON.stringify(snap);
    const out = applyOilMintGuard({ commodity: 'oil' }, snap, { nowMs: now });
    expect(out).toEqual({ blocked: null, demoted: 0 });
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('a stale spot after 10:00 ET holds the BUY rows too', () => {
    const now = at('2026-11-10T15:05:00Z');
    const snap = snapWith([buyYes, pass], now);
    snap.meta.spotPublishTimeMs = now - 90_000;
    const out = applyOilMintGuard({ commodity: 'oil' }, snap, { nowMs: now });
    expect(out.blocked).toMatch(/spot 90s old/);
    expect(snap.rows[0].direction).toBe('PASS');
  });

  it('is oil-only: gold, silver and bitcoin snapshots at 9:36 ET are untouched', () => {
    const now = at('2026-11-10T14:36:00Z');
    for (const commodity of ['gold', 'silver', 'bitcoin']) {
      const snap = snapWith([buyYes, buyNo], now);
      const before = JSON.stringify(snap);
      expect(applyOilMintGuard({ commodity }, snap, { nowMs: now })).toEqual({ blocked: null, demoted: 0 });
      expect(JSON.stringify(snap)).toBe(before);
    }
  });

  it('tolerates a null snapshot', () => {
    expect(applyOilMintGuard({ commodity: 'oil' }, null)).toEqual({ blocked: null, demoted: 0 });
  });
});
