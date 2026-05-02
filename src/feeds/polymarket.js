// Polymarket CLOB WebSocket feed.
//
// Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market (public, no auth).
// Subscribe by sending one JSON frame:
//   { type: 'market', assets_ids: [<yesTokenId1>, <yesTokenId2>, ...] }
//
// Messages observed at first connect are logged in full so docs/POLYMARKET_FIELDS.md
// can be updated against ground truth — Polymarket has historically renamed
// schema fields without notice (build plan §10).
//
// Public observed shapes (subject to drift, log-then-trust):
//   - book        : full L2 snapshot at subscription
//   - price_change: { event_type:'price_change', asset_id, market, changes: [{price, side, size}], timestamp }
//   - tick_size_change : tick size update
//   - last_trade_price : { event_type:'last_trade_price', asset_id, market, price, side, size, fee_rate_bps, timestamp }
//
// We expose getYesPrice(tokenId) for the comparator. Mid is computed from the
// best bid/ask of the YES token's order book; if no L2 is available, last trade
// price is used as a fallback. Both update the in-memory `quoteMap`.

import WebSocket from 'ws';

import { setFeedStatus, recordTick } from '../observability/health.js';

const POLYMARKET_WS_URL =
  process.env.POLYMARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Log full message JSON for the first N frames per connection so we can update
// docs/POLYMARKET_FIELDS.md if the shape drifts.
const RAW_SHAPE_LOG_LIMIT = 5;
let rawShapeLogged = 0;

let ws = null;
let stopRequested = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let pingTimer = null;

let assetIds = [];

// quoteMap key = YES asset_id (string), value = { yesTokenId, mid, bid, ask, last, ts }
const quoteMap = new Map();

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
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
  console.warn(`[polymarket] reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => {
      console.error('[polymarket] reconnect failed', err);
      scheduleReconnect();
    });
  }, delay);
}

// Best-bid / best-ask extraction from an L2 book payload. Polymarket sends the
// full book as `bids` and `asks` arrays of { price, size }. We pick the best on
// each side.
function deriveQuoteFromBook(book) {
  const pickBest = (rows, asc) => {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    let best = null;
    for (const r of rows) {
      const p = num(r?.price);
      const s = num(r?.size);
      if (p == null || s == null || s <= 0) continue;
      if (best == null || (asc ? p < best : p > best)) best = p;
    }
    return best;
  };
  // YES bid is the highest buy; YES ask is the lowest sell.
  const bid = pickBest(book?.bids || book?.buys, false);
  const ask = pickBest(book?.asks || book?.sells, true);
  let mid = null;
  if (bid != null && ask != null) mid = (bid + ask) / 2;
  else if (bid != null) mid = bid;
  else if (ask != null) mid = ask;
  return { bid, ask, mid };
}

function applyMessage(parsed) {
  if (!parsed) return;
  const eventType = parsed.event_type || parsed.type;
  if (rawShapeLogged < RAW_SHAPE_LOG_LIMIT) {
    rawShapeLogged += 1;
    console.log(
      `[polymarket:shape ${rawShapeLogged}/${RAW_SHAPE_LOG_LIMIT}]`,
      JSON.stringify(parsed).slice(0, 600),
    );
  }

  const tokenId = parsed.asset_id || parsed.market;
  if (!tokenId) return;
  const prev = quoteMap.get(tokenId) || { yesTokenId: tokenId };
  const next = { ...prev };
  const ts =
    typeof parsed.timestamp === 'number'
      ? parsed.timestamp
      : typeof parsed.timestamp === 'string'
      ? Number.parseInt(parsed.timestamp, 10)
      : null;
  if (Number.isFinite(ts)) next.ts = ts;

  if (eventType === 'book' || (parsed.bids && parsed.asks)) {
    const { bid, ask, mid } = deriveQuoteFromBook(parsed);
    if (bid != null) next.bid = bid;
    if (ask != null) next.ask = ask;
    if (mid != null) next.mid = mid;
  } else if (eventType === 'price_change' && Array.isArray(parsed.changes)) {
    // Apply each level change. We don't keep the full book in memory — just the
    // best bid / ask we see. A full L2 walk on every tick would be expensive
    // for marginal gain in v1; the periodic comparator reads `mid` directly.
    for (const ch of parsed.changes) {
      const p = num(ch?.price);
      const s = num(ch?.size);
      const side = ch?.side; // 'BUY' or 'SELL'
      if (p == null || s == null) continue;
      if (s <= 0) continue;
      if (side === 'BUY' && (next.bid == null || p > next.bid)) next.bid = p;
      if (side === 'SELL' && (next.ask == null || p < next.ask)) next.ask = p;
    }
    if (next.bid != null && next.ask != null) next.mid = (next.bid + next.ask) / 2;
  } else if (eventType === 'last_trade_price') {
    const p = num(parsed.price);
    if (p != null) next.last = p;
    // Use last as mid only when we have no two-sided book.
    if (next.mid == null && p != null) next.mid = p;
  } else {
    return; // unknown shape — already logged by rawShape capture
  }

  quoteMap.set(tokenId, next);
  recordTick('polymarket');
}

async function connect() {
  if (assetIds.length === 0) {
    setFeedStatus('polymarket', { connected: false, lastError: 'no_asset_ids' });
    throw new Error('no asset_ids registered for polymarket feed');
  }

  console.log(`[polymarket] connecting to ${POLYMARKET_WS_URL} (${assetIds.length} assets)`);
  ws = new WebSocket(POLYMARKET_WS_URL);

  ws.on('open', () => {
    reconnectAttempts = 0;
    setFeedStatus('polymarket', { connected: true, lastError: null });
    rawShapeLogged = 0;
    const sub = { type: 'market', assets_ids: assetIds };
    ws.send(JSON.stringify(sub));
    console.log(`[polymarket] subscribed market channel on ${assetIds.length} assets`);

    // Keep-alive ping every 25s. CLOB closes idle connections silently.
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      try {
        if (ws?.readyState === WebSocket.OPEN) ws.ping();
      } catch {
        /* ignore */
      }
    }, 25_000);
  });

  ws.on('message', (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (Array.isArray(parsed)) {
      // CLOB sometimes batches multiple events into a single frame.
      for (const m of parsed) applyMessage(m);
    } else {
      applyMessage(parsed);
    }
  });

  ws.on('close', (code, reason) => {
    setFeedStatus('polymarket', {
      connected: false,
      lastError: `closed:${code}:${reason?.toString?.() || ''}`,
    });
    console.warn(`[polymarket] closed code=${code} reason=${reason?.toString?.() || ''}`);
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    ws = null;
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    setFeedStatus('polymarket', { lastError: err?.message || String(err) });
    console.error('[polymarket] ws error', err?.message || err);
  });
}

export async function startPolymarket(tokenIds) {
  stopRequested = false;
  assetIds = Array.from(new Set(tokenIds.filter(Boolean)));
  await connect();
}

export function stopPolymarket() {
  stopRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
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

// Read accessors for the comparator.

export function getYesQuote(tokenId) {
  return quoteMap.get(tokenId) || null;
}

export function getQuoteCount() {
  return quoteMap.size;
}
