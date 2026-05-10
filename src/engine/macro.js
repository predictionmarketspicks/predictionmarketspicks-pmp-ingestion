// Macro market snapshot engine — runs the 22-series Kalshi watchlist through
// fetchAllMacroMarkets and writes the result to macro_market_snapshots on a
// timer.
//
// Cadence (handoff §2.2): 5 min during US market hours, 15 min off-hours.
// Same isOptionsMarketOpen() approximation the Massive poller uses — close
// enough to "high activity" for our purposes; Kalshi macro books warm and
// cool with US equities + econ release windows.
//
// Phase notes: this writer's only consumer (post-Session-3) is the site's
// discord-market-movers + oracle-refresh + tweet-daily-pick, which today hit
// Kalshi REST directly. Until those are migrated, this table is a parallel
// stream — extra Kalshi calls but identical answers.

import { fetchAllMacroMarkets } from '../feeds/kalshi-macro.js';
import { insertMacroSnapshots } from '../delivery/supabase.js';
import { isOptionsMarketOpen } from '../feeds/massive.js';
import { recordTick, registerFeed } from '../observability/health.js';
import { deriveKalshiTailCandidates, writeTailCandidatesFromBatch } from './tail-edge.js';

const SNAPSHOT_INTERVAL_MARKET_MS = Number(
  process.env.MACRO_INTERVAL_MARKET_MS || 5 * 60 * 1000,
);
const SNAPSHOT_INTERVAL_OFF_MS = Number(
  process.env.MACRO_INTERVAL_OFF_MS || 15 * 60 * 1000,
);

const state = {
  scans: 0,
  rowsWritten: 0,
  lastRunAt: null,
  lastErrorAt: null,
  lastError: null,
  scanTimer: null,
};

let stopRequested = false;

registerFeed('macro_engine');

export async function runMacroSnapshotOnce() {
  state.scans += 1;
  state.lastRunAt = new Date().toISOString();
  try {
    const rows = await fetchAllMacroMarkets();
    if (rows.length === 0) {
      console.warn('[macro] fetched 0 rows — Kalshi REST returned nothing for all 22 series');
      return { rowsFetched: 0, rowsWritten: 0 };
    }
    const { count } = await insertMacroSnapshots(rows);
    state.rowsWritten += count;
    recordTick('macro_engine');
    console.log(`[macro] snapshot wrote ${count} rows across ${rows.length} markets`);
    // Tail-side write is fire-and-forget — never blocks the primary snapshot.
    // The function logs+swallows its own errors; we don't await failure-cost.
    await writeTailCandidatesFromBatch(rows, deriveKalshiTailCandidates, 'kalshi-macro');
    return { rowsFetched: rows.length, rowsWritten: count };
  } catch (err) {
    state.lastErrorAt = new Date().toISOString();
    state.lastError = (err?.message || String(err)).slice(0, 240);
    console.error('[macro] snapshot failed', err?.message || err);
    throw err;
  }
}

function scheduleMacro() {
  if (stopRequested) return;
  const delay = isOptionsMarketOpen() ? SNAPSHOT_INTERVAL_MARKET_MS : SNAPSHOT_INTERVAL_OFF_MS;
  state.scanTimer = setTimeout(async () => {
    try {
      await runMacroSnapshotOnce();
    } catch {
      /* runMacroSnapshotOnce already logged */
    }
    scheduleMacro();
  }, delay);
}

export function bootstrapMacro() {
  // Wait briefly so other engines settle before the first 22-series REST burst.
  // 15s is enough to avoid racing the kalshi/polymarket/pyth bootstrap logs and
  // to let the process steady-state before the first network call.
  setTimeout(() => {
    runMacroSnapshotOnce().catch(() => {});
    scheduleMacro();
  }, 15_000);
}

export function stopMacro() {
  stopRequested = true;
  if (state.scanTimer) {
    clearTimeout(state.scanTimer);
    state.scanTimer = null;
  }
}

export function getMacroState() {
  return {
    scans: state.scans,
    rowsWritten: state.rowsWritten,
    lastRunAt: state.lastRunAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
  };
}
