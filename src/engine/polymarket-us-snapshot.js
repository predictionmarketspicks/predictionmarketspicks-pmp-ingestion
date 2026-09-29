// Polymarket US snapshot engine — writes venue='us' rows on a 15-min timer.
//
// Sibling to engine/polymarket-snapshot.js (the Gamma / international writer);
// same control flow, same observability hooks, same table. The two venues are
// distinguished ONLY by the `venue` column, and every reader on the site is
// CI-gated to state which one it wants.
//
// Tick: 15 min. What gets WRITTEN on a tick is decided per market
// (Benny, 2026-09-29 — "keep only what we use"; the feed used to write ~6,000
// rows every tick, ~69% of them election brackets nothing reads):
//
//   1. KEEP  — keepUsMarket(): NFL full-game moneyline/spread/total, NFL
//              futures/awards, politics minus brackets, culture, finance,
//              technology, macro, crypto. Everything else is dropped.
//   2. FETCH — NFL game markets every tick; NFL futures + non-sports hourly
//              (the fetch itself is skipped between hours — server-side
//              filters, see US_QUERIES).
//   3. WRITE — change-only: a kept market is written when best_bid, best_ask
//              or last_trade_price changed since its last write, or when its
//              last write is ≥ 6h old (heartbeat, so a reader can tell a quiet
//              market from a dead feed). And never more often than its cadence:
//              every tick for an NFL game market within 7 days of kickoff,
//              otherwise at most hourly.
//
// The last-written state is in memory, seeded on boot from the latest
// venue='us' row per condition_id inside the heartbeat window.
//
// Spec: prediction-marketspicks/handoffs/POLYMARKET_US_INGEST_2026-08-04.md

import { fetchUsMarkets } from '../feeds/polymarket-us.js';
import { insertPolymarketSnapshots, fetchLatestUsSnapshots } from '../delivery/supabase.js';
import { recordTick, registerFeed, markFeedRequired, setFeedStatus } from '../observability/health.js';

const INTERVAL_MS = Number(process.env.POLY_US_SNAPSHOT_INTERVAL_MS || 15 * 60 * 1000);

export const HOUR_MS = 60 * 60 * 1000;
export const HEARTBEAT_MS = 6 * HOUR_MS;
export const GAME_WINDOW_MS = 7 * 24 * HOUR_MS;
// Timer jitter: a recursive setTimeout tick lands a little after the hour, and
// a seeded snapshot_at is stamped a little after the fetch. A minute of slack
// keeps an hourly market from skipping to the NEXT hour on a few ms.
const SLACK_MS = 60 * 1000;

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
  lastHourlyFetchAt: 0,
  seeded: false,
  seededMarkets: 0,
  lastTick: null,
};

// condition_id → { best_bid, best_ask, last_trade_price, writtenAt (ms) }
const lastWritten = new Map();

const sameNum = (a, b) => {
  const x = a == null ? null : Number(a);
  const y = b == null ? null : Number(b);
  if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) return x === y;
  return Math.abs(x - y) < 1e-9;
};

/** Minimum gap between writes of one market. */
export function cadenceMsFor(entry, now) {
  if (
    entry.kind === 'nfl_game' &&
    entry.kickoffMs != null &&
    entry.kickoffMs - now <= GAME_WINDOW_MS
  ) {
    return 0; // every tick, from 7 days out through kickoff until it closes
  }
  return HOUR_MS;
}

/**
 * Pure write plan. `entries` = [{ row, kind, kickoffMs }] from fetchUsMarkets;
 * `last` = the condition_id → last-written map. Does NOT mutate `last`.
 */
export function planUsWrites(entries, last, { now = Date.now() } = {}) {
  const toWrite = [];
  let skippedUnchanged = 0;
  let skippedCadence = 0;
  for (const e of entries) {
    const prev = last.get(e.row.condition_id);
    if (!prev) {
      toWrite.push(e.row);
      continue;
    }
    const elapsed = now - prev.writtenAt;
    if (elapsed < cadenceMsFor(e, now) - SLACK_MS) {
      skippedCadence += 1;
      continue;
    }
    const changed =
      !sameNum(prev.best_bid, e.row.best_bid) ||
      !sameNum(prev.best_ask, e.row.best_ask) ||
      !sameNum(prev.last_trade_price, e.row.last_trade_price);
    if (changed || elapsed >= HEARTBEAT_MS - SLACK_MS) {
      toWrite.push(e.row);
    } else {
      skippedUnchanged += 1;
    }
  }
  return { toWrite, skippedUnchanged, skippedCadence };
}

/** Record rows as written at `now` (after the insert succeeded). */
export function markWritten(last, rows, now) {
  for (const r of rows) {
    last.set(r.condition_id, {
      best_bid: r.best_bid,
      best_ask: r.best_ask,
      last_trade_price: r.last_trade_price,
      writtenAt: now,
    });
  }
}

/** Build the last-written map from seed rows ({condition_id, …, snapshot_at}). */
export function seedLastWritten(last, seedRows) {
  let n = 0;
  for (const r of seedRows) {
    const t = Date.parse(r.snapshot_at);
    if (!r.condition_id || !Number.isFinite(t)) continue;
    const prev = last.get(r.condition_id);
    if (prev && prev.writtenAt >= t) continue;
    last.set(r.condition_id, {
      best_bid: r.best_bid,
      best_ask: r.best_ask,
      last_trade_price: r.last_trade_price,
      writtenAt: t,
    });
    n += 1;
  }
  return n;
}

async function seedOnce() {
  if (state.seeded) return;
  state.seeded = true; // one attempt per boot — a failed seed degrades to "write everything once"
  try {
    const sinceIso = new Date(Date.now() - HEARTBEAT_MS).toISOString();
    const { latest, scanned } = await fetchLatestUsSnapshots({ sinceIso });
    state.seededMarkets = seedLastWritten(lastWritten, latest.values());
    console.log(`[polymarket-us] seeded ${state.seededMarkets} markets from ${scanned} rows since ${sinceIso}`);
  } catch (err) {
    console.error(`[polymarket-us] seed failed, writing every kept market once: ${err?.message ?? err}`);
  }
}

let stopRequested = false;

registerFeed('polymarket_us_engine');
// Only REQUIRED when actually enabled — marking a deliberately-off feed as
// required would drive /health degraded for a feature that is switched off on
// purpose. Threshold is generous enough that one failed tick is not an alert,
// tight enough that a silent stall surfaces within two cycles.
// See project_pmp_ingestion_health_threshold.
if (ENABLED) markFeedRequired('polymarket_us_engine', { maxStaleMs: 45 * 60 * 1000 });

export async function runPolymarketUsSnapshotOnce({ now = Date.now() } = {}) {
  if (!ENABLED) return { count: 0, skipped: 'POLY_US_ENABLED not set' };
  state.scans += 1;
  state.lastRunAt = new Date(now).toISOString();
  try {
    await seedOnce();

    const hourlyDue = now - state.lastHourlyFetchAt >= HOUR_MS - SLACK_MS;
    const groups = hourlyDue ? ['nfl_games', 'nfl_futures', 'non_sports'] : ['nfl_games'];
    const { entries, stats } = await fetchUsMarkets({ groups });
    const rows = entries.map((e) => e.row);

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

    const plan = planUsWrites(entries, lastWritten, { now });
    const { count } = await insertPolymarketSnapshots(plan.toWrite);
    markWritten(lastWritten, plan.toWrite, now);
    if (hourlyDue) state.lastHourlyFetchAt = now;

    state.rowsWritten += count;
    state.lastTick = {
      at: new Date(now).toISOString(),
      groups,
      fetched: stats.fetched,
      kept: stats.kept,
      dropped: stats.dropped,
      unnormalizable: stats.unnormalizable,
      written: count,
      skippedUnchanged: plan.skippedUnchanged,
      skippedCadence: plan.skippedCadence,
    };
    recordTick('polymarket_us_engine');
    const dropped = Object.entries(stats.dropped)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(
      `[polymarket-us] groups=${groups.join(',')} fetched=${stats.fetched} kept=${stats.kept} ` +
        `dropped{${dropped}} unnormalizable=${stats.unnormalizable} written=${count} ` +
        `skipped_unchanged=${plan.skippedUnchanged} skipped_cadence=${plan.skippedCadence}`,
    );
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
    seededMarkets: state.seededMarkets,
    trackedMarkets: lastWritten.size,
    lastTick: state.lastTick,
  };
}
