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
import { getKalshiTickers as getArbKalshiTickers } from '../engine/arb-mappings.js';

const KALSHI_API_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_WS_URL = process.env.KALSHI_WS_URL || 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const KALSHI_WS_PATH = '/trade-api/ws/v2';

// Series → max markets to subscribe per series. Phase 1 is silver-focused but
// gold/oil stay subscribed so /health stays multi-series and Phase 2 has
// observation history when GLD/USO/CPER engines come online.
// KXBTCD added 2026-05-21 — bitcoin was missed during the 2026-05-04 Massive
// real-time cutover and was reading Kalshi only via per-snapshot REST.
const PHASE_1_SERIES = ['KXSILVERW', 'KXGOLDW', 'KXWTI', 'KXBTCD'];
// KXBTCD has ~30-40 strikes per active event vs ~12-15 for the weekly metals,
// and the engine ticks on one event at a time — so the slice cap is wider
// AND we filter KXBTCD to the soonest in-window event before slicing.
const MAX_MARKETS_PER_SERIES = 50;

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

// Phase 4 cold-start seed. The WS subscribe only emits ticker frames when a
// quote actually changes, so on a fresh connect (boot or reconnect) the
// quoteMap can stay empty for tens of seconds while a quiet market sits there.
// /markets already gives us price + bid/ask + volume in dollar/fp form, so we
// seed once per series before WS takes over. WS frames overwrite as they
// arrive — they're authoritative.
function seedFromMarket(m) {
  if (!m?.ticker) return;
  applyTickerMsg({
    market_ticker: m.ticker,
    price_dollars: m.last_price_dollars ?? null,
    yes_bid_dollars: m.yes_bid_dollars ?? null,
    yes_ask_dollars: m.yes_ask_dollars ?? null,
    volume_fp: m.volume_24h_fp ?? m.volume_fp ?? null,
    open_interest_fp: m.open_interest_fp ?? null,
    ts_ms: Date.now(),
  });
}

async function discoverMarkets() {
  const all = [];
  let seeded = 0;
  for (const series of PHASE_1_SERIES) {
    try {
      const markets = await fetchMarketsForSeries(series);
      // KXBTCD returns ALL open hourly events at once (7+ settles inside the
      // current trading window). Without filtering we'd subscribe to 200+
      // bitcoin markets and starve the cap. Narrow to the soonest in-window
      // event — that's the only one the engine ticks on.
      let candidates = markets;
      if (series === 'KXBTCD') {
        const inWindow = markets.filter((m) => {
          const ev = m.event_ticker || toEventTicker(m.ticker);
          const hm = String(ev).match(/(\d{2})$/);
          if (!hm) return false;
          const hour = Number(hm[1]);
          return hour >= 10 && hour <= 16;
        });
        // event_ticker encodes YYMMMDDHH — lexical sort ⇒ chronological.
        inWindow.sort((a, b) =>
          String(a.event_ticker || '').localeCompare(String(b.event_ticker || '')),
        );
        const soonestEvent = inWindow[0]?.event_ticker || null;
        candidates = soonestEvent
          ? inWindow.filter((m) => m.event_ticker === soonestEvent)
          : [];
        if (candidates.length === 0) {
          console.warn(`[kalshi] KXBTCD no in-window event found — skipping WS subscribe`);
        } else {
          console.log(`[kalshi] KXBTCD active event ${soonestEvent} → ${candidates.length} strikes`);
        }
      }
      const sliced = candidates.slice(0, MAX_MARKETS_PER_SERIES);
      const tickers = sliced
        .map((m) => ({ ticker: m.ticker, eventTicker: m.event_ticker || toEventTicker(m.ticker) }))
        .filter((m) => m.ticker);
      for (const m of sliced) seedFromMarket(m);
      seeded += sliced.length;
      seriesIndex.set(series, tickers);
      all.push(...tickers);
      console.log(`[kalshi] discovered ${tickers.length} markets for ${series}`);
    } catch (err) {
      console.warn(`[kalshi] discover ${series} failed`, err?.message || err);
    }
  }

  // Phase 2B: append explicit per-mapping tickers from the arb registry. These
  // are subscribed as exact strings (no series-level discovery) — the registry
  // is the authority on which Fed markets we care about.
  const seen = new Set(all.map((m) => m.ticker));
  for (const ticker of getArbKalshiTickers()) {
    if (seen.has(ticker)) continue;
    all.push({ ticker, eventTicker: toEventTicker(ticker) });
    seen.add(ticker);
  }
  console.log(`[kalshi] arb mappings appended (${getArbKalshiTickers().length} tickers)`);

  if (seeded > 0) {
    // Mark the kalshi feed alive immediately on cold-start so /health doesn't
    // 503 in the gap between connect() and the first ticker frame.
    recordTick('kalshi');
    console.log(`[kalshi] cold-start REST seed populated ${seeded} markets`);
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

// KXBTCD events rotate hourly. Without a periodic re-discover, the WS stays
// subscribed to the prior event's strikes after it settles and the next
// event's strikes never get added. Fire once per hour at HH:00:30 ET — 30s
// after the bitcoin event close so Kalshi's open-markets list has rotated.
let btcResubscribeTimer = null;

function scheduleHourlyBtcResubscribe() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(0, 30, 0);
  if (next <= now) next.setUTCHours(now.getUTCHours() + 1);
  const delay = next.getTime() - now.getTime();
  btcResubscribeTimer = setTimeout(async () => {
    btcResubscribeTimer = null;
    if (stopRequested) return;
    try {
      console.log('[kalshi] hourly KXBTCD resubscribe tick');
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
      await connect();
    } catch (err) {
      console.warn('[kalshi] hourly KXBTCD resubscribe failed', err?.message || err);
    } finally {
      scheduleHourlyBtcResubscribe();
    }
  }, delay);
}

export async function startKalshi() {
  stopRequested = false;
  await connect();
  scheduleHourlyBtcResubscribe();
}

export function stopKalshi() {
  stopRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (btcResubscribeTimer) {
    clearTimeout(btcResubscribeTimer);
    btcResubscribeTimer = null;
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
