// One-second PUBLIC bitcoin spot — Coinbase Exchange's keyless WS ticker.
//
// handoffs (site repo) BITCOIN_15M_TECHNICAL_REBUILD_2026-09-23.md T1.2. The 15m
// capture (kalshi-btc15m.js) samples the book every second; the 10s REST basket in
// brti-spot.js is too coarse to line a book move up against the spot that caused it.
//
// Coinbase is a BRTI constituent exchange, public, keyless. Reachability from the
// Fly machine was tested before this was written (2026-09-23: 80 ticks in 10s).
// The ticker channel emits on every trade with best_bid/best_ask; we keep the
// quote MID, never the last trade (a trade prints at one side of the spread).
//
// ⛔ PUBLIC SPOT ONLY. This is `btcSpot.pub`-class data. Nothing here reads or
// stores the CF Benchmarks index.
//
// Fallback rung: when this socket is stale, getPubSpot1s() returns the brti-spot.js
// basket (10s REST median) with its real age — a fallback that is only started
// during an outage is the one that fails during an outage, so the basket keeps
// running regardless (index.js starts it unconditionally).

import WebSocket from 'ws';

import { setFeedStatus, recordTick } from '../observability/health.js';
import { getBrtiSpot } from './brti-spot.js';

export const COINBASE_WS_URL = 'wss://ws-feed.exchange.coinbase.com';
export const COINBASE_SOURCE_TAG = 'coinbase_ws';
/** Past this age the socket's print is not a one-second spot any more. */
export const COINBASE_MAX_AGE_MS = 5_000;
/** Rolling one-sample-per-second buffer for velocity — ≥5 min per the spec. */
export const BUFFER_SECONDS = 600;

let ws = null;
let stopRequested = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let sampleTimer = null;

let latest = null; // { price, bid, ask, publishTimeMs, source }
const buffer = []; // [{ t (ms, whole second), price, source }]

/** Parse one Coinbase `ticker` frame into a quote; null when it is not a usable two-sided quote. */
export function parseCoinbaseTicker(m, nowMs = Date.now()) {
  if (!m || m.type !== 'ticker') return null;
  const bid = Number.parseFloat(m.best_bid);
  const ask = Number.parseFloat(m.best_ask);
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const t = Date.parse(m.time);
  return {
    price: (bid + ask) / 2,
    bid,
    ask,
    // A server clock ahead of ours must never produce a future timestamp.
    publishTimeMs: Number.isFinite(t) ? Math.min(t, nowMs) : nowMs,
    source: COINBASE_SOURCE_TAG,
  };
}

/**
 * The best one-second public spot we have right now: the Coinbase mid when it is
 * fresh, else the REST basket, with the age the caller must record. Null only
 * when both are missing.
 */
export function getPubSpot1s(nowMs = Date.now()) {
  if (latest && nowMs - latest.publishTimeMs <= COINBASE_MAX_AGE_MS) {
    return { ...latest, ageMs: nowMs - latest.publishTimeMs };
  }
  const bk = getBrtiSpot();
  const cands = [latest, bk && { ...bk, source: bk.source || 'brti_basket' }].filter(Boolean);
  if (cands.length === 0) return null;
  const best = cands.reduce((a, b) => (b.publishTimeMs > a.publishTimeMs ? b : a));
  return { price: best.price, publishTimeMs: best.publishTimeMs, source: best.source, ageMs: nowMs - best.publishTimeMs };
}

/** Copy of the rolling 1s buffer, oldest first. */
export function getPubSpotBuffer() {
  return buffer.slice();
}

function sample() {
  const now = Date.now();
  const s = getPubSpot1s(now);
  if (!s) return;
  buffer.push({ t: Math.floor(now / 1000) * 1000, price: s.price, source: s.source });
  if (buffer.length > BUFFER_SECONDS) buffer.splice(0, buffer.length - BUFFER_SECONDS);
}

function scheduleReconnect() {
  if (stopRequested || reconnectTimer) return;
  reconnectAttempts += 1;
  const delay = Math.min(30_000, 500 * 2 ** reconnectAttempts) + Math.floor(Math.random() * 250);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (stopRequested) return;
  ws = new WebSocket(COINBASE_WS_URL);
  ws.on('open', () => {
    reconnectAttempts = 0;
    setFeedStatus(COINBASE_SOURCE_TAG, { connected: true, lastError: null });
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
  });
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === 'error') {
      setFeedStatus(COINBASE_SOURCE_TAG, { lastError: String(m.message || m.reason || 'error').slice(0, 240) });
      return;
    }
    const q = parseCoinbaseTicker(m);
    if (q) {
      latest = q;
      recordTick(COINBASE_SOURCE_TAG);
    }
  });
  ws.on('close', (code) => {
    setFeedStatus(COINBASE_SOURCE_TAG, { connected: false, lastError: `closed:${code}` });
    ws = null;
    scheduleReconnect();
  });
  ws.on('error', (err) => {
    setFeedStatus(COINBASE_SOURCE_TAG, { lastError: err?.message || String(err) });
  });
}

export function startCoinbaseWs() {
  stopRequested = false;
  setFeedStatus(COINBASE_SOURCE_TAG, { connected: false, lastError: 'starting' });
  connect();
  if (!sampleTimer) sampleTimer = setInterval(sample, 1000);
}

export function stopCoinbaseWs() {
  stopRequested = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
}
