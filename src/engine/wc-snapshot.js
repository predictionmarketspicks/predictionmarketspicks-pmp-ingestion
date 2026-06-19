// World Cup 2026 snapshot engine.
//
// Runs the four WC feeds (Kalshi, Polymarket, Odds-API DK, ESPN) on a 30min
// cadence and writes market rows to world_cup_market_snapshot. ESPN game
// state is held in-memory only; PR 4 consumes it for mispricing gating.
//
// Cadence: fixed 30min. WC markets run 24/7 once the tournament starts and
// outright/futures markets move slowly pre-tournament. No US-market-hours
// gate (the Massive isOptionsMarketOpen() approximation other engines use
// doesn't fit here).
//
// Failure model: each feed throws independently and the engine logs &
// continues. A single bad fetch is acceptable; the next 30min tick fills in.

import { fetchWcKalshiRows } from '../feeds/wc-kalshi.js';
import { fetchWcPolymarketRows } from '../feeds/wc-polymarket.js';
// DraftKings (The Odds API) feed killed 2026-06-07 — its champion outrights were
// a corrupt non-champion market (Σ implied ≈ 753%, longshots ranked as favorites)
// and it burned the shared Odds API quota. WC is Kalshi↔Polymarket-only.
import { fetchWcEspnGames } from '../feeds/wc-espn.js';
import { insertWorldCupMarketSnapshots, refreshWcMarketMatviews } from '../delivery/supabase.js';
import { recordTick, registerFeed } from '../observability/health.js';
import { runWcMispricingsOnce, getWcMispricingsState } from './wc-mispricings.js';
import { runWcPayloadsOnce, getWcPayloadsState } from './wc-payloads.js';
import { persistWcFtResults, dispatchSimRerun } from './wc-results-writer.js';

const SNAPSHOT_INTERVAL_MS = Number(process.env.WC_SNAPSHOT_INTERVAL_MS || 30 * 60 * 1000);
const BOOTSTRAP_DELAY_MS = Number(process.env.WC_BOOTSTRAP_DELAY_MS || 30_000);

const state = {
  scans: 0,
  rowsWritten: 0,
  lastRunAt: null,
  lastErrorAt: null,
  lastError: null,
  scanTimer: null,
  // Last ESPN snapshot kept here so /health and PR 4 mispricing can read it
  // without re-fetching. Refresh cadence matches the writer (30min).
  espnGames: [],
  espnUpdatedAt: null,
  // Result autofeed — last time we persisted FT rows + which matches were
  // newly settled on that scan (surfaced via /health).
  lastResultWriteAt: null,
  lastNewlySettled: [],
  perFeed: {
    kalshi: { rows: 0, lastError: null },
    polymarket: { rows: 0, lastError: null },
    espn: { games: 0, lastError: null },
  },
};

let stopRequested = false;

registerFeed('wc_engine');

async function runFeed(name, fn) {
  try {
    const result = await fn();
    state.perFeed[name].lastError = null;
    return result;
  } catch (err) {
    const msg = (err?.message || String(err)).slice(0, 240);
    state.perFeed[name].lastError = msg;
    console.error(`[wc-snapshot] ${name} feed failed:`, msg);
    return name === 'espn' ? [] : [];
  }
}

export async function runWcSnapshotOnce() {
  state.scans += 1;
  state.lastRunAt = new Date().toISOString();

  const [kalshiRows, polyRows, espnGames] = await Promise.all([
    runFeed('kalshi', fetchWcKalshiRows),
    runFeed('polymarket', fetchWcPolymarketRows),
    runFeed('espn', fetchWcEspnGames),
  ]);

  state.perFeed.kalshi.rows = kalshiRows.length;
  state.perFeed.polymarket.rows = polyRows.length;
  state.perFeed.espn.games = espnGames.length;
  state.espnGames = espnGames;
  state.espnUpdatedAt = new Date().toISOString();

  // Result autofeed (handoffs/WC_RESULT_AUTOFEED_2026-06-18.md): persist any
  // completed ESPN games to world_cup_results, and fire a sim re-run for
  // newly-settled matches. Non-fatal — a failure here must never block the
  // market snapshot; the next 30-min scan retries the idempotent upsert.
  try {
    const resultWrite = await persistWcFtResults(espnGames);
    state.lastResultWriteAt = new Date().toISOString();
    state.lastNewlySettled = resultWrite.newlySettled;
    if (resultWrite.newlySettled.length) {
      console.log(`[wc-snapshot] newly-settled FT: ${resultWrite.newlySettled.join(', ')}`);
      await dispatchSimRerun(resultWrite.newlySettled);
    }
  } catch (err) {
    console.error('[wc-snapshot] result persist failed:', err?.message || err);
  }

  const allRows = [...kalshiRows, ...polyRows];

  if (allRows.length === 0) {
    recordTick('wc_engine');
    console.warn('[wc-snapshot] zero market rows produced — Kalshi and Polymarket returned nothing parseable');
    return { rowsFetched: 0, rowsWritten: 0, espnGames: espnGames.length };
  }

  let writeResult;
  try {
    const { count } = await insertWorldCupMarketSnapshots(allRows);
    state.rowsWritten += count;
    writeResult = { rowsFetched: allRows.length, rowsWritten: count, espnGames: espnGames.length };
    recordTick('wc_engine');
    console.log(
      `[wc-snapshot] wrote ${count} rows (kalshi=${kalshiRows.length} poly=${polyRows.length} espn=${espnGames.length})`,
    );
  } catch (err) {
    state.lastErrorAt = new Date().toISOString();
    state.lastError = (err?.message || String(err)).slice(0, 240);
    console.error('[wc-snapshot] write failed:', err?.message || err);
    throw err;
  }

  // Refresh world_cup_market_latest before the mispricing engine joins
  // against it. Refresh failure is non-fatal — the mispricing engine logs and
  // proceeds against whatever the matview last held; next 30min tick retries.
  try {
    await refreshWcMarketMatviews();
  } catch (err) {
    console.warn('[wc-snapshot] matview refresh failed:', err?.message || err);
  }

  // PR 4 — fire mispricing engine in the same tick. Errors are caught and
  // logged inside runWcMispricingsOnce() so a single bad run doesn't block
  // the next snapshot.
  try {
    const mp = await runWcMispricingsOnce();
    writeResult.mispricings = mp;
  } catch (err) {
    console.error('[wc-snapshot] mispricing run threw:', err?.message || err);
  }

  // PR 5 — write V2 widget payloads (world-cup-2026 + wc-mispricings).
  // Reads sim_latest × market_latest × mispricings_latest fresh; never blocks
  // the orchestrator on a payload-write failure.
  try {
    const pl = await runWcPayloadsOnce();
    writeResult.payloads = pl;
  } catch (err) {
    console.error('[wc-snapshot] payload write threw:', err?.message || err);
  }

  return writeResult;
}

function scheduleWc() {
  if (stopRequested) return;
  state.scanTimer = setTimeout(async () => {
    try {
      await runWcSnapshotOnce();
    } catch {
      /* runWcSnapshotOnce already logged */
    }
    scheduleWc();
  }, SNAPSHOT_INTERVAL_MS);
}

export function bootstrapWcSnapshot() {
  // Wait briefly so the rest of the process settles before the first burst.
  // Stacks after macro (15s) and polymarket-snapshot (20s).
  setTimeout(() => {
    runWcSnapshotOnce().catch(() => {});
    scheduleWc();
  }, BOOTSTRAP_DELAY_MS);
}

export function stopWcSnapshot() {
  stopRequested = true;
  if (state.scanTimer) {
    clearTimeout(state.scanTimer);
    state.scanTimer = null;
  }
}

export function getWcSnapshotState() {
  return {
    scans: state.scans,
    rowsWritten: state.rowsWritten,
    lastRunAt: state.lastRunAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
    lastResultWriteAt: state.lastResultWriteAt,
    lastNewlySettled: state.lastNewlySettled,
    perFeed: state.perFeed,
  };
}

// Read-only view for PR 4 mispricing — latest ESPN scoreboard snapshot.
export function getWcEspnGames() {
  return { games: state.espnGames, updatedAt: state.espnUpdatedAt };
}

// Re-export PR 4 state so /health exposes wc_mispricings alongside wc_snapshot
// without index.js needing a direct import from wc-mispricings.js.
export { getWcMispricingsState };

// Re-export PR 5 state for /health visibility.
export { getWcPayloadsState, runWcPayloadsOnce };
