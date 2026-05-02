// Massive REST poller (was Polygon pre-rebrand).
//
// Architecture decision per BUILD_PLAN §6: REST polling primary, WebSocket
// deferred to v2. Massive's /v3/snapshot/options/{underlyingAsset} returns
// fully-computed Greeks + IV server-side on the Options Advanced tier — that
// collapses our pipeline from "subscribe → solve IV in JS" to "fetch chain →
// take their IV". Brent's-method solver in src/engine/options.js stays as a
// fallback for null-IV strikes (deep ITM with no live two-sided quote).
//
// Bridge week (now → Mon May 4 / Tue May 5): paid 15-min delayed tier.
// Same URL, same response shape — Massive flips real-time server-side based
// on the API key. WRITER_TAG=delayed_test gates these rows out of production
// reads in the meantime.
//
// Auth: Bearer header, NOT query param. Plan §6 spec. Some Massive endpoints
// also accept ?apiKey= as a fallback; we use the header form so the key never
// shows up in any URL log.

import { setFeedStatus, recordTick } from '../observability/health.js';
import { DELTA_FILTER_MIN, DELTA_FILTER_MAX } from '../engine/thresholds.js';

const MASSIVE_BASE = process.env.MASSIVE_API_BASE || 'https://api.massive.com';

// Cadence per BUILD_PLAN §9: 5s during US options market hours, 60s off-hours.
// Off-hours cadence still runs so cold-start latency after a restart is small.
const POLL_INTERVAL_MARKET_MS = 5_000;
const POLL_INTERVAL_OFF_MS = 60_000;

// Limit the chain pull to plausibly-near-the-money strikes. Massive returns up
// to 250 contracts per page; SLV weekly chains are ~40-60 strikes per side, so
// 250 covers both sides plus headroom.
const CHAIN_LIMIT = 250;

// Per-underlying chain cache. Key = underlying, value = { fetchedAt, expirationDate, contracts }.
const chainCache = new Map();

let stopRequested = false;
const timers = new Map(); // underlying → setTimeout id

// US options market hours: Mon–Fri 9:30 AM – 4:00 PM ET. We approximate by
// converting "now" to ET via toLocaleString and checking the ET wall clock.
// This handles DST automatically without pulling in a tz library.
function isOptionsMarketOpen(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Massive snapshot row → engine-internal contract shape.
function normalizeContract(c) {
  const details = c?.details || {};
  const greeks = c?.greeks || {};
  const lastQuote = c?.last_quote || {};
  const lastTrade = c?.last_trade || {};
  return {
    ticker: details.ticker || c.ticker || null,
    contractType: details.contract_type || null, // 'call' | 'put'
    strike: num(details.strike_price),
    expirationDate: details.expiration_date || null,
    iv: num(c.implied_volatility),
    delta: num(greeks.delta),
    gamma: num(greeks.gamma),
    theta: num(greeks.theta),
    vega: num(greeks.vega),
    bid: num(lastQuote.bid),
    ask: num(lastQuote.ask),
    last: num(lastTrade.price),
    openInterest: num(c.open_interest),
    breakEven: num(c.break_even_price),
    underlyingPrice: num(c.underlying_asset?.price),
  };
}

// Plan §10 delta filter — `0.15 ≤ |Δ| ≤ 0.85` to keep the in-memory map
// manageable across four ETFs. Missing-delta passthrough so the bridge-week
// 15-min-delayed tier (which returns greeks: {}) still produces a chain.
// After Mon/Tue real-time cutover, greeks populate live and the filter
// activates — chain shrinks from ~250 contracts → ~50–80 per ETF.
function passesDeltaFilter(c) {
  if (c.delta == null) return true;
  const abs = Math.abs(c.delta);
  return abs >= DELTA_FILTER_MIN && abs <= DELTA_FILTER_MAX;
}

async function fetchChain(underlying, expirationDate) {
  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) throw new Error('MASSIVE_API_KEY not set');

  const params = new URLSearchParams({ limit: String(CHAIN_LIMIT) });
  if (expirationDate) params.set('expiration_date', expirationDate);
  const url = `${MASSIVE_BASE}/v3/snapshot/options/${underlying}?${params}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`massive ${res.status} ${url.replace(apiKey, '<redacted>')}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const results = Array.isArray(json?.results) ? json.results : [];
  return results
    .map(normalizeContract)
    .filter((c) => c.strike != null)
    .filter(passesDeltaFilter);
}

async function pollOnce(underlying, expirationDateRef) {
  try {
    const expDate = expirationDateRef.value;
    const contracts = await fetchChain(underlying, expDate);
    chainCache.set(underlying, {
      fetchedAt: Date.now(),
      expirationDate: expDate,
      contracts,
    });
    recordTick(`massive_${underlying.toLowerCase()}`);
    setFeedStatus(`massive_${underlying.toLowerCase()}`, {
      connected: true,
      lastError: null,
    });
  } catch (err) {
    console.warn(`[massive] poll ${underlying} failed: ${err?.message || err}`);
    setFeedStatus(`massive_${underlying.toLowerCase()}`, {
      connected: false,
      lastError: (err?.message || String(err)).slice(0, 240),
    });
  }
}

function schedule(underlying, expirationDateRef) {
  if (stopRequested) return;
  const delay = isOptionsMarketOpen() ? POLL_INTERVAL_MARKET_MS : POLL_INTERVAL_OFF_MS;
  const t = setTimeout(async () => {
    await pollOnce(underlying, expirationDateRef);
    schedule(underlying, expirationDateRef);
  }, delay);
  timers.set(underlying, t);
}

// Public API.

export function startMassivePoller(underlying, expirationDateRef) {
  stopRequested = false;
  // Kick off immediately so the cache fills before the first engine snapshot.
  pollOnce(underlying, expirationDateRef).then(() => schedule(underlying, expirationDateRef));
  console.log(`[massive] started poller for ${underlying}`);
}

export function stopMassivePoller(underlying) {
  const t = timers.get(underlying);
  if (t) {
    clearTimeout(t);
    timers.delete(underlying);
  }
}

export function stopAllMassivePollers() {
  stopRequested = true;
  for (const [u, t] of timers) {
    clearTimeout(t);
    timers.delete(u);
  }
}

export function getChain(underlying) {
  return chainCache.get(underlying) || null;
}

// Underlying ETF previous-day close. Available on the Options Advanced tier
// (the live stocks endpoints `/v2/snapshot/...` and `/v1/last/stocks/...`
// return 403 NOT_AUTHORIZED on options-only plans).
//
// The engine uses this as the ETF underlying price when the options chain
// itself doesn't carry `underlying_asset.price` (15-min delayed tier off-hours,
// or quiet weekends). Real-time tier on Options Advanced fills the chain's
// underlying price live, so this is a bridge-week / off-hours fallback.
//
// Cached for 1 hour because previous-close moves once per day at most.
const prevCloseCache = new Map(); // ticker → { fetchedAt, close }
const PREV_CLOSE_TTL_MS = 60 * 60 * 1000;

export async function fetchPrevClose(ticker) {
  const cached = prevCloseCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < PREV_CLOSE_TTL_MS) {
    return cached.close;
  }
  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) throw new Error('MASSIVE_API_KEY not set');
  const url = `${MASSIVE_BASE}/v2/aggs/ticker/${ticker}/prev?adjusted=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`massive prev ${ticker} ${res.status}`);
  const json = await res.json();
  const close = num(json?.results?.[0]?.c);
  if (close == null) throw new Error(`massive prev ${ticker}: no close in response`);
  prevCloseCache.set(ticker, { fetchedAt: Date.now(), close });
  return close;
}

export { isOptionsMarketOpen, passesDeltaFilter };
