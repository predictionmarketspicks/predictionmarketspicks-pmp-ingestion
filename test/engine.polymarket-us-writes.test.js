// Change-only write plan for the Polymarket US engine.
import { describe, it, expect } from 'vitest';
import {
  planUsWrites,
  markWritten,
  seedLastWritten,
  cadenceMsFor,
  HOUR_MS,
  HEARTBEAT_MS,
} from '../src/engine/polymarket-us-snapshot.js';

const NOW = Date.parse('2026-09-29T20:00:00Z');
const MIN = 60 * 1000;
const row = (id, bid, ask, last = ask) => ({ condition_id: id, best_bid: bid, best_ask: ask, last_trade_price: last });
const entry = (r, kind = 'politics', kickoffMs = null) => ({ row: r, kind, kickoffMs });

describe('seedLastWritten', () => {
  it('seeds from the latest DB row per condition_id', () => {
    const last = new Map();
    const n = seedLastWritten(last, [
      { condition_id: 'pmus:1', best_bid: '0.4200', best_ask: 0.43, last_trade_price: 0.43, snapshot_at: '2026-09-29T19:00:00Z' },
      { condition_id: 'pmus:1', best_bid: 0.1, best_ask: 0.2, last_trade_price: 0.2, snapshot_at: '2026-09-29T15:00:00Z' },
      { condition_id: null, snapshot_at: '2026-09-29T19:00:00Z' },
    ]);
    expect(n).toBe(1);
    expect(last.get('pmus:1')).toMatchObject({ best_ask: 0.43, writtenAt: Date.parse('2026-09-29T19:00:00Z') });
  });
});

describe('planUsWrites', () => {
  const seeded = () => {
    const last = new Map();
    // numeric columns can come back as strings — compare as numbers
    seedLastWritten(last, [{ condition_id: 'pmus:1', best_bid: '0.4200', best_ask: '0.4300', last_trade_price: '0.4300', snapshot_at: new Date(NOW - 2 * HOUR_MS).toISOString() }]);
    return last;
  };

  it('writes a market never seen', () => {
    const p = planUsWrites([entry(row('pmus:9', 0.1, 0.2))], new Map(), { now: NOW });
    expect(p.toWrite).toHaveLength(1);
  });

  it('skips an unchanged market inside the heartbeat', () => {
    const p = planUsWrites([entry(row('pmus:1', 0.42, 0.43))], seeded(), { now: NOW });
    expect(p.toWrite).toHaveLength(0);
    expect(p.skippedUnchanged).toBe(1);
  });

  it('writes when any of bid / ask / last changed', () => {
    for (const r of [row('pmus:1', 0.41, 0.43), row('pmus:1', 0.42, 0.44), row('pmus:1', 0.42, 0.43, 0.425), row('pmus:1', null, 0.43)]) {
      expect(planUsWrites([entry(r)], seeded(), { now: NOW }).toWrite).toHaveLength(1);
    }
  });

  it('heartbeat: writes an unchanged market once its last write is ≥ 6h old', () => {
    const last = seeded();
    const later = NOW - 2 * HOUR_MS + HEARTBEAT_MS;
    expect(planUsWrites([entry(row('pmus:1', 0.42, 0.43))], last, { now: later - 30 * 1000 }).toWrite).toHaveLength(1); // within the 1-min slack
    expect(planUsWrites([entry(row('pmus:1', 0.42, 0.43))], last, { now: later - 30 * MIN }).toWrite).toHaveLength(0);
  });

  it('hourly cadence: a changed non-game market is held until an hour has passed', () => {
    const last = new Map();
    markWritten(last, [row('pmus:1', 0.42, 0.43)], NOW);
    const changed = entry(row('pmus:1', 0.5, 0.51));
    const p = planUsWrites([changed], last, { now: NOW + 15 * MIN });
    expect(p.toWrite).toHaveLength(0);
    expect(p.skippedCadence).toBe(1);
    expect(planUsWrites([changed], last, { now: NOW + HOUR_MS }).toWrite).toHaveLength(1);
  });

  it('NFL game within 7 days of kickoff: every tick when changed', () => {
    const last = new Map();
    markWritten(last, [row('pmus:7', 0.575, 0.58)], NOW);
    const kickoff = NOW + 2 * 24 * HOUR_MS;
    const e = entry(row('pmus:7', 0.57, 0.575), 'nfl_game', kickoff);
    expect(planUsWrites([e], last, { now: NOW + 15 * MIN }).toWrite).toHaveLength(1);
    // unchanged still skips — cadence is a ceiling, not a floor
    const same = entry(row('pmus:7', 0.575, 0.58), 'nfl_game', kickoff);
    expect(planUsWrites([same], last, { now: NOW + 15 * MIN }).skippedUnchanged).toBe(1);
  });

  it('NFL game more than 7 days out: at most hourly', () => {
    const last = new Map();
    markWritten(last, [row('pmus:8', 0.3, 0.31)], NOW);
    const e = entry(row('pmus:8', 0.32, 0.33), 'nfl_game', NOW + 10 * 24 * HOUR_MS);
    expect(planUsWrites([e], last, { now: NOW + 15 * MIN }).skippedCadence).toBe(1);
    expect(planUsWrites([e], last, { now: NOW + HOUR_MS }).toWrite).toHaveLength(1);
  });

  it('cadenceMsFor: in-play / past kickoff stays every tick; unknown kickoff is hourly', () => {
    expect(cadenceMsFor({ kind: 'nfl_game', kickoffMs: NOW - HOUR_MS }, NOW)).toBe(0);
    expect(cadenceMsFor({ kind: 'nfl_game', kickoffMs: null }, NOW)).toBe(HOUR_MS);
    expect(cadenceMsFor({ kind: 'nfl_future', kickoffMs: null }, NOW)).toBe(HOUR_MS);
  });

  it('does not mutate the map; markWritten records what was written', () => {
    const last = new Map();
    const p = planUsWrites([entry(row('pmus:5', 0.1, 0.2))], last, { now: NOW });
    expect(last.size).toBe(0);
    markWritten(last, p.toWrite, NOW);
    expect(last.get('pmus:5')).toEqual({ best_bid: 0.1, best_ask: 0.2, last_trade_price: 0.2, writtenAt: NOW });
  });
});
