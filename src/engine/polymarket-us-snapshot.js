// Polymarket US snapshot engine — writes venue='us' rows on a 15-min timer.
//
// Sibling to engine/polymarket-snapshot.js (the Gamma / international writer);
// same control flow, same observability hooks, same table. The two venues are
// distinguished ONLY by the `venue` column, and every reader on the site is
// CI-gated to state which one it wants.
//
// Cadence: 15 min. The gateway publishes no volume field, so there is no
// "activity" signal to pace against, and the non-sports allowlist is ~1.1k
// markets = 3 paged requests per tick. 15 min keeps that at ~288 requests/day
// while staying fresh enough for a cross-venue read. No rate limit is
// documented and none appeared across a full 8,500-row scan — if 429s show up,
// this is the number to raise first.
//
// Spec: prediction-marketspicks/handoffs/POLYMARKET_US_INGEST_2026-08-04.md

import { fetchUsMarkets } from '../feeds/polymarket-us.js';
import { insertPolymarketSnapshots } from '../delivery/supabase.js';
import { recordTick, registerFeed, markFeedRequired, setFeedStatus } from '../observability/health.js';

const INTERVAL_MS = Number(process.env.POLY_US_SNAPSHOT_INTERVAL_MS || 15 * 60 * 1000);

// Feed is opt-in until it has proven itself in production for a day. Flip
// POLY_US_ENABLED=1 on the Fly app to turn it on; absent the flag the engine
// registers and reports healthy-but-idle rather than writing.
const ENABLED = process.env.POLY_US_ENABLED === '1';

const state = {
  scans: 0,
  rowsWritten: 0,
  lastRunAt: null,
  lastErrorAt: null,
  lastError: null,
  scanTimer: null,
};

let stopRequested = false;

registerFeed('polymarket_us_engine');
// Only REQUIRED when actually enabled — marking a deliberately-off feed as
// required would drive /health degraded for a feature that is switched off on
// purpose. Threshold is generous enough that one failed tick is not an alert,
// tight enough that a silent stall surfaces within two cycles.
// See project_pmp_ingestion_health_threshold.
if (ENABLED) markFeedRequired('polymarket_us_engine', { maxStaleMs: 45 * 60 * 1000 });

export async function runPolymarketUsSnapshotOnce() {
  if (!ENABLED) return { count: 0, skipped: 'POLY_US_ENABLED not set' };
  state.scans += 1;
  state.lastRunAt = new Date().toISOString();
  try {
    const rows = await fetchUsMarkets();

    // Defence in depth. normalizeUsMarket() already guarantees this, but a
    // crossed book is the signature of a broken outcome mapping and that bug
    // is invisible once the rows are in the table — so refuse to write rather
    // than poison the arb engine. Loud beats silent.
    const crossed = rows.filter(
      (r) => r.best_bid != null && r.best_ask != null && r.best_bid > r.best_ask,
    );
    if (crossed.length > 0) {
      throw new Error(
        `refusing to write: ${crossed.length} crossed book(s) — outcome mapping is wrong ` +
          `(e.g. ${crossed[0].condition_id} ${crossed[0].best_bid}/${crossed[0].best_ask})`,
      );
    }

    const { count } = await insertPolymarketSnapshots(rows);
    state.rowsWritten += count;
    recordTick('polymarket_us_engine');
    console.log(`[polymarket-us] wrote ${count} rows (${rows.length} fetched)`);
    return { count };
  } catch (err) {
    state.lastErrorAt = new Date().toISOString();
    state.lastError = err?.message ?? String(err);
    setFeedStatus('polymarket_us_engine', { lastError: state.lastError });
    console.error(`[polymarket-us] scan failed: ${state.lastError}`);
    throw err;
  }
}

function schedule() {
  if (stopRequested) return;
  state.scanTimer = setTimeout(async () => {
    try {
      await runPolymarketUsSnapshotOnce();
    } catch {
      /* already logged */
    }
    schedule();
  }, INTERVAL_MS);
}

export function bootstrapPolymarketUsSnapshot() {
  // 35s — after the macro (15s) and Gamma (20s) bootstraps, so cold start does
  // not stack three outbound REST bursts.
  setTimeout(() => {
    runPolymarketUsSnapshotOnce().catch(() => {});
    schedule();
  }, 35_000);
}

export function stopPolymarketUsSnapshot() {
  stopRequested = true;
  if (state.scanTimer) {
    clearTimeout(state.scanTimer);
    state.scanTimer = null;
  }
}

export function getPolymarketUsSnapshotState() {
  return {
    enabled: ENABLED,
    scans: state.scans,
    rowsWritten: state.rowsWritten,
    lastRunAt: state.lastRunAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
  };
}
