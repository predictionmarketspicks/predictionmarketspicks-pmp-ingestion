// Kalshi WebSocket feed — RSA-PSS signed handshake.
//
// Phase 0 goal: connect, subscribe to active markets under our 3 commodity series,
// log ticks so /health reports lastTickAt, and exit criteria is "Kalshi ticks visible".
//
// IMPORTANT: Kalshi auth is RSA-PSS, NOT HMAC. Older docs around the web get this wrong.
// Sign string: `{timestampMs}{method}{path}` → SHA256 → RSA-PSS → base64.

import crypto from 'node:crypto';
import WebSocket from 'ws';

import { setFeedStatus, recordTick } from '../observability/health.js';

const KALSHI_API_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_WS_URL = process.env.KALSHI_WS_URL || 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const KALSHI_WS_PATH = '/trade-api/ws/v2';

// Phase 0 watchlist — exit criteria checks these series in logs.
// (KXSILVERW, KXGOLDW, KXOILW per plan §8. KXOILW canonical map → KXWTI in actual catalog.)
const PHASE_0_SERIES = ['KXSILVERW', 'KXGOLDW', 'KXWTI'];
const MAX_MARKETS_PER_SERIES = 25;

let ws = null;
let stopRequested = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

function rsaPssSign(timestampMs, method, path) {
  const pem = process.env.KALSHI_PRIVATE_KEY;
  if (!pem) throw new Error('KALSHI_PRIVATE_KEY not set');
  const msg = `${timestampMs}${method}${path}`;
  const sig = crypto.sign('sha256', Buffer.from(msg), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString('base64');
}

function authHeaders(method, path) {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) throw new Error('KALSHI_API_KEY_ID not set');
  const ts = Date.now().toString();
  const sig = rsaPssSign(ts, method, path);
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-SIGNATURE': sig,
    'KALSHI-ACCESS-TIMESTAMP': ts,
  };
}

async function fetchMarketTickersForSeries(seriesTicker) {
  // /markets is public — keep this unauthenticated so a PEM bug isolates to the WS handshake.
  const url = `${KALSHI_API_BASE}/markets?series_ticker=${seriesTicker}&status=open&limit=200`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    console.warn(`[kalshi] series ${seriesTicker} → ${res.status}`);
    return [];
  }
  const json = await res.json();
  const markets = Array.isArray(json?.markets) ? json.markets : [];
  return markets
    .map((m) => m.ticker)
    .filter(Boolean)
    .slice(0, MAX_MARKETS_PER_SERIES);
}

async function discoverMarketTickers() {
  const all = [];
  for (const series of PHASE_0_SERIES) {
    try {
      const tickers = await fetchMarketTickersForSeries(series);
      console.log(`[kalshi] discovered ${tickers.length} markets for ${series}`);
      all.push(...tickers);
    } catch (err) {
      console.warn(`[kalshi] discover ${series} failed`, err?.message || err);
    }
  }
  return all;
}

function backoffMs() {
  const base = Math.min(30_000, 500 * 2 ** reconnectAttempts);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function scheduleReconnect() {
  if (stopRequested) return;
  reconnectAttempts += 1;
  const delay = backoffMs();
  console.warn(`[kalshi] reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => {
      console.error('[kalshi] reconnect failed', err);
      scheduleReconnect();
    });
  }, delay);
}

async function connect() {
  const tickers = await discoverMarketTickers();
  if (tickers.length === 0) {
    setFeedStatus('kalshi', { connected: false, lastError: 'no_markets_discovered' });
    throw new Error('no markets discovered for Phase 0 series');
  }

  const headers = authHeaders('GET', KALSHI_WS_PATH);
  console.log(`[kalshi] connecting to ${KALSHI_WS_URL} (${tickers.length} tickers)`);

  ws = new WebSocket(KALSHI_WS_URL, { headers });

  ws.on('open', () => {
    reconnectAttempts = 0;
    setFeedStatus('kalshi', { connected: true, lastError: null });
    const sub = {
      id: 1,
      cmd: 'subscribe',
      params: {
        channels: ['ticker_v2'],
        market_tickers: tickers,
      },
    };
    ws.send(JSON.stringify(sub));
    console.log(`[kalshi] subscribed to ticker_v2 on ${tickers.length} markets`);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'error') {
      console.warn('[kalshi] error message', msg);
      setFeedStatus('kalshi', { lastError: JSON.stringify(msg).slice(0, 240) });
      return;
    }
    if (msg.type === 'ticker_v2' || msg.msg?.market_ticker) {
      recordTick('kalshi');
      const t = msg.msg?.market_ticker || msg.market_ticker || '?';
      const price = msg.msg?.price ?? msg.msg?.yes_bid ?? null;
      console.log(`[kalshi:tick] ${t} price=${price}`);
    }
  });

  ws.on('close', (code, reason) => {
    setFeedStatus('kalshi', { connected: false, lastError: `closed:${code}:${reason?.toString?.() || ''}` });
    console.warn(`[kalshi] closed code=${code} reason=${reason?.toString?.() || ''}`);
    ws = null;
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    setFeedStatus('kalshi', { lastError: err?.message || String(err) });
    console.error('[kalshi] ws error', err?.message || err);
  });
}

export async function startKalshi() {
  stopRequested = false;
  await connect();
}

export function stopKalshi() {
  stopRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}
