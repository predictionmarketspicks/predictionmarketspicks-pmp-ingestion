// Pyth Hermes poller — same XAG/USD feed Kalshi settles its silver weeklies on.
// Public, no auth. We poll because Pyth doesn't offer WebSocket on the free tier.
//
// 10s cadence is plenty: Pyth itself updates the on-chain price every ~400ms,
// and Kalshi settles on a snapshot at 5pm ET Friday. Our edge math doesn't
// need sub-second spot.

import { setFeedStatus, recordTick } from '../observability/health.js';

const HERMES_BASE = process.env.PYTH_HERMES_BASE || 'https://hermes.pyth.network';
const POLL_INTERVAL_MS = 10_000;

// Verified via https://hermes.pyth.network/v2/price_feeds — the IDs Kalshi
// names in its series settlement_sources for the silver/gold weeklies.
export const FEED_IDS = {
  'XAG/USD': '0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e',
  'XAU/USD': '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
};

const SOURCE_TAGS = {
  'XAG/USD': 'pyth_xag_usd',
  'XAU/USD': 'pyth_xau_usd',
};

const priceMap = new Map(); // symbol → { symbol, price, confidence, publishTimeMs, feedId, source }
const timers = new Map();
let stopRequested = false;

function feedKey(symbol) {
  return symbol.replace(/[/]/g, '_').toLowerCase();
}

async function fetchOnce(symbol) {
  const feedId = FEED_IDS[symbol];
  if (!feedId) throw new Error(`unknown pyth symbol ${symbol}`);
  const url = `${HERMES_BASE}/v2/updates/price/latest?ids%5B%5D=0x${feedId.replace(/^0x/, '')}&parsed=true`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'pmp-ingestion/0.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`pyth ${res.status} ${symbol}`);
  const data = await res.json();
  const parsed = Array.isArray(data?.parsed) ? data.parsed : [];
  if (parsed.length === 0) throw new Error(`pyth no parsed price for ${symbol}`);
  const p = parsed[0].price;
  const expo = Number(p.expo);
  const price = Number(p.price) * 10 ** expo;
  const confidence = Number(p.conf) * 10 ** expo;
  return {
    symbol,
    price,
    confidence,
    publishTimeMs: Number(p.publish_time) * 1000,
    feedId,
    source: SOURCE_TAGS[symbol],
  };
}

async function pollOnce(symbol) {
  const key = `pyth_${feedKey(symbol)}`;
  try {
    const px = await fetchOnce(symbol);
    priceMap.set(symbol, px);
    recordTick(key);
    setFeedStatus(key, { connected: true, lastError: null });
  } catch (err) {
    setFeedStatus(key, {
      connected: false,
      lastError: (err?.message || String(err)).slice(0, 240),
    });
    console.warn(`[pyth] ${symbol} poll failed: ${err?.message || err}`);
  }
}

function schedule(symbol) {
  if (stopRequested) return;
  const t = setTimeout(async () => {
    await pollOnce(symbol);
    schedule(symbol);
  }, POLL_INTERVAL_MS);
  timers.set(symbol, t);
}

export function startPyth(symbols = ['XAG/USD']) {
  stopRequested = false;
  for (const s of symbols) {
    pollOnce(s).then(() => schedule(s));
    console.log(`[pyth] started poller for ${s}`);
  }
}

export function stopAllPyth() {
  stopRequested = true;
  for (const [s, t] of timers) {
    clearTimeout(t);
    timers.delete(s);
  }
}

export function getPrice(symbol) {
  return priceMap.get(symbol) || null;
}
