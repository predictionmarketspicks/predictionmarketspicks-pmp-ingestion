// Per-feed liveness state. Each feed module updates its own slot via setFeedStatus().
// /health endpoint reads the snapshot.

const startedAt = Date.now();

const feeds = new Map();

export function registerFeed(name) {
  if (!feeds.has(name)) {
    feeds.set(name, { name, connected: false, lastTickAt: null, lastError: null });
  }
}

export function setFeedStatus(name, patch) {
  const prev = feeds.get(name) || { name, connected: false, lastTickAt: null, lastError: null };
  feeds.set(name, { ...prev, ...patch });
}

export function recordTick(name) {
  setFeedStatus(name, { lastTickAt: Date.now() });
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
