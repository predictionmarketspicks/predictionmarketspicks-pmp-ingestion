// Kalshi 15-minute board feed — ONE widget_payloads row, `fifteen-min-open`, holding
// every 15-minute series' live window AND the next one, refreshed every ~15 s.
//
// The site (lib/fifteen-min/kalshi-15m.ts getOpenWindow) reads this row first, so the
// MCP `fifteen_min_board` tool, the /kalshi/15-minute-markets hub and series pages,
// the 10-second live card and the public API all read one board instead of each
// caller re-reading ~20 Kalshi series on its own clock. Before this, the first MCP
// call after a quiet stretch paid those reads itself: 5.3–7.3 s, failing the daily
// MCP tool-quality check four days running
// (handoffs/FIFTEEN_MIN_BOARD_ENGINE_FEED_2026-10-07.md).
//
// This engine only FETCHES AND STORES a whitelisted slice of Kalshi's raw market
// fields. Every piece of market logic (which window is open, mid, spread cap, the
// closed-window guard) stays in the site, so nothing is duplicated across repos.
// Because the next window is stored too, the site's read-time `open_time ≤ now <
// close_time` filter rolls over at :00/:15/:30/:45 with no gap.
//
// ⛔ Never `expiration_value`, `settlement_value` or any `*_value` field: widget_payloads
// is anon-readable, and for crypto the settle print is the CF Benchmarks average
// (OPRA-class, the site's lib/fifteen-min/record.ts SOURCE MASK). SLIM_FIELDS is a
// whitelist for that reason; the settled records stay on the site's own cache.
//
// FIFTEEN_MIN_BOARD_ENABLED=0 switches it off without a redeploy; the row then goes
// stale and the site falls back to reading Kalshi live, i.e. the old behaviour.

import { fetchWindows } from './metals-15m.js';
import { upsertWidgetPayloads } from '../delivery/supabase.js';
import { registerFeed, markFeedRequired, setFeedStatus, recordTick } from '../observability/health.js';

const ENABLED = process.env.FIFTEEN_MIN_BOARD_ENABLED !== '0';

export const SLUG = 'fifteen-min-open';
export const FEED = 'fifteen_min_board_engine';

/**
 * Every NON-DORMANT ticker in the site's lib/fifteen-min/series.ts — that file is the
 * source of truth (20 `live` + 6 `pre-launch` as of 2026-10-07). A series missing here
 * is not an outage: the site reads it live from Kalshi, and the site's
 * scripts/check-fifteen-min-engine-feed.mjs fails the daily MCP check until it is added.
 */
export const FIFTEEN_MIN_BOARD_SERIES = Object.freeze([
  // live
  'KXBTC15M', 'KXGOLD15M', 'KXSILVER15M', 'KXWTI15M',
  'KXETH15M', 'KXXRP15M', 'KXSOL15M', 'KXDOGE15M', 'KXHYPE15M', 'KXZEC15M', 'KXNEAR15M', 'KXBNB15M',
  'KXCRYPTOLEAD15M',
  'KXNATGAS15M', 'KXCOPPER15M', 'KXPLATINUM15M', 'KXPALLADIUM15M',
  'KXEURUSD15M', 'KXGBPUSD15M', 'KXUSDJPY15M',
  // pre-launch
  'KXINX15M', 'KXNDQ15M', 'KX2YRRATE15M', 'KX5YRRATE15M', 'KX10YRRATE15M', 'KX30YRRATE15M',
]);

/**
 * The only market fields written — what the site's pickOpen()/toOpenWindow() read,
 * plus `status`. If toOpenWindow ever reads another field, add it here.
 */
export const SLIM_FIELDS = Object.freeze([
  'ticker', 'event_ticker', 'status', 'open_time', 'close_time', 'floor_strike',
  'yes_bid_dollars', 'yes_ask_dollars', 'volume_fp', 'volume',
]);

/** A series with a live or next window refreshes this often… */
export const LISTED_INTERVAL_MS = 15_000;
/** …and one with nothing listed (FX/metals weekends, pre-launch) this often. */
export const EMPTY_INTERVAL_MS = 120_000;
/** The loop tick. Each tick fetches only the series that are due. */
const TICK_MS = 15_000;
/** A full pass this long after every :00/:15/:30/:45, so the new window lands at once. */
const TURNOVER_DELAY_MS = 2_000;
const QUARTER_MS = 15 * 60_000;
/** A series is due a little early so pass-duration jitter never skips a whole tick. */
const DUE_SLACK_MS = 1_000;

// Kalshi politeness: ≤ 4 reads in flight, starts ≥ 250 ms apart. Measured 2026-10-07:
// at 100 ms Kalshi answered 429 from about the 20th read of a 26-series pass, every
// time. 250 ms (≤ 4/s) keeps a full turnover pass to ~6.5 s, inside one 15 s tick;
// steady state is ~20 listed series per 15 s ≈ 1.3 req/s.
const MAX_IN_FLIGHT = 4;
const START_GAP_MS = 250;
const READ_TIMEOUT_MS = 8_000;
/** Retry-After we honour when Kalshi sends none, and the most we will wait on one. */
const DEFAULT_429_PAUSE_MS = 2_000;
const MAX_429_PAUSE_MS = 60_000;

const state = {
  enabled: ENABLED,
  passes: 0,
  writes: 0,
  reads: 0,
  readErrors: 0,
  lastRunAt: null,
  lastWriteAt: null,
  lastError: null,
  pausedUntil: 0,
  lastTurnoverBoundary: null,
  /** ticker → { fetched_at, markets, error?, lastAttemptAt } */
  series: {},
  timer: null,
};

let stopRequested = false;

registerFeed(FEED);
if (ENABLED) markFeedRequired(FEED, { maxStaleMs: 5 * 60_000 });

// ── pure helpers (exported for tests) ────────────────────────────────────────

/** Copy only the whitelisted fields. Absent fields stay absent. */
export function slimMarket(m) {
  const out = {};
  for (const k of SLIM_FIELDS) if (m?.[k] !== undefined) out[k] = m[k];
  return out;
}

/** How long until this series is due again: listed → 15 s, nothing listed → 120 s. */
export function cadenceFor(entry) {
  return entry && Array.isArray(entry.markets) && entry.markets.length > 0 ? LISTED_INTERVAL_MS : EMPTY_INTERVAL_MS;
}

export function isDue(entry, now, forceAll = false) {
  if (forceAll || !entry || entry.lastAttemptAt == null) return true;
  return now - entry.lastAttemptAt >= cadenceFor(entry) - DUE_SLACK_MS;
}

/**
 * Fold one read into the series entry. A success replaces the markets (an empty list
 * is a real answer — nothing listed). A 404 is Kalshi's answer for a series with
 * nothing listed (the site's isNoListing), so it is stored as `[]` too. Any other
 * failure KEEPS the last good markets and their old fetched_at and sets `error` —
 * never `[]`, which would read as "nothing listed".
 */
export function applyRead(prev, result, now) {
  const at = new Date(now).toISOString();
  if (result.ok) return { fetched_at: at, markets: result.markets.map(slimMarket), lastAttemptAt: now };
  if (result.status === 404) return { fetched_at: at, markets: [], lastAttemptAt: now };
  return {
    fetched_at: prev?.fetched_at ?? null,
    markets: prev?.markets ?? [],
    error: String(result.error ?? 'read failed').slice(0, 200),
    lastAttemptAt: now,
  };
}

/** The anon-readable row. `stale` is true when any series' last read failed. */
export function buildEnvelope(seriesState, now) {
  const series = {};
  let stale = false;
  for (const ticker of FIFTEEN_MIN_BOARD_SERIES) {
    const e = seriesState[ticker];
    if (!e || e.fetched_at == null) {
      if (e?.error) stale = true;
      continue; // never read successfully — the site falls back to Kalshi for it
    }
    series[ticker] = { fetched_at: e.fetched_at, markets: e.markets, ...(e.error ? { error: e.error } : {}) };
    if (e.error) stale = true;
  }
  return { as_of: new Date(now).toISOString(), stale, _raw: [], data: { v: 1, series } };
}

/** Milliseconds until the next quarter-hour turnover pass is due. */
export function msUntilTurnover(now) {
  const next = Math.floor(now / QUARTER_MS) * QUARTER_MS + QUARTER_MS + TURNOVER_DELAY_MS;
  const sameQuarter = Math.floor(now / QUARTER_MS) * QUARTER_MS + TURNOVER_DELAY_MS;
  return now < sameQuarter ? sameQuarter - now : next - now;
}

function parseRetryAfterMs(v) {
  if (v == null || v === '') return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

// ── one pass ─────────────────────────────────────────────────────────────────

async function readSeries(ticker, now, fetcher) {
  try {
    const markets = await fetcher(ticker, { now, timeoutMs: READ_TIMEOUT_MS });
    return { ok: true, markets };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      status: err?.status ?? null,
      retryAfterMs: err?.status === 429 ? parseRetryAfterMs(err.retryAfter) ?? DEFAULT_429_PAUSE_MS : null,
      error: aborted ? `timeout after ${READ_TIMEOUT_MS}ms` : err?.message || String(err),
    };
  }
}

/**
 * Fetch every due series (≤ 4 in flight, starts ≥ 100 ms apart), then write the row
 * ONCE. A 429 pauses the rest of the pass for its Retry-After; series not read keep
 * their last entry. Injectable `fetcher`/`writer`/`sleep` for tests.
 */
export async function runFifteenMinBoardOnce({
  now = Date.now(),
  forceAll = false,
  fetcher = fetchWindows,
  writer = upsertWidgetPayloads,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!ENABLED) return { written: false, skipped: 'FIFTEEN_MIN_BOARD_ENABLED=0' };
  state.passes += 1;
  state.lastRunAt = new Date(now).toISOString();

  const due = FIFTEEN_MIN_BOARD_SERIES.filter((t) => isDue(state.series[t], now, forceAll));
  let attempted = 0;
  let succeeded = 0;

  if (Date.now() >= state.pausedUntil) {
    let cursor = 0;
    let lastStart = 0;
    const worker = async () => {
      while (cursor < due.length) {
        if (Date.now() < state.pausedUntil) return; // a 429 stopped this pass
        const ticker = due[cursor++];
        const gap = lastStart + START_GAP_MS - Date.now();
        lastStart = Math.max(Date.now(), lastStart + START_GAP_MS);
        if (gap > 0) await sleep(gap);
        attempted += 1;
        state.reads += 1;
        const result = await readSeries(ticker, now, fetcher);
        if (result.ok || result.status === 404) succeeded += 1;
        else state.readErrors += 1;
        if (result.status === 429) {
          state.pausedUntil = Date.now() + Math.min(MAX_429_PAUSE_MS, result.retryAfterMs);
        }
        state.series[ticker] = applyRead(state.series[ticker], result, Date.now());
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, due.length) }, worker));
  }

  const envelope = buildEnvelope(state.series, Date.now());
  try {
    await writer(SLUG, envelope, ['hero']);
    state.writes += 1;
    state.lastWriteAt = envelope.as_of;
    // Healthy = the row was written AND Kalshi answered (or nothing was due).
    if (succeeded > 0 || attempted === 0) {
      recordTick(FEED);
      setFeedStatus(FEED, { connected: true, lastError: null });
    } else {
      state.lastError = `all ${attempted} Kalshi reads failed`;
      setFeedStatus(FEED, { connected: false, lastError: state.lastError });
    }
    return { written: true, attempted, succeeded, series: Object.keys(envelope.data.series).length };
  } catch (err) {
    state.lastError = (err?.message || String(err)).slice(0, 240);
    setFeedStatus(FEED, { connected: false, lastError: state.lastError });
    console.warn(`[fifteen-min-board] write failed: ${state.lastError}`);
    return { written: false, attempted, succeeded, error: state.lastError };
  }
}

// ── loop ─────────────────────────────────────────────────────────────────────

function schedule(delayMs) {
  if (stopRequested) return;
  state.timer = setTimeout(async () => {
    const now = Date.now();
    const boundary = Math.floor(now / QUARTER_MS) * QUARTER_MS;
    const forceAll = now >= boundary + TURNOVER_DELAY_MS && state.lastTurnoverBoundary !== boundary;
    if (forceAll) state.lastTurnoverBoundary = boundary;
    try {
      await runFifteenMinBoardOnce({ now, forceAll });
    } catch (err) {
      state.lastError = (err?.message || String(err)).slice(0, 240);
      console.warn(`[fifteen-min-board] pass failed: ${state.lastError}`);
    }
    schedule(Math.min(TICK_MS, msUntilTurnover(Date.now())));
  }, delayMs);
}

export function bootstrapFifteenMinBoard() {
  if (!ENABLED) return;
  // 50 s — after metals-15m (40 s), so the two never fire their first Kalshi reads together.
  setTimeout(() => {
    // The first pass reads every series, so it counts as this quarter's turnover pass.
    state.lastTurnoverBoundary = Math.floor(Date.now() / QUARTER_MS) * QUARTER_MS;
    schedule(0);
  }, 50_000);
}

export function stopFifteenMinBoard() {
  stopRequested = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export function getFifteenMinBoardState() {
  return {
    enabled: state.enabled,
    passes: state.passes,
    writes: state.writes,
    reads: state.reads,
    readErrors: state.readErrors,
    lastRunAt: state.lastRunAt,
    lastWriteAt: state.lastWriteAt,
    lastError: state.lastError,
    pausedUntil: state.pausedUntil ? new Date(state.pausedUntil).toISOString() : null,
    seriesListed: Object.values(state.series).filter((e) => e.markets?.length > 0).length,
    seriesErrored: Object.values(state.series).filter((e) => e.error).length,
  };
}

export const __test__ = { state, reset: () => { state.series = {}; state.pausedUntil = 0; state.lastTurnoverBoundary = null; } };
