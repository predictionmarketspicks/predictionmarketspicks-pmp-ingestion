import 'dotenv/config';
import http from 'node:http';

import { initSentry, Sentry } from './observability/sentry.js';
import { snapshot, registerFeed, recordTick } from './observability/health.js';
import { startKalshi, stopKalshi } from './feeds/kalshi.js';
import { startPyth, stopAllPyth } from './feeds/pyth.js';
import { startMassivePoller, stopAllMassivePollers, isOptionsMarketOpen } from './feeds/massive.js';
import { discoverSilverEvent, computeSilverSnapshot, SILVER_UNDERLYING_ETF } from './engine/silver.js';
import { upsertCommodityEdgeRows } from './delivery/supabase.js';
import { postSilverAlert } from './delivery/discord.js';
import { revalidateSilverEdge } from './delivery/revalidate.js';
import {
  SILVER_SNAPSHOT_INTERVAL_MARKET_MS,
  SILVER_SNAPSHOT_INTERVAL_OFF_MS,
} from './engine/thresholds.js';

initSentry();

const PORT = Number(process.env.PORT || 8080);
const ENGINE_ENV = process.env.ENGINE_ENV || 'dev';

// --- feed registration (drives /health) ---
registerFeed('kalshi');
registerFeed('massive_slv');
registerFeed('pyth_xag_usd');
registerFeed('silver_engine');

// --- engine orchestration ---
//
// State machine:
//   silver event = soonest-closing open KXSILVERW (refreshed every 30 min)
//   massive poller = SLV chain scoped to that event's expiration_date
//   snapshot loop = every 5 min market-hours / 30 min off-hours, computes
//     edges, writes to commodity_edge_signals, fires Discord on tier cross,
//     pings revalidate.
//
// The expirationDateRef indirection lets the Massive poller keep its closure
// fresh as the event rolls week-over-week without restart.

let currentEvent = null;
const expirationDateRef = { value: null }; // mutated when event refreshes
let snapshotTimer = null;
let eventRefreshTimer = null;
let stopRequested = false;

let lastSnapshotMeta = null;
let lastSnapshotErrAt = null;
let snapshotCount = 0;

// Map a Kalshi event's close_time → SLV expiration date the chain should scope to.
// Kalshi silver weeklies close Friday 5pm ET; SLV options expire Friday after-hours.
// Both keys are YYYY-MM-DD; same Friday.
function expirationDateFromCloseTime(closeIso) {
  return new Date(closeIso).toISOString().slice(0, 10);
}

async function refreshEvent() {
  try {
    const ev = await discoverSilverEvent();
    if (!ev) {
      console.warn('[engine] no open KXSILVERW event — likely weekend; will retry');
      currentEvent = null;
      return;
    }
    const newExpiration = expirationDateFromCloseTime(ev.closeTime);
    if (!currentEvent || currentEvent.eventTicker !== ev.eventTicker) {
      console.log(`[engine] silver event → ${ev.eventTicker} closes ${ev.closeTime} (${ev.markets.length} strikes)`);
    }
    currentEvent = ev;
    expirationDateRef.value = newExpiration;
  } catch (err) {
    console.error('[engine] event refresh failed', err?.message || err);
    Sentry.captureException(err);
  }
}

async function runSnapshotOnce() {
  if (!currentEvent) {
    console.warn('[engine] no event — skipping snapshot');
    return;
  }
  try {
    const snap = await computeSilverSnapshot(currentEvent);
    if (!snap) {
      console.warn('[engine] snapshot null (cold start: missing pyth/massive data)');
      return;
    }
    snapshotCount += 1;
    lastSnapshotMeta = snap.meta;
    recordTick('silver_engine');

    const { count, tag } = await upsertCommodityEdgeRows(snap.rows);
    const top = snap.meta.topEdge;
    const topStr = top
      ? `top=${top.direction} $${top.strike.toFixed(2)} ${(top.edge_pp * 100).toFixed(1)}pp ${snap.meta.topTier}`
      : 'top=NO_EDGE';
    console.log(`[engine] silver snapshot: ${count} rows tag=${tag} • ${topStr} • spot=$${snap.meta.spotPrice.toFixed(2)}`);

    // Discord + revalidate are both gated on writer_tag — `delayed_test` rows
    // are 15-min stale (Massive bridge-week tier), users shouldn't see them
    // in #premium-alerts/#oracle-picks any more than they should see them on
    // /tools/silver-edge. After Mon/Tue real-time provisioning the operator
    // flips WRITER_TAG=intraday and both Discord and the page light up at once.
    if (top && snap.meta.topTier !== 'NO_EDGE' && (tag === 'intraday' || tag === 'daily')) {
      try {
        const sent = await postSilverAlert(snap.meta);
        if (sent) console.log(`[engine] discord posted ${snap.meta.topTier}`);
      } catch (err) {
        console.error('[engine] discord post failed', err?.message || err);
        Sentry.captureException(err);
      }
    } else if (top && snap.meta.topTier !== 'NO_EDGE') {
      console.log(`[engine] would post discord ${snap.meta.topTier} (gated by writer_tag=${tag})`);
    }

    if (tag === 'intraday' || tag === 'daily') {
      revalidateSilverEdge()
        .then((r) => console.log(`[engine] revalidate strategy=${r.strategy} ok=${r.ok}`))
        .catch((err) => console.warn('[engine] revalidate threw', err?.message || err));
    }
  } catch (err) {
    lastSnapshotErrAt = new Date().toISOString();
    console.error('[engine] snapshot failed', err?.message || err);
    Sentry.captureException(err);
  }
}

function scheduleSnapshot() {
  if (stopRequested) return;
  const delay = isOptionsMarketOpen() ? SILVER_SNAPSHOT_INTERVAL_MARKET_MS : SILVER_SNAPSHOT_INTERVAL_OFF_MS;
  snapshotTimer = setTimeout(async () => {
    await runSnapshotOnce();
    scheduleSnapshot();
  }, delay);
}

async function bootstrapEngine() {
  await refreshEvent();
  startMassivePoller(SILVER_UNDERLYING_ETF, expirationDateRef);
  startPyth(['XAG/USD']);
  // Wait briefly so feeds have data on the first snapshot. 8s is enough for
  // Pyth (10s poll, but immediate on startup) and Massive (immediate poll).
  setTimeout(async () => {
    await runSnapshotOnce();
    scheduleSnapshot();
  }, 8_000);
  // Refresh the Kalshi event every 30 min — picks up new weekly when current
  // one settles, no restart needed.
  eventRefreshTimer = setInterval(refreshEvent, 30 * 60 * 1000);
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    const snap = snapshot();
    snap.engine = {
      env: ENGINE_ENV,
      snapshotCount,
      lastSnapshotErrAt,
      currentEvent: currentEvent?.eventTicker || null,
      lastSnapshot: lastSnapshotMeta
        ? {
            generatedAt: lastSnapshotMeta.generatedAt,
            spotPrice: lastSnapshotMeta.spotPrice,
            etfPrice: lastSnapshotMeta.etfPrice,
            topTier: lastSnapshotMeta.topTier,
            topTierInt: lastSnapshotMeta.topTierInt,
            strikeCount: lastSnapshotMeta.strikeCount,
          }
        : null,
    };
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

  // Manual trigger for ops debugging — fires one snapshot, returns the result.
  if (url.pathname === '/dev/snapshot') {
    runSnapshotOnce()
      .then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, meta: lastSnapshotMeta }));
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
  console.log(`[http] listening on :${PORT} env=${ENGINE_ENV} writer_tag=${process.env.WRITER_TAG || 'delayed_test'}`);
});

startKalshi().catch((err) => {
  console.error('[kalshi] startup failed', err);
  Sentry.captureException(err);
});

bootstrapEngine().catch((err) => {
  console.error('[engine] bootstrap failed', err);
  Sentry.captureException(err);
});

// --- shutdown ---

async function shutdown(signal) {
  console.log(`[shutdown] ${signal} received`);
  stopRequested = true;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  if (eventRefreshTimer) clearInterval(eventRefreshTimer);
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
