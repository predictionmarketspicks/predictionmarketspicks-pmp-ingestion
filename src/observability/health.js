// Per-feed liveness state. Each feed module updates its own slot via setFeedStatus().
// /health endpoint reads the snapshot and decides 200 vs 503 via evaluateLiveness().
//
// Phase 4 model:
//   - registerFeed(name) is purely descriptive — it makes the feed visible in
//     /health output but doesn't gate readiness.
//   - markFeedRequired(name) opts a feed into the readiness gate. If any
//     required feed is stale beyond the active threshold, /health returns 503
//     and BetterStack pages the operator.
//   - Threshold is 90s during US market hours (9:30 AM – 4 PM ET, Mon–Fri)
//     and 300s off-hours. Polling feeds (massive 5–60s, pyth 10s) clear that
//     bar trivially; WS feeds (kalshi, polymarket) only fail it when the
//     connection has actually died. Quiet markets where no ticks fire still
//     count: that means stale data on the site, which is the thing we want
//     paged on.
//   - 60s post-boot grace window: cold-start before any feed has had a chance
//     to tick must not flap the monitor. The Fly check has a 30s grace_period
//     of its own — this stacks on top.

const startedAt = Date.now();

const feeds = new Map();
const requiredFeeds = new Set();

const MARKET_HOURS_THRESHOLD_MS = 90 * 1000;
const OFF_HOURS_THRESHOLD_MS = 300 * 1000;
const BOOT_GRACE_MS = 60 * 1000;

export function registerFeed(name) {
  if (!feeds.has(name)) {
    feeds.set(name, { name, connected: false, lastTickAt: null, lastError: null });
  }
}

export function markFeedRequired(name) {
  registerFeed(name);
  requiredFeeds.add(name);
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
  for (const name of requiredFeeds) {
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
    if (ageMs > thresholdMs) {
      stale.push({ name, reason: 'stale', ageMs });
    }
  }
  return { healthy: stale.length === 0, inMarketHours, thresholdMs, uptimeMs, grace: false, stale };
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
