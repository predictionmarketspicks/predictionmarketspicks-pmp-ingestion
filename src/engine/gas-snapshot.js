// Oracle Gas Edge snapshot engine — runs fetchAllGasStrikes through the
// kalshi_gas_strikes writer on a 5min/15min market-hours/off-hours timer.
// Sibling to engine/polymarket-snapshot.js; same control flow, same
// observability hooks.
//
// Cadence is anchored to isOptionsMarketOpen() — Kalshi gas action concentrates
// around US daytime news flow (RBOB, refinery outages, AAA's morning print).
// Late-evening polling stays at 15min so we don't burn calls on overnight
// quote-stillness.
//
// Tighter pre-close burst (e.g. 60s in the last hour before 11:59 PM ET) is
// intentionally NOT in this phase — the dashboard's 5min envelope freshness
// is good enough and we keep the cadence symmetric across commodities until
// the calibration data justifies a special case.

import { fetchAllGasStrikes } from '../feeds/kalshi-gas.js';
import { insertKalshiGasStrikes } from '../delivery/supabase.js';
import { isOptionsMarketOpen } from '../feeds/massive.js';
import { recordTick, registerFeed } from '../observability/health.js';

const SNAPSHOT_INTERVAL_MARKET_MS = Number(
  process.env.GAS_SNAPSHOT_INTERVAL_MARKET_MS || 5 * 60 * 1000,
);
const SNAPSHOT_INTERVAL_OFF_MS = Number(
  process.env.GAS_SNAPSHOT_INTERVAL_OFF_MS || 15 * 60 * 1000,
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
  const delay = isOptionsMarketOpen() ? SNAPSHOT_INTERVAL_MARKET_MS : SNAPSHOT_INTERVAL_OFF_MS;
  state.scanTimer = setTimeout(async () => {
    try {
      await runGasSnapshotOnce();
    } catch {
      /* runGasSnapshotOnce already logged */
    }
    scheduleGasSnapshot();
  }, delay);
}

export function bootstrapGasSnapshot() {
  // Wait briefly so Kalshi WS + commodity engines settle before the first REST
  // burst. 25s lands after macro (15s) and polymarket-snapshot (20s) so the
  // outbound bursts don't stack.
  setTimeout(() => {
    runGasSnapshotOnce().catch(() => {});
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
