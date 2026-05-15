// Per-feed liveness state. Each feed module updates its own slot via setFeedStatus().
// /health endpoint reads the snapshot and decides 200 vs 503 via evaluateLiveness().
//
// Phase 4 model:
//   - registerFeed(name) is purely descriptive — it makes the feed visible in
//     /health output but doesn't gate readiness.
//   - markFeedRequired(name) opts a feed into the readiness gate. If any
//     required feed is stale beyond the active threshold, /health returns 503
//     and BetterStack pages the operator.
//   - Default threshold is 90s during US market hours (9:30 AM – 4 PM ET,
//     Mon–Fri) and 300s off-hours. WS feeds (kalshi, polymarket) and fast
//     pollers (pyth 10s) clear that bar trivially.
//   - Slow feeds can pass `{ maxStaleMs }` to markFeedRequired to use their
//     own threshold. Massive feeds on the delayed tier poll every 15min and
//     would never clear the global bar, so they register with a 17min
//     override (15min poll + buffer). The override applies in BOTH market and
//     off-hours states; it is not multiplied against the global threshold.
//   - 60s post-boot grace window: cold-start before any feed has had a chance
//     to tick must not flap the monitor. The Fly check has a 30s grace_period
//     of its own — this stacks on top.

import { getClient } from '../delivery/supabase.js';
import { postBotLog } from '../delivery/discord.js';

const startedAt = Date.now();

const feeds = new Map();
const requiredFeeds = new Map(); // name → { maxStaleMs?: number }

const MARKET_HOURS_THRESHOLD_MS = 90 * 1000;
const OFF_HOURS_THRESHOLD_MS = 300 * 1000;
const BOOT_GRACE_MS = 60 * 1000;

export function registerFeed(name) {
  if (!feeds.has(name)) {
    feeds.set(name, { name, connected: false, lastTickAt: null, lastError: null });
  }
}

export function markFeedRequired(name, opts = {}) {
  registerFeed(name);
  const prev = requiredFeeds.get(name) || {};
  requiredFeeds.set(name, { ...prev, ...opts });
}

export function setFeedStatus(name, patch) {
  const prev = feeds.get(name) || { name, connected: false, lastTickAt: null, lastError: null };
  feeds.set(name, { ...prev, ...patch });
}

export function recordTick(name) {
  setFeedStatus(name, { lastTickAt: Date.now() });
}

// US equity / options market hours, used to pick the staleness threshold.
// Same approximation as src/feeds/massive.js — converts "now" to ET via
// toLocaleString so DST is handled by the runtime.
export function isUsMarketOpen(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export function evaluateLiveness(nowMs = Date.now()) {
  const inMarketHours = isUsMarketOpen(new Date(nowMs));
  const thresholdMs = inMarketHours ? MARKET_HOURS_THRESHOLD_MS : OFF_HOURS_THRESHOLD_MS;
  const uptimeMs = nowMs - startedAt;
  if (uptimeMs < BOOT_GRACE_MS) {
    return { healthy: true, inMarketHours, thresholdMs, uptimeMs, grace: true, stale: [] };
  }
  const stale = [];
  for (const [name, override] of requiredFeeds) {
    const f = feeds.get(name);
    if (!f) {
      stale.push({ name, reason: 'unregistered' });
      continue;
    }
    if (!f.lastTickAt) {
      stale.push({ name, reason: 'never_ticked' });
      continue;
    }
    const ageMs = nowMs - f.lastTickAt;
    const effectiveThreshold = override.maxStaleMs ?? thresholdMs;
    if (ageMs > effectiveThreshold) {
      stale.push({ name, reason: 'stale', ageMs, thresholdMs: effectiveThreshold });
    }
  }
  return { healthy: stale.length === 0, inMarketHours, thresholdMs, uptimeMs, grace: false, stale };
}

// Guard-rejection telemetry. Called from commodity-base.js when validateSnapshot
// blocks a write. Two side effects: Discord embed to #bot-logs (rate-limited to
// 1 per (commodity, reason) per 5min so a 30-min outage doesn't spam the channel)
// and a data_health upsert so /admin/oracle-health surfaces it alongside feed
// liveness. Pure-fire-and-forget: errors are swallowed so a Discord/Supabase
// outage cannot cascade into engine failure.
const guardRejectionLastFire = new Map(); // `${commodity}:${reason}` → ms
const GUARD_REJECTION_COOLDOWN_MS = 5 * 60 * 1000;

export async function recordGuardRejection(commodity, reason, detail = {}) {
  setFeedStatus(`${commodity}_engine`, { lastError: `guard_${reason}_failed` });

  const key = `${commodity}:${reason}`;
  const now = Date.now();
  const last = guardRejectionLastFire.get(key) || 0;
  const shouldPost = now - last >= GUARD_REJECTION_COOLDOWN_MS;
  if (shouldPost) {
    guardRejectionLastFire.set(key, now);
    const lines = [
      `Engine guard rejected ${commodity} snapshot`,
      `Commodity: ${commodity}`,
      `Reason: ${reason}`,
      `Detail: ${JSON.stringify(detail).slice(0, 600)}`,
      `At: ${new Date(now).toISOString()}`,
    ];
    try {
      await postBotLog(lines.join('\n'));
    } catch (err) {
      console.warn(`[guard] discord post failed: ${err?.message || err}`);
    }
  }

  try {
    const sb = getClient();
    const { error } = await sb
      .from('data_health')
      .upsert(
        {
          check_id: `commodity_engine_${commodity}`,
          status: 'unhealthy',
          stale_count: 1,
          total_checked: 1,
          details: { reason, detail, snapshot_at: new Date(now).toISOString() },
          checked_at: new Date(now).toISOString(),
        },
        { onConflict: 'check_id' },
      );
    if (error) console.warn(`[guard] data_health upsert failed: ${error.message}`);
  } catch (err) {
    console.warn(`[guard] data_health upsert threw: ${err?.message || err}`);
  }
}

// Mark a commodity engine as healthy after a clean validateSnapshot pass.
// Lets /admin/oracle-health recover from a prior rejection without waiting for
// an out-of-band reset. Same upsert path as recordGuardRejection.
export async function recordGuardOk(commodity) {
  try {
    const sb = getClient();
    await sb
      .from('data_health')
      .upsert(
        {
          check_id: `commodity_engine_${commodity}`,
          status: 'healthy',
          stale_count: 0,
          total_checked: 1,
          details: { snapshot_at: new Date().toISOString() },
          checked_at: new Date().toISOString(),
        },
        { onConflict: 'check_id' },
      );
  } catch {
    // healthy-state writes are advisory; swallow.
  }
}

export function snapshot() {
  const now = Date.now();
  const feedSnap = {};
  for (const [name, state] of feeds) {
    feedSnap[name] = {
      connected: state.connected,
      lastTickAt: state.lastTickAt,
      ageMs: state.lastTickAt ? now - state.lastTickAt : null,
      lastError: state.lastError,
      required: requiredFeeds.has(name),
      maxStaleMs: requiredFeeds.get(name)?.maxStaleMs ?? null,
    };
  }
  return {
    status: 'ok',
    uptime_s: Math.floor((now - startedAt) / 1000),
    engine_env: process.env.ENGINE_ENV || 'dev',
    writer_tag: process.env.WRITER_TAG || 'delayed_test',
    feeds: feedSnap,
  };
}
