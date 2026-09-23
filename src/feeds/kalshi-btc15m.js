// KXBTC15M one-second capture — the order book and the tape, for research.
//
// Site-repo spec: handoffs/BITCOIN_15M_TECHNICAL_REBUILD_2026-09-23.md T1.1/T1.3/T1.5.
// Tables: fifteen_min_book_1s + fifteen_min_trades_1s (migration
// 20260923180000_fifteen_min_book_capture.sql; nightly rollup = cron job
// 'fifteen-min-book-rollup' → fifteen_min_book_windows + fifteen_min_first_touch).
//
// WHY ITS OWN SOCKET (not a line in kalshi.js's PHASE_1_SERIES)
//   kalshi.js is torn down and rediscovered every hour at HH:00:30 and carries the
//   metals/oil/KXBTCD books. A 15-minute market needs a roll every quarter-hour, an
//   order-book channel and a trade channel; bolting that onto the shared socket
//   means a fault here can take the metals down with it. Same precedent as the CF
//   Benchmarks adapter (kalshi-auth.js exists so sockets can share signing).
//
// CHANNELS (verified against docs.kalshi.com/websockets, 2026-09-23 — names are
// load-bearing; `ticker_v2` does not exist):
//   orderbook_delta → `orderbook_snapshot` {yes_dollars_fp, no_dollars_fp: [[price, size]]}
//                     then `orderbook_delta` {price_dollars, delta_fp, side}
//   trade           → `trade` {trade_id, yes_price_dollars, count_fp, taker_side, ts_ms}
//                     stored per SECOND in fifteen_min_trades_1s (aggregateTrades)
//   update_subscription {sids:[one], action:'add_markets'|'delete_markets', market_tickers}
// Both sides of the book are BID ladders: YES ask = 1 − best NO bid.
//
// SUBSCRIBES ONLY THE CURRENT AND NEXT WINDOW, rolled at each :00/:15/:30/:45 with
// update_subscription (add the new next, drop the expired one) so the new window's
// book is already live when it opens. Tickers are deterministic from the ET close
// time (KXBTC15M-26SEP231330-30 closes 13:30 ET) — no discovery call that can fail.
//
// PRECISION: prices stay as the *_dollars strings' floats (tapered_deci_cent — 0.1¢
// steps in the tails). Never rounded to cents.
//
// WRITES: buffered, one multi-row insert per table every 15s. Never one RPC per
// second. A failed flush keeps the buffer (bounded) and retries next flush.
//
// ⛔ PUBLIC SPOT ONLY on these rows (coinbase-ws.js getPubSpot1s). No CF Benchmarks
// value, no running average, ever — those stay where the shadow ticks keep them.
//
// Kill switch: BTC15M_CAPTURE_ENABLED=0.

import WebSocket from 'ws';

import { setFeedStatus, recordTick } from '../observability/health.js';
import { authHeaders, KALSHI_WS_URL, KALSHI_WS_PATH } from './kalshi-auth.js';
import { getPubSpot1s } from './coinbase-ws.js';
import { insertFifteenMinBookRows, insertFifteenMinTrades } from '../delivery/supabase.js';
import { postBotLog } from '../delivery/discord.js';

export const SERIES = 'KXBTC15M';
export const COMMODITY = 'bitcoin';
export const FEED_TAG = 'kalshi_btc15m';
const WINDOW_MS = 15 * 60_000;
const AVG_WINDOW_MS = 60_000;
const FLUSH_MS = 15_000;
/** Bound on a buffer that cannot flush: ~4 min of book rows for two markets. */
const MAX_BUFFER_ROWS = 600;
/** Roll a couple of seconds after the boundary so the add lands on a live market. */
const ROLL_DELAY_MS = 2_000;
/** Watchdog: no rows INSERTED for this long → #bot-logs (spec: within 15 min). */
export const WATCHDOG_STALE_MS = 10 * 60_000;
const WATCHDOG_BOOT_GRACE_MS = 5 * 60_000;

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// ── pure helpers (exported for tests) ─────────────────────────────────────────

/** The close of the window live at `nowMs`: the next quarter-hour strictly after it. */
export function windowCloseMs(nowMs) {
  return (Math.floor(nowMs / WINDOW_MS) + 1) * WINDOW_MS;
}

/** KXBTC15M market ticker for the window closing at `closeMs` (ticker encodes ET close). */
export function btc15mTicker(closeMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: '2-digit', month: 'numeric', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(new Date(closeMs))
      .map((p) => [p.type, p.value]),
  );
  const ev = `${SERIES}-${parts.year}${MON[Number(parts.month) - 1]}${parts.day}${parts.hour}${parts.minute}`;
  return { market: `${ev}-${parts.minute}`, event: ev };
}

const num = (v) => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export function emptyBook() {
  return { yes: new Map(), no: new Map(), ready: false };
}

/** Replace a book from an `orderbook_snapshot` msg. */
export function applySnapshot(book, msg) {
  book.yes.clear();
  book.no.clear();
  for (const [side, key] of [['yes', 'yes_dollars_fp'], ['no', 'no_dollars_fp']]) {
    for (const [p, s] of msg[key] || []) {
      const price = num(p), size = num(s);
      if (price != null && size != null && size > 0) book[side].set(price, size);
    }
  }
  book.ready = true;
}

/** Apply an `orderbook_delta` msg. A level that nets to ≤0 is removed. */
export function applyDelta(book, msg) {
  const side = msg.side === 'yes' ? book.yes : msg.side === 'no' ? book.no : null;
  const price = num(msg.price_dollars), d = num(msg.delta_fp);
  if (!side || price == null || d == null) return;
  const next = (side.get(price) || 0) + d;
  if (next > 1e-9) side.set(price, Number(next.toFixed(2)));
  else side.delete(price);
}

/** Top of book in YES terms. A missing side is null (a zero is absence, not a price). */
export function bookTop(book) {
  let bid = null, bidSize = null, noBid = null, askSize = null;
  for (const [p, s] of book.yes) if (bid == null || p > bid) { bid = p; bidSize = s; }
  for (const [p, s] of book.no) if (noBid == null || p > noBid) { noBid = p; askSize = s; }
  return {
    yesBid: bid,
    bidSize,
    yesAsk: noBid == null ? null : Number((1 - noBid).toFixed(4)),
    askSize,
  };
}

/** One `trade` msg → a raw print (aggregated by aggregateTrades before writing); null when unusable. */
export function tradeRow(msg, eventOf) {
  const price = num(msg.yes_price_dollars), count = num(msg.count_fp);
  const tsMs = msg.ts_ms ?? (msg.ts != null ? msg.ts * 1000 : null);
  if (!msg.trade_id || !msg.market_ticker || price == null || count == null || tsMs == null) return null;
  if (msg.taker_side !== 'yes' && msg.taker_side !== 'no') return null;
  return {
    commodity: COMMODITY,
    market_ticker: msg.market_ticker,
    event_ticker: eventOf(msg.market_ticker),
    ts: new Date(tsMs).toISOString(),
    yes_price: price,
    count,
    taker_side: msg.taker_side,
  };
}

/** Prints older than this are complete: a second is flushed once, never split. */
export const TRADE_SETTLE_MS = 3_000;

/**
 * Collapse raw prints into fifteen_min_trades_1s rows — one per (market, whole second,
 * price, taker side), contracts summed, prints counted. Only seconds that ended at
 * least TRADE_SETTLE_MS before `nowMs` are emitted; the rest come back as `pending`.
 */
export function aggregateTrades(prints, nowMs) {
  const cutoff = Math.floor((nowMs - TRADE_SETTLE_MS) / 1000) * 1000;
  const rows = new Map();
  const pending = [];
  for (const p of prints) {
    const sec = Math.floor(Date.parse(p.ts) / 1000) * 1000;
    if (sec >= cutoff) {
      pending.push(p);
      continue;
    }
    const key = `${p.market_ticker}|${sec}|${p.yes_price}|${p.taker_side}`;
    const r = rows.get(key);
    if (r) {
      r.count = Number((r.count + p.count).toFixed(2));
      r.prints += 1;
    } else {
      rows.set(key, {
        commodity: p.commodity,
        market_ticker: p.market_ticker,
        event_ticker: p.event_ticker,
        ts: new Date(sec).toISOString(),
        yes_price: p.yes_price,
        taker_side: p.taker_side,
        count: p.count,
        prints: 1,
      });
    }
  }
  return { rows: [...rows.values()], pending };
}

/** One sampled second → a fifteen_min_book_1s row; null when the book has neither side. */
export function bookRow({ market, event, closeMs }, book, observedMs, spot) {
  if (!book?.ready) return null;
  const top = bookTop(book);
  if (top.yesBid == null && top.yesAsk == null) return null;
  const tau = closeMs - observedMs;
  return {
    commodity: COMMODITY,
    market_ticker: market,
    event_ticker: event,
    observed_at: new Date(observedMs).toISOString(),
    tau_ms: tau,
    yes_bid: top.yesBid,
    yes_ask: top.yesAsk,
    bid_size: top.bidSize,
    ask_size: top.askSize,
    pub_spot: spot ? spot.price : null,
    pub_spot_age_ms: spot ? Math.max(0, Math.round(spot.ageMs)) : null,
    pub_spot_source: spot ? spot.source : null,
    in_avg_window: tau >= 0 && tau <= AVG_WINDOW_MS,
  };
}

// ── state ─────────────────────────────────────────────────────────────────────

let ws = null;
let stopRequested = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let sampleTimer = null;
let flushTimer = null;
let rollTimer = null;
let watchdogTimer = null;
let cmdId = 100;
const startedAt = Date.now();

/** market_ticker → { market, event, closeMs } for the subscribed pair. */
let windows = new Map();
const books = new Map(); // market_ticker → book
const sids = new Map(); // channel → sid
const lastSeq = new Map(); // sid → seq

let bookBuf = [];
let tradeBuf = []; // raw prints, aggregated at flush
let tradeRetry = []; // aggregated rows from a failed flush
let flushing = false;

const stats = {
  wsConnected: false,
  lastInsertedAt: null, // wall clock of the last successful book insert
  lastAt: null, // observed_at of the newest book row inserted
  tradesLastAt: null,
  insertLog: [], // [{ at, book, trades }] for the last-minute counts
  lastFlushError: null,
  droppedRows: 0,
  seqGapReconnects: 0,
  alerting: false,
};

function currentPair(nowMs = Date.now()) {
  const c1 = windowCloseMs(nowMs);
  return [c1, c1 + WINDOW_MS].map((closeMs) => ({ ...btc15mTicker(closeMs), closeMs }));
}

const eventOf = (market) => windows.get(market)?.event ?? market.replace(/-[^-]+$/, '');

// ── socket ────────────────────────────────────────────────────────────────────

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function scheduleReconnect(reason) {
  if (stopRequested || reconnectTimer) return;
  reconnectAttempts += 1;
  const delay = Math.min(30_000, 500 * 2 ** reconnectAttempts) + Math.floor(Math.random() * 250);
  console.warn(`[btc15m] reconnecting in ${delay}ms (${reason})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function teardown() {
  if (ws) {
    ws.removeAllListeners();
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  stats.wsConnected = false;
  sids.clear();
  lastSeq.clear();
  for (const b of books.values()) b.ready = false;
}

function connect() {
  if (stopRequested) return;
  teardown();
  const pair = currentPair();
  windows = new Map(pair.map((w) => [w.market, w]));
  for (const m of [...books.keys()]) if (!windows.has(m)) books.delete(m);
  for (const w of pair) if (!books.has(w.market)) books.set(w.market, emptyBook());

  ws = new WebSocket(KALSHI_WS_URL, { headers: authHeaders('GET', KALSHI_WS_PATH) });
  ws.on('open', () => {
    reconnectAttempts = 0;
    stats.wsConnected = true;
    setFeedStatus(FEED_TAG, { connected: true, lastError: null });
    send({ id: ++cmdId, cmd: 'subscribe', params: { channels: ['orderbook_delta', 'trade'], market_tickers: [...windows.keys()] } });
    console.log(`[btc15m] subscribed orderbook_delta+trade on ${[...windows.keys()].join(', ')}`);
  });
  ws.on('message', onMessage);
  ws.on('close', (code, reason) => {
    stats.wsConnected = false;
    setFeedStatus(FEED_TAG, { connected: false, lastError: `closed:${code}:${reason?.toString?.() || ''}` });
    ws = null;
    scheduleReconnect(`closed ${code}`);
  });
  ws.on('error', (err) => {
    setFeedStatus(FEED_TAG, { lastError: err?.message || String(err) });
  });
}

function onMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (m.type === 'subscribed' && m.msg?.channel) {
    sids.set(m.msg.channel, m.msg.sid);
    return;
  }
  if (m.type === 'error') {
    console.warn('[btc15m] error message', JSON.stringify(m).slice(0, 300));
    setFeedStatus(FEED_TAG, { lastError: JSON.stringify(m).slice(0, 240) });
    return;
  }
  // A gap in a subscription's seq means the local book may be wrong. Rebuild from
  // fresh snapshots rather than keep sampling a book we can no longer vouch for.
  if (m.sid != null && m.seq != null) {
    const prev = lastSeq.get(m.sid);
    lastSeq.set(m.sid, m.seq);
    if (prev != null && m.seq !== prev + 1) {
      stats.seqGapReconnects += 1;
      console.warn(`[btc15m] seq gap sid=${m.sid} ${prev}→${m.seq}; resubscribing`);
      teardown();
      scheduleReconnect('seq gap');
      return;
    }
  }
  const msg = m.msg;
  if (!msg) return;
  if (m.type === 'orderbook_snapshot') {
    const b = books.get(msg.market_ticker);
    if (b) applySnapshot(b, msg);
    recordTick(FEED_TAG);
  } else if (m.type === 'orderbook_delta') {
    const b = books.get(msg.market_ticker);
    if (b?.ready) applyDelta(b, msg);
    recordTick(FEED_TAG);
  } else if (m.type === 'trade') {
    if (!windows.has(msg.market_ticker)) return;
    const row = tradeRow(msg, eventOf);
    if (row) tradeBuf.push(row);
  }
}

// ── roll each quarter-hour ────────────────────────────────────────────────────

function scheduleRoll() {
  const now = Date.now();
  const delay = windowCloseMs(now) - now + ROLL_DELAY_MS;
  rollTimer = setTimeout(() => {
    rollTimer = null;
    try {
      roll();
    } catch (err) {
      console.warn('[btc15m] roll failed', err?.message || err);
      scheduleReconnect('roll failed');
    } finally {
      if (!stopRequested) scheduleRoll();
    }
  }, delay);
}

function roll() {
  const pair = currentPair();
  const want = new Set(pair.map((w) => w.market));
  const drop = [...windows.keys()].filter((m) => !want.has(m));
  const add = pair.filter((w) => !windows.has(w.market));
  windows = new Map(pair.map((w) => [w.market, w]));
  for (const m of drop) books.delete(m);
  for (const w of add) books.set(w.market, emptyBook());
  if (!ws || sids.size === 0) return; // not connected: connect() subscribes the new pair
  for (const sid of sids.values()) {
    if (add.length) send({ id: ++cmdId, cmd: 'update_subscription', params: { sids: [sid], market_tickers: add.map((w) => w.market), action: 'add_markets' } });
    if (drop.length) send({ id: ++cmdId, cmd: 'update_subscription', params: { sids: [sid], market_tickers: drop, action: 'delete_markets' } });
  }
  console.log(`[btc15m] rolled: +${add.map((w) => w.market).join(',')} −${drop.join(',')}`);
}

// ── sample every second, flush every 15s ──────────────────────────────────────

function sampleOnce() {
  const observedMs = Math.floor(Date.now() / 1000) * 1000;
  const spot = getPubSpot1s(observedMs);
  for (const w of windows.values()) {
    // Only the live window: the next one is subscribed to pre-warm its book, but it
    // cannot trade before it opens.
    if (observedMs < w.closeMs - WINDOW_MS || observedMs >= w.closeMs) continue;
    const row = bookRow(w, books.get(w.market), observedMs, spot);
    if (row) bookBuf.push(row);
  }
}

function bound(buf) {
  if (buf.length <= MAX_BUFFER_ROWS) return buf;
  stats.droppedRows += buf.length - MAX_BUFFER_ROWS;
  return buf.slice(buf.length - MAX_BUFFER_ROWS);
}

async function flush() {
  if (flushing) return;
  flushing = true;
  const book = bookBuf;
  const { rows: trades, pending } = aggregateTrades(tradeBuf, Date.now());
  const printsFlushed = tradeBuf.length - pending.length;
  bookBuf = [];
  tradeBuf = pending;
  try {
    if (book.length) {
      await insertFifteenMinBookRows(book);
      stats.lastInsertedAt = Date.now();
      stats.lastAt = book[book.length - 1].observed_at;
    }
    if (tradeRetry.length) {
      await insertFifteenMinTrades(tradeRetry);
      tradeRetry = [];
    }
    if (trades.length) {
      await insertFifteenMinTrades(trades);
      stats.tradesLastAt = trades.reduce((a, r) => (r.ts > a ? r.ts : a), stats.tradesLastAt ?? "");
    }
    stats.insertLog.push({ at: Date.now(), book: book.length, trades: trades.length, prints: printsFlushed });
    stats.insertLog = stats.insertLog.filter((e) => Date.now() - e.at <= 60_000);
    stats.lastFlushError = null;
  } catch (err) {
    stats.lastFlushError = { at: new Date().toISOString(), message: String(err?.message || err).slice(0, 240) };
    console.warn('[btc15m] flush failed; retrying next flush', stats.lastFlushError.message);
    // Keep the rows; inserts are idempotent (PK / trade_id), so a retry is safe.
    // Book rows go back as-is; trade seconds go back as their aggregate rows can't be
    // re-split, so they are retried from a side buffer.
    bookBuf = bound(book.concat(bookBuf));
    tradeRetry = bound(trades.concat(tradeRetry));
  } finally {
    flushing = false;
  }
}

// ── watchdog: a healthy socket is not a populated table ───────────────────────

async function watchdog() {
  const now = Date.now();
  if (now - startedAt < WATCHDOG_BOOT_GRACE_MS) return;
  const last = stats.lastInsertedAt ?? startedAt;
  const stale = now - last > WATCHDOG_STALE_MS;
  if (stale && !stats.alerting) {
    stats.alerting = true;
    await postBotLog(
      `🟥 **KXBTC15M capture stalled** — no book rows inserted into fifteen_min_book_1s for ${Math.round((now - last) / 60_000)} min. ` +
        `wsConnected=${stats.wsConnected} · lastFlushError=${stats.lastFlushError?.message ?? 'none'} · ` +
        `check https://pmp-ingestion.fly.dev/health → crypto15m.book1s`,
    ).catch(() => {});
  } else if (!stale && stats.alerting) {
    stats.alerting = false;
    await postBotLog('🟩 **KXBTC15M capture recovered** — book rows are inserting again.').catch(() => {});
  }
}

// ── public ────────────────────────────────────────────────────────────────────

export function getBook1sHealth() {
  const now = Date.now();
  const recent = stats.insertLog.filter((e) => now - e.at <= 60_000);
  const spot = getPubSpot1s(now);
  return {
    enabled: process.env.BTC15M_CAPTURE_ENABLED !== '0',
    wsConnected: stats.wsConnected,
    lastAt: stats.lastAt,
    rowsLastMin: recent.reduce((a, e) => a + e.book, 0),
    tradesLastAt: stats.tradesLastAt,
    tradesLastMin: recent.reduce((a, e) => a + e.trades, 0),
    printsLastMin: recent.reduce((a, e) => a + (e.prints || 0), 0),
    markets: [...windows.keys()],
    booksReady: [...books.entries()].filter(([, b]) => b.ready).map(([m]) => m),
    pubSpot: spot ? { source: spot.source, ageMs: Math.round(spot.ageMs) } : null,
    buffered: { book: bookBuf.length, prints: tradeBuf.length, tradeRetry: tradeRetry.length },
    droppedRows: stats.droppedRows,
    seqGapReconnects: stats.seqGapReconnects,
    lastFlushError: stats.lastFlushError,
    alerting: stats.alerting,
  };
}

export function startKalshiBtc15m() {
  if (process.env.BTC15M_CAPTURE_ENABLED === '0') {
    console.log('[btc15m] capture disabled via BTC15M_CAPTURE_ENABLED=0');
    return;
  }
  stopRequested = false;
  setFeedStatus(FEED_TAG, { connected: false, lastError: 'starting' });
  connect();
  scheduleRoll();
  sampleTimer = setInterval(sampleOnce, 1000);
  flushTimer = setInterval(() => { flush(); }, FLUSH_MS);
  watchdogTimer = setInterval(() => { watchdog(); }, 60_000);
}

export function stopKalshiBtc15m() {
  stopRequested = true;
  for (const t of [sampleTimer, flushTimer, watchdogTimer]) if (t) clearInterval(t);
  if (rollTimer) clearTimeout(rollTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  sampleTimer = flushTimer = watchdogTimer = rollTimer = reconnectTimer = null;
  teardown();
}
