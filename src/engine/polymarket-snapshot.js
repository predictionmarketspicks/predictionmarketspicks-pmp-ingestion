// Polymarket Gamma snapshot engine — runs fetchTopMarkets through the writer
// on a 5min/15min market-hours/off-hours timer. Sibling to engine/macro.js;
// same control flow, same observability hooks.
//
// The handoff (POLYMARKET_FLY_MIGRATION_PLAN.md §2.1) anchors the cadence to
// US market hours via isOptionsMarketOpen() — the same approximation the
// Massive poller and macro engine use. Polymarket markets warm and cool with
// US news/event windows, so the same gate fits.
//
// Phase notes: this writer's consumers (the 22 callers from §1) still hit
// Gamma directly today. Until Sessions B–D migrate them, this table is a
// parallel stream — extra Gamma calls but identical answers, with a stable
// row shape that the downstream callers can switch onto one PR at a time.

import {
  fetchTopMarkets,
  fetchSportsGameMarkets,
  fetchTaggedMarkets,
  POLY_CRYPTO_TAG_ID,
  POLY_MACRO_TAG_ID,
} from '../feeds/polymarket-gamma.js';
import { insertPolymarketSnapshots } from '../delivery/supabase.js';
import { isOptionsMarketOpen } from '../feeds/massive.js';
import { recordTick, registerFeed } from '../observability/health.js';
import { derivePolymarketTailCandidates, writeTailCandidatesFromBatch } from './tail-edge.js';

// 2026-05-15: dropped from 5min/15min → hourly. 150 runs/day was overkill for
// data Polymarket itself only refreshes on trade activity. Hourly + the
// curated allowlist in polymarket-gamma.js = ~24 runs × ~60 slugs ≈ 1.4k
// rows/day vs 30k/day. See handoffs/done/STORAGE_CLEANUP_2026-05-15.md.
const SNAPSHOT_INTERVAL_MARKET_MS = Number(
  process.env.POLY_SNAPSHOT_INTERVAL_MARKET_MS || 60 * 60 * 1000,
);
const SNAPSHOT_INTERVAL_OFF_MS = Number(
  process.env.POLY_SNAPSHOT_INTERVAL_OFF_MS || 60 * 60 * 1000,
);
const SNAPSHOT_LIMIT = Number(process.env.POLY_SNAPSHOT_LIMIT || 80);

const state = {
  scans: 0,
  rowsWritten: 0,
  lastRunAt: null,
  lastErrorAt: null,
  lastError: null,
  scanTimer: null,
};

let stopRequested = false;

registerFeed('polymarket_engine');

export async function runPolymarketSnapshotOnce() {
  state.scans += 1;
  state.lastRunAt = new Date().toISOString();
  try {
    // Four pulls, unioned + deduped by condition_id (top-N wins ties — identical
    // row either way):
    //   1. global top-N by 24h volume,
    //   2. the full daily game slate for arb leagues (dropped by the top-N cut),
    //   3. crypto tag, 4. macro/economy tag — both ranked WITHIN their tag, since
    //      the politics-dominated global top-N otherwise starves them.
    // Every pull except the primary top-N is fail-soft: a Gamma hiccup on one
    // must not lose the main scan.
    const failSoft = (name) => (err) => {
      console.warn(`[polymarket-snapshot] ${name} pull failed (continuing):`, err?.message || err);
      return [];
    };
    const [topRows, gameRows, cryptoRows, macroRows] = await Promise.all([
      fetchTopMarkets({ limit: SNAPSHOT_LIMIT }),
      fetchSportsGameMarkets().catch(failSoft('sports-games')),
      fetchTaggedMarkets(POLY_CRYPTO_TAG_ID, { label: 'poly-crypto' }).catch(failSoft('crypto')),
      fetchTaggedMarkets(POLY_MACRO_TAG_ID, { label: 'poly-macro' }).catch(failSoft('macro')),
    ]);
    const byCond = new Map();
    for (const r of [...gameRows, ...cryptoRows, ...macroRows, ...topRows]) {
      if (r?.condition_id) byCond.set(r.condition_id, r);
    }
    const rows = Array.from(byCond.values());
    if (rows.length === 0) {
      console.warn('[polymarket-snapshot] fetched 0 rows — Gamma returned nothing or all dead-tail');
      return { rowsFetched: 0, rowsWritten: 0 };
    }
    console.log(`[polymarket-snapshot] top=${topRows.length} games=${gameRows.length} crypto=${cryptoRows.length} macro=${macroRows.length} union=${rows.length}`);
    const { count } = await insertPolymarketSnapshots(rows);
    state.rowsWritten += count;
    recordTick('polymarket_engine');
    console.log(`[polymarket-snapshot] wrote ${count} rows (fetched ${rows.length})`);
    // Tail-side write is fire-and-forget — never blocks the primary snapshot.
    await writeTailCandidatesFromBatch(rows, derivePolymarketTailCandidates, 'polymarket');
    return { rowsFetched: rows.length, rowsWritten: count };
  } catch (err) {
    state.lastErrorAt = new Date().toISOString();
    state.lastError = (err?.message || String(err)).slice(0, 240);
    console.error('[polymarket-snapshot] failed', err?.message || err);
    throw err;
  }
}

function schedulePolymarketSnapshot() {
  if (stopRequested) return;
  const delay = isOptionsMarketOpen() ? SNAPSHOT_INTERVAL_MARKET_MS : SNAPSHOT_INTERVAL_OFF_MS;
  state.scanTimer = setTimeout(async () => {
    try {
      await runPolymarketSnapshotOnce();
    } catch {
      /* runPolymarketSnapshotOnce already logged */
    }
    schedulePolymarketSnapshot();
  }, delay);
}

export function bootstrapPolymarketSnapshot() {
  // Wait briefly so the rest of the process settles before the first Gamma
  // burst. 20s puts us after the 15s macro engine bootstrap to avoid stacking
  // outbound REST bursts on cold start.
  setTimeout(() => {
    runPolymarketSnapshotOnce().catch(() => {});
    schedulePolymarketSnapshot();
  }, 20_000);
}

export function stopPolymarketSnapshot() {
  stopRequested = true;
  if (state.scanTimer) {
    clearTimeout(state.scanTimer);
    state.scanTimer = null;
  }
}

export function getPolymarketSnapshotState() {
  return {
    scans: state.scans,
    rowsWritten: state.rowsWritten,
    lastRunAt: state.lastRunAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
  };
}
