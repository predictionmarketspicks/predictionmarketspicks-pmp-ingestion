// Kalshi WebSocket feed — RSA-PSS signed handshake, ticker channel.
//
// Auth: RSA-PSS (NOT HMAC). Sign `${ts_ms}${method}${path}` → base64.
// Channel: 'ticker' (NOT 'ticker_v2' — that errors with "Unknown channel name").
//
// Ticker message shape (verified against docs.kalshi.com/websockets/market-ticker):
//   { type:'ticker', sid, msg: {
//       market_ticker, market_id,
//       price_dollars, yes_bid_dollars, yes_ask_dollars,
//       volume_fp, open_interest_fp,
//       dollar_volume, dollar_open_interest,
//       yes_bid_size_fp, yes_ask_size_fp, last_trade_size_fp,
//       ts_ms
//     }
//   }
//
// All *_dollars are STRINGS in dollar units (e.g. "0.530"). All *_fp are STRINGS
// in 2-decimal fixed-point. We parse to floats once at ingest and store in the
// in-memory quote map so the silver engine can read synchronously.

import crypto from 'node:crypto';
import WebSocket from 'ws';

import { setFeedStatus, recordTick } from '../observability/health.js';

const KALSHI_API_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_WS_URL = process.env.KALSHI_WS_URL || 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const KALSHI_WS_PATH = '/trade-api/ws/v2';

// Series → max markets to subscribe per series. Phase 1 is silver-focused but
// gold/oil stay subscribed so /health stays multi-series and Phase 2 has
// observation history when GLD/USO/CPER engines come online.
const PHASE_1_SERIES = ['KXSILVERW', 'KXGOLDW', 'KXWTI'];
const MAX_MARKETS_PER_SERIES = 25;

// Log the raw message shape for the first few ticks per process so future debug
// has ground truth without redeploying with new logs.
let rawShapeLogged = 0;
const RAW_SHAPE_LOG_LIMIT = 3;

let ws = null;
let stopRequested = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

// Quote map populated from ticker messages. Read by src/engine/silver.js.
//   key   = market_ticker (e.g. "KXSILVERW-26MAY0117-T35.99")
//   value = { ticker, price, yesBid, yesAsk, volume, openInt, ts, eventTicker }
const quoteMap = new Map();

// Series → array of (market_ticker, event_ticker) pairs the engine needs to
// scope its work. Refreshed on every WS connect.
const seriesIndex = new Map();

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
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-SIGNATURE': rsaPssSign(ts, method, path),
    'KALSHI-ACCESS-TIMESTAMP': ts,
  };
}

// Unauthenticated — /markets is public. Keeps a PEM bug isolated to the WS path.
async function fetchMarketsForSeries(seriesTicker) {
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
  return Array.isArray(json?.markets) ? json.markets : [];
}

// Strip the strike segment from a market ticker to get the event ticker.
// "KXSILVERW-26MAY0117-T35.99" → "KXSILVERW-26MAY0117"
export function toEventTicker(marketTicker) {
  const parts = String(marketTicker).split('-');
  return parts.length >= 3 ? parts.slice(0, -1).join('-') : marketTicker;
}

async function discoverMarkets() {
  const all = [];
  for (const series of PHASE_1_SERIES) {
    try {
      const markets = await fetchMarketsForSeries(series);
      const tickers = markets
        .map((m) => ({ ticker: m.ticker, eventTicker: m.event_ticker || toEventTicker(m.ticker) }))
        .filter((m) => m.ticker)
        .slice(0, MAX_MARKETS_PER_SERIES);
      seriesIndex.set(series, tickers);
      all.push(...tickers);
      console.log(`[kalshi] discovered ${tickers.length} markets for ${series}`);
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

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function applyTickerMsg(m) {
  if (!m || !m.market_ticker) return;
  const eventTicker = toEventTicker(m.market_ticker);
  const prev = quoteMap.get(m.market_ticker) || { ticker: m.market_ticker, eventTicker };
  // Only overwrite fields that are present — Kalshi sometimes sends partial
  // updates (e.g. trade prints with no quote change).
  const next = { ...prev };
  if (m.price_dollars != null) next.price = num(m.price_dollars);
  if (m.yes_bid_dollars != null) next.yesBid = num(m.yes_bid_dollars);
  if (m.yes_ask_dollars != null) next.yesAsk = num(m.yes_ask_dollars);
  if (m.volume_fp != null) next.volume = num(m.volume_fp);
  if (m.open_interest_fp != null) next.openInt = num(m.open_interest_fp);
  if (m.ts_ms != null) next.ts = m.ts_ms;
  else if (m.ts != null) next.ts = m.ts * 1000;
  next.eventTicker = eventTicker;
  quoteMap.set(m.market_ticker, next);
}

async function connect() {
  const markets = await discoverMarkets();
  if (markets.length === 0) {
    setFeedStatus('kalshi', { connected: false, lastError: 'no_markets_discovered' });
    throw new Error('no markets discovered for Phase 1 series');
  }

  const headers = authHeaders('GET', KALSHI_WS_PATH);
  const tickers = markets.map((m) => m.ticker);
  console.log(`[kalshi] connecting to ${KALSHI_WS_URL} (${tickers.length} tickers)`);

  ws = new WebSocket(KALSHI_WS_URL, { headers });

  ws.on('open', () => {
    reconnectAttempts = 0;
    setFeedStatus('kalshi', { connected: true, lastError: null });
    const sub = {
      id: 1,
      cmd: 'subscribe',
      params: { channels: ['ticker'], market_tickers: tickers },
    };
    ws.send(JSON.stringify(sub));
    console.log(`[kalshi] subscribed to ticker on ${tickers.length} markets`);
  });

  ws.on('message', (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (parsed.type === 'error') {
      console.warn('[kalshi] error message', parsed);
      setFeedStatus('kalshi', { lastError: JSON.stringify(parsed).slice(0, 240) });
      return;
    }
    if (parsed.type === 'ticker' && parsed.msg) {
      recordTick('kalshi');
      applyTickerMsg(parsed.msg);
      if (rawShapeLogged < RAW_SHAPE_LOG_LIMIT) {
        rawShapeLogged += 1;
        console.log(`[kalshi:shape ${rawShapeLogged}/${RAW_SHAPE_LOG_LIMIT}]`, JSON.stringify(parsed.msg));
      }
    }
  });

  ws.on('close', (code, reason) => {
    setFeedStatus('kalshi', {
      connected: false,
      lastError: `closed:${code}:${reason?.toString?.() || ''}`,
    });
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

// Read accessors for the silver engine.

export function getQuote(marketTicker) {
  return quoteMap.get(marketTicker) || null;
}

export function getSeriesMarkets(seriesTicker) {
  return seriesIndex.get(seriesTicker) || [];
}

export function getQuoteCount() {
  return quoteMap.size;
}
