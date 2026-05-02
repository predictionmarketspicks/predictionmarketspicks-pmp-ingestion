import 'dotenv/config';
import http from 'node:http';

import { initSentry, Sentry } from './observability/sentry.js';
import { snapshot, registerFeed, recordTick } from './observability/health.js';
import { startKalshi, stopKalshi } from './feeds/kalshi.js';
import { startPyth, stopAllPyth, FEED_IDS as PYTH_FEED_IDS } from './feeds/pyth.js';
import { startMassivePoller, stopAllMassivePollers, isOptionsMarketOpen } from './feeds/massive.js';
import { computeSnapshot, discoverEvent } from './engine/commodity-base.js';
import { listAllCommodities, listEnabledCommodities } from './engine/commodities.js';
import { upsertCommodityEdgeRows } from './delivery/supabase.js';
import { postCommodityAlert } from './delivery/discord.js';
import { revalidateCommodityEdge } from './delivery/revalidate.js';

initSentry();

const PORT = Number(process.env.PORT || 8080);
const ENGINE_ENV = process.env.ENGINE_ENV || 'dev';

// --- engine state ---
//
// Each enabled commodity gets its own EngineState row. Errors stay scoped to
// the failing engine — one bad Kalshi event fetch on copper doesn't kill the
// silver loop. ETF chains, Pyth feeds, and Kalshi events are independent.

class EngineState {
  constructor(config) {
    this.config = config;
    this.currentEvent = null;
    this.expirationDateRef = { value: null };
    this.snapshotTimer = null;
    this.eventRefreshTimer = null;
    this.lastSnapshotMeta = null;
    this.lastSnapshotErrAt = null;
    this.snapshotCount = 0;
  }
}

const engines = new Map();
let stopRequested = false;

const enabledCommodities = listEnabledCommodities();
for (const config of enabledCommodities) {
  engines.set(config.commodity, new EngineState(config));
  registerFeed(`massive_${config.underlyingEtf.toLowerCase()}`);
  registerFeed(`pyth_${config.pythSymbol.replace(/[/]/g, '_').toLowerCase()}`);
  registerFeed(`${config.commodity}_engine`);
}
registerFeed('kalshi');

function expirationDateFromCloseTime(closeIso) {
  return new Date(closeIso).toISOString().slice(0, 10);
}

async function refreshEvent(state) {
  const { config } = state;
  try {
    const ev = await discoverEvent(config);
    if (!ev) {
      console.warn(`[${config.commodity}] no open ${config.seriesTicker} event — likely weekend; will retry`);
      state.currentEvent = null;
      return;
    }
    const newExpiration = expirationDateFromCloseTime(ev.closeTime);
    if (!state.currentEvent || state.currentEvent.eventTicker !== ev.eventTicker) {
      console.log(`[${config.commodity}] event → ${ev.eventTicker} closes ${ev.closeTime} (${ev.markets.length} strikes)`);
    }
    state.currentEvent = ev;
    state.expirationDateRef.value = newExpiration;
  } catch (err) {
    console.error(`[${config.commodity}] event refresh failed`, err?.message || err);
    Sentry.captureException(err);
  }
}

async function runSnapshotOnce(state) {
  const { config } = state;
  if (!state.currentEvent) {
    console.warn(`[${config.commodity}] no event — skipping snapshot`);
    return;
  }
  try {
    const snap = await computeSnapshot(config, state.currentEvent);
    if (!snap) {
      // commodity-base logs the specific reason (missing pyth, missing chain, etc.)
      return;
    }
    state.snapshotCount += 1;
    state.lastSnapshotMeta = snap.meta;
    recordTick(`${config.commodity}_engine`);

    const { count, tag } = await upsertCommodityEdgeRows(snap.rows);
    const top = snap.meta.topEdge;
    const topStr = top
      ? `top=${top.direction} $${top.strike.toFixed(2)} ${(top.edge_pp * 100).toFixed(1)}pp ${snap.meta.topTier}`
      : 'top=NO_EDGE';
    console.log(`[${config.commodity}] snapshot: ${count} rows tag=${tag} • ${topStr} • spot=$${snap.meta.spotPrice.toFixed(2)}`);

    // Discord + revalidate are gated on writer_tag — `delayed_test` rows are
    // 15-min stale (Massive bridge-week tier), users shouldn't see them in
    // #premium-alerts/#oracle-picks any more than they should see them on the
    // tool pages. After Mon/Tue real-time provisioning the operator flips
    // WRITER_TAG=intraday and both Discord and the pages light up at once.
    if (top && snap.meta.topTier !== 'NO_EDGE' && (tag === 'intraday' || tag === 'daily')) {
      try {
        const sent = await postCommodityAlert(snap.meta);
        if (sent) console.log(`[${config.commodity}] discord posted ${snap.meta.topTier}`);
      } catch (err) {
        console.error(`[${config.commodity}] discord post failed`, err?.message || err);
        Sentry.captureException(err);
      }
    } else if (top && snap.meta.topTier !== 'NO_EDGE') {
      console.log(`[${config.commodity}] would post discord ${snap.meta.topTier} (gated by writer_tag=${tag})`);
    }

    if (tag === 'intraday' || tag === 'daily') {
      revalidateCommodityEdge(config.commodity)
        .then((r) => console.log(`[${config.commodity}] revalidate strategy=${r.strategy} ok=${r.ok}`))
        .catch((err) => console.warn(`[${config.commodity}] revalidate threw`, err?.message || err));
    }
  } catch (err) {
    state.lastSnapshotErrAt = new Date().toISOString();
    console.error(`[${config.commodity}] snapshot failed`, err?.message || err);
    Sentry.captureException(err);
  }
}

function scheduleSnapshot(state) {
  if (stopRequested) return;
  const { config } = state;
  const delay = isOptionsMarketOpen()
    ? config.snapshotIntervalMarketMs
    : config.snapshotIntervalOffMs;
  state.snapshotTimer = setTimeout(async () => {
    await runSnapshotOnce(state);
    scheduleSnapshot(state);
  }, delay);
}

async function bootstrapEngine(state) {
  await refreshEvent(state);
  startMassivePoller(state.config.underlyingEtf, state.expirationDateRef);
  // Wait briefly so feeds have data on the first snapshot.
  setTimeout(async () => {
    await runSnapshotOnce(state);
    scheduleSnapshot(state);
  }, 8_000);
  state.eventRefreshTimer = setInterval(() => refreshEvent(state), 30 * 60 * 1000);
}

async function bootstrapAll() {
  // Pyth: dedupe symbols across enabled commodities, skip those without a
  // verified feed ID (the poller logs a warning and the engine fails open).
  const pythSymbols = Array.from(
    new Set(enabledCommodities.map((c) => c.pythSymbol).filter((s) => PYTH_FEED_IDS[s])),
  );
  startPyth(pythSymbols);
  for (const state of engines.values()) {
    bootstrapEngine(state).catch((err) => {
      console.error(`[${state.config.commodity}] bootstrap failed`, err);
      Sentry.captureException(err);
    });
  }
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    const snap = snapshot();
    snap.engine = {
      env: ENGINE_ENV,
      commodities: {},
    };
    for (const [name, state] of engines) {
      snap.engine.commodities[name] = {
        snapshotCount: state.snapshotCount,
        lastSnapshotErrAt: state.lastSnapshotErrAt,
        currentEvent: state.currentEvent?.eventTicker || null,
        lastSnapshot: state.lastSnapshotMeta
          ? {
              generatedAt: state.lastSnapshotMeta.generatedAt,
              spotPrice: state.lastSnapshotMeta.spotPrice,
              etfPrice: state.lastSnapshotMeta.etfPrice,
              topTier: state.lastSnapshotMeta.topTier,
              topTierInt: state.lastSnapshotMeta.topTierInt,
              strikeCount: state.lastSnapshotMeta.strikeCount,
            }
          : null,
      };
    }
    snap.engine.disabledCommodities = listAllCommodities()
      .filter((c) => !c.enabled)
      .map((c) => c.commodity);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snap));
    return;
  }

  if (url.pathname === '/dev/throw') {
    const err = new Error('dev/throw — deliberate Sentry test capture');
    Sentry.captureException(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'captured', message: err.message }));
    return;
  }

  // Manual trigger for ops debugging — fires one snapshot for the named
  // commodity, returns the result.
  if (url.pathname === '/dev/snapshot') {
    const commodity = url.searchParams.get('commodity') || 'silver';
    const state = engines.get(commodity);
    if (!state) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `unknown or disabled commodity: ${commodity}` }));
      return;
    }
    runSnapshotOnce(state)
      .then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, meta: state.lastSnapshotMeta }));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
});

server.listen(PORT, () => {
  console.log(
    `[http] listening on :${PORT} env=${ENGINE_ENV} writer_tag=${process.env.WRITER_TAG || 'delayed_test'} commodities=${enabledCommodities.map((c) => c.commodity).join(',')}`,
  );
});

startKalshi().catch((err) => {
  console.error('[kalshi] startup failed', err);
  Sentry.captureException(err);
});

bootstrapAll().catch((err) => {
  console.error('[engine] bootstrap failed', err);
  Sentry.captureException(err);
});

// --- shutdown ---

async function shutdown(signal) {
  console.log(`[shutdown] ${signal} received`);
  stopRequested = true;
  for (const state of engines.values()) {
    if (state.snapshotTimer) clearTimeout(state.snapshotTimer);
    if (state.eventRefreshTimer) clearInterval(state.eventRefreshTimer);
  }
  stopKalshi();
  stopAllPyth();
  stopAllMassivePollers();
  server.close(() => {
    console.log('[shutdown] http closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('[shutdown] forced exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  Sentry.captureException(reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  Sentry.captureException(err);
});
