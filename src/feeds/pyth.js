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
// names in its series settlement_sources for the silver/gold weeklies, plus
// the canonical Crypto.BTC/USD feed for KXBTCD.
//
// WTI and XCU/USD are intentionally omitted — Pyth Hermes serves WTI as
// per-expiry futures (not continuous) and we have no validated copper feed.
// The Phase 2A engines for oil/copper fail open when getPrice() returns null;
// see docs/COMMODITY_FEEDS.md for the resolution path.
// SPY/USD is Pyth's regular-session SPY ETF feed (Equity.US.SPY/USD), schedule
// 0930-1600 ET — exactly the KXINXU trading window per Kalshi contract terms,
// so we don't need the .PRE / .POST / .ON session-gated variants. Last-trade
// verified 2026-05-21 16:00 ET via Hermes ($740.95). The SPX engine's edge
// calc uses SPY as the spot; commodity-base.js's `ratio = etfPrice / spotPrice`
// (line ~356) auto-handles the ~3-5bp SPY-ETF ↔ .INX-cash basis the same way
// BTC's bridge from BTC/USD to IBIT strikes already does.
export const FEED_IDS = {
  'XAG/USD': '0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e',
  'XAU/USD': '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
  'BTC/USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'SPY/USD': '0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
};

const SOURCE_TAGS = {
  'XAG/USD': 'pyth_xag_usd',
  'XAU/USD': 'pyth_xau_usd',
  'BTC/USD': 'pyth_btc_usd',
  'SPY/USD': 'pyth_spy_usd',
  WTI: 'pyth_wti',
  'XCU/USD': 'pyth_xcu_usd',
};

const priceMap = new Map(); // symbol → { symbol, price, confidence, publishTimeMs, feedId, source }
const timers = new Map();
let stopRequested = false;

function feedKey(symbol) {
  return symbol.replace(/[/]/g, '_').toLowerCase();
}

async function fetchOnce(symbol) {
  const feedId = FEED_IDS[symbol];
  if (!feedId) {
    // Phase 2A: WTI / XCU/USD are registered symbols without verified feed IDs.
    // Throwing here would crash the poller; instead skip silently so the engine
    // sees getPrice(symbol) === null and fails open.
    throw new Error(`pyth feed for ${symbol} not configured (see docs/COMMODITY_FEEDS.md)`);
  }
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
    if (!FEED_IDS[s]) {
      console.warn(`[pyth] ${s} has no verified feed ID — poller skipped (engine will fail open)`);
      setFeedStatus(`pyth_${feedKey(s)}`, {
        connected: false,
        lastError: 'feed_id_unverified',
      });
      continue;
    }
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
