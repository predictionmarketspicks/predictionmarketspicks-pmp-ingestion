// Oracle Gas Edge snapshot engine — runs fetchAllGasStrikes through the
// kalshi_gas_strikes writer only inside the AAA gas settlement window
// (23:50–00:05 ET). Outside the window the loop wakes every 5 min and idles
// without writing. See isInGasWindow() below.
//
// 2026-05-15: kalshi_gas_strikes has zero read consumers — Oracle Gas Edge's
// settle + logger pipelines read from commodity_edge_signals. We keep this
// thin window sample for future analytics; if a real consumer ever lands,
// revisit the cadence.

import { fetchAllGasStrikes } from '../feeds/kalshi-gas.js';
import { insertKalshiGasStrikes } from '../delivery/supabase.js';
import { recordTick, registerFeed } from '../observability/health.js';

// 2026-05-15: dropped from 5min/15min always-on to window-only.
// kalshi_gas_strikes has zero readers in lib/, app/, or any edge fn — Oracle
// Gas Edge settle/logger use commodity_edge_signals. We keep a thin sample
// purely for future analytics:
//   - SETTLEMENT WINDOW (23:50–00:05 ET): sample every 60s to capture print
//   - OUTSIDE WINDOW: idle (no writes)
// If the gas table ever gets a real-time read consumer, revisit this.
// See handoffs/done/STORAGE_CLEANUP_2026-05-15.md.
const GAS_WINDOW_INTERVAL_MS = Number(
  process.env.GAS_WINDOW_INTERVAL_MS || 60 * 1000,
);
const GAS_OUTSIDE_CHECK_MS = Number(
  process.env.GAS_OUTSIDE_CHECK_MS || 5 * 60 * 1000,
);

// 23:50 ET → 04:50 UTC. 00:05 ET → 05:05 UTC. Window straddles UTC midnight
// only in daylight savings; using ET-aware check avoids surprises.
function isInGasWindow(now = new Date()) {
  // Convert to ET via en-US format with timeZone option. Robust to DST.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const hh = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const mm = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const minutes = hh * 60 + mm;
  // 23:50 = 1430 min; 00:05 = 5 min. Window wraps midnight.
  return minutes >= 23 * 60 + 50 || minutes <= 5;
}

const state = {
  scans: 0,
  rowsWritten: 0,
  lastRunAt: null,
  lastErrorAt: null,
  lastError: null,
  scanTimer: null,
};

let stopRequested = false;

registerFeed('gas_engine');

export async function runGasSnapshotOnce() {
  state.scans += 1;
  state.lastRunAt = new Date().toISOString();
  try {
    const rows = await fetchAllGasStrikes();
    if (rows.length === 0) {
      // No open gas markets — happens briefly between contract rolls and on
      // weekends-of-rare-roll. Log so a multi-day quiet stretch is visible.
      console.warn('[gas-snapshot] fetched 0 rows — no open KXAAAGASD/KXAAAGASM markets');
      recordTick('gas_engine');
      return { rowsFetched: 0, rowsWritten: 0 };
    }
    const captured_at = new Date().toISOString();
    const stamped = rows.map((r) => ({ ...r, captured_at }));
    const { count } = await insertKalshiGasStrikes(stamped);
    state.rowsWritten += count;
    recordTick('gas_engine');
    console.log(`[gas-snapshot] wrote ${count} rows (fetched ${rows.length})`);
    return { rowsFetched: rows.length, rowsWritten: count };
  } catch (err) {
    state.lastErrorAt = new Date().toISOString();
    state.lastError = (err?.message || String(err)).slice(0, 240);
    console.error('[gas-snapshot] failed', err?.message || err);
    throw err;
  }
}

function scheduleGasSnapshot() {
  if (stopRequested) return;
  const inWindow = isInGasWindow();
  const delay = inWindow ? GAS_WINDOW_INTERVAL_MS : GAS_OUTSIDE_CHECK_MS;
  state.scanTimer = setTimeout(async () => {
    if (isInGasWindow()) {
      try {
        await runGasSnapshotOnce();
      } catch {
        /* runGasSnapshotOnce already logged */
      }
    }
    // Outside the window we just wake up every 5 min to re-check; no write.
    scheduleGasSnapshot();
  }, delay);
}

export function bootstrapGasSnapshot() {
  // Wait briefly so Kalshi WS + commodity engines settle before the first REST
  // burst. 25s lands after macro (15s) and polymarket-snapshot (20s) so the
  // outbound bursts don't stack. The first run only writes if we boot inside
  // the 23:50–00:05 ET settlement window — otherwise scheduleGasSnapshot()
  // sleeps until the next window.
  setTimeout(() => {
    if (isInGasWindow()) {
      runGasSnapshotOnce().catch(() => {});
    }
    scheduleGasSnapshot();
  }, 25_000);
}

export function stopGasSnapshot() {
  stopRequested = true;
  if (state.scanTimer) {
    clearTimeout(state.scanTimer);
    state.scanTimer = null;
  }
}

export function getGasSnapshotState() {
  return {
    scans: state.scans,
    rowsWritten: state.rowsWritten,
    lastRunAt: state.lastRunAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
  };
}
