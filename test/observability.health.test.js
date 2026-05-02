// Liveness gate — pure-function tests (no HTTP, no feeds).
// BetterStack pages on the 503 produced by evaluateLiveness, so the threshold
// + grace logic must stay deterministic and the public surface stable.

import { describe, it, expect, beforeEach, vi } from 'vitest';

let health;

beforeEach(async () => {
  // Re-import per test so the module-scoped startedAt resets and required
  // feeds + tick state don't bleed between cases.
  vi.resetModules();
  health = await import('../src/observability/health.js');
});

const ET_MARKET_NOON = new Date('2026-05-13T16:00:00Z'); // Wed 12:00 ET (DST)
const ET_OFF_HOURS_LATE = new Date('2026-05-14T06:00:00Z'); // Thu 02:00 ET
const ET_WEEKEND = new Date('2026-05-09T16:00:00Z'); // Sat 12:00 ET

describe('isUsMarketOpen', () => {
  it('treats a weekday noon ET instant as market hours', () => {
    expect(health.isUsMarketOpen(ET_MARKET_NOON)).toBe(true);
  });

  it('treats overnight as off-hours', () => {
    expect(health.isUsMarketOpen(ET_OFF_HOURS_LATE)).toBe(false);
  });

  it('treats Saturday as off-hours', () => {
    expect(health.isUsMarketOpen(ET_WEEKEND)).toBe(false);
  });
});

describe('evaluateLiveness', () => {
  it('returns healthy=true during the 60s boot grace, even with no ticks', () => {
    health.markFeedRequired('kalshi');
    const result = health.evaluateLiveness(Date.now() + 1000);
    expect(result.healthy).toBe(true);
    expect(result.grace).toBe(true);
    expect(result.stale).toEqual([]);
  });

  it('flags never_ticked feeds as stale once boot grace elapses', () => {
    health.markFeedRequired('kalshi');
    const after = Date.now() + 61_000;
    const result = health.evaluateLiveness(after);
    expect(result.healthy).toBe(false);
    expect(result.stale).toEqual([{ name: 'kalshi', reason: 'never_ticked' }]);
  });

  it('uses 90s threshold during US market hours', () => {
    // Force a market-hours instant via a function override would be cleaner,
    // but evaluateLiveness derives "in market hours" from `new Date(nowMs)`.
    // We pick a Wednesday 12:00 ET timestamp that's also >60s past startedAt.
    health.markFeedRequired('kalshi');
    const marketNoonMs = ET_MARKET_NOON.getTime();
    health.recordTick.call(null, 'kalshi'); // flips lastTickAt to NOW
    // We then ask: at marketNoonMs (a fixed wall-clock), how stale is the tick?
    // For the test we mutate state manually so we don't depend on real time.
    health.setFeedStatus('kalshi', { lastTickAt: marketNoonMs - 80_000 });
    const fresh = health.evaluateLiveness(marketNoonMs);
    expect(fresh.healthy).toBe(true);
    expect(fresh.thresholdMs).toBe(90_000);
    expect(fresh.inMarketHours).toBe(true);

    health.setFeedStatus('kalshi', { lastTickAt: marketNoonMs - 95_000 });
    const stale = health.evaluateLiveness(marketNoonMs);
    expect(stale.healthy).toBe(false);
    expect(stale.stale[0]).toMatchObject({ name: 'kalshi', reason: 'stale' });
  });

  it('uses 300s threshold off-hours', () => {
    health.markFeedRequired('kalshi');
    const offMs = ET_OFF_HOURS_LATE.getTime();
    health.setFeedStatus('kalshi', { lastTickAt: offMs - 250_000 });
    const fresh = health.evaluateLiveness(offMs);
    expect(fresh.healthy).toBe(true);
    expect(fresh.thresholdMs).toBe(300_000);
    expect(fresh.inMarketHours).toBe(false);

    health.setFeedStatus('kalshi', { lastTickAt: offMs - 320_000 });
    const stale = health.evaluateLiveness(offMs);
    expect(stale.healthy).toBe(false);
  });

  it('only gates on required feeds — non-required ones cannot fail readiness', () => {
    health.registerFeed('decorative_only');
    const after = Date.now() + 120_000;
    const result = health.evaluateLiveness(after);
    expect(result.healthy).toBe(true);
    expect(result.stale).toEqual([]);
  });

  it('reports each required feed independently', () => {
    health.markFeedRequired('kalshi');
    health.markFeedRequired('polymarket');
    const t = ET_MARKET_NOON.getTime();
    health.setFeedStatus('kalshi', { lastTickAt: t - 30_000 });
    health.setFeedStatus('polymarket', { lastTickAt: t - 200_000 });
    const result = health.evaluateLiveness(t);
    expect(result.healthy).toBe(false);
    expect(result.stale.map((s) => s.name)).toEqual(['polymarket']);
  });
});

describe('snapshot', () => {
  it('marks required feeds with required=true', () => {
    health.markFeedRequired('kalshi');
    health.registerFeed('arb_engine');
    const snap = health.snapshot();
    expect(snap.feeds.kalshi.required).toBe(true);
    expect(snap.feeds.arb_engine.required).toBe(false);
  });
});
