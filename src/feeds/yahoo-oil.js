// Yahoo Finance feed — CL=F continuous WTI spot + USO options chain.
//
// Replaces the legacy yfinance + GH Actions cron retired 2026-05-04. Free,
// 15-min delayed, unofficial. Yahoo will eventually break this — when it does,
// /health surfaces yahoo_cl_f_spot or yahoo_uso_chain disconnected and the
// operator pivots to a paid feed (Polygon / Databento / EODHD / IBKR).
//
// UA quirk (verified 2026-05-09): Yahoo's bot defense 429s the full
// "Mozilla/5.0 (Macintosh; ...) Chrome/124" UA across every endpoint, but
// responds 200 to a bare "Mozilla/5.0". Spot (v8 chart) works UA-only; the
// options chain endpoint requires a cookie+crumb session (GET fc.yahoo.com
// for cookies, GET /v1/test/getcrumb for the crumb token, then attach both
// to the v7 options call). Crumb rotates infrequently — refresh on 401/403.
//
// Cadence: 15min during US options market hours, 1h off-hours. Matches the
// massive.js pattern; both poll at 15min so option-chain freshness is
// equivalent. Spot endpoint is cheap (no session) so we run it on the same
// schedule rather than tighter.

import { setFeedStatus, recordTick } from '../observability/health.js';
import {
  passesDeltaFilter,
  passesQualityFilters,
  isSpeculativeOption,
} from './massive.js';

const UA = 'Mozilla/5.0';
const YAHOO_QUERY1 = 'https://query1.finance.yahoo.com';
const YAHOO_FC = 'https://fc.yahoo.com/';

const POLL_INTERVAL_MARKET_MS = 15 * 60 * 1000;
const POLL_INTERVAL_OFF_MS = 60 * 60 * 1000;

const SPOT_FEED = 'yahoo_cl_f_spot';
const CHAIN_FEED = 'yahoo_uso_chain';

// --- session state (cookies + crumb) ---

let cookieHeader = ''; // 'name=val; name=val'
let crumb = '';
let crumbAcquiredAt = 0;
const CRUMB_TTL_MS = 60 * 60 * 1000; // refresh hourly even on success

// --- caches ---

let spotCache = null; // { price, publishTimeMs, source }
let chainCache = null; // { fetchedAt, expirationDate, contracts }

// --- timers ---

const timers = new Map();
let stopRequested = false;

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function isOptionsMarketOpen(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

// --- session bootstrap ---
//
// fc.yahoo.com is the canonical cookie-issuer Yahoo's frontend uses. Returns
// 404 with a body but ships the A1/A3 session cookies in Set-Cookie headers.
// We harvest those and reuse for getcrumb.

function parseSetCookie(rawSetCookie) {
  // rawSetCookie can be a single string with multiple cookies separated by
  // commas inside Expires=, or an array (Node fetch returns it concatenated).
  // Cheap parse: split on /,(?=[^;]+=)/ to handle the comma-in-Expires case.
  const out = [];
  if (!rawSetCookie) return out;
  const lines = Array.isArray(rawSetCookie)
    ? rawSetCookie
    : rawSetCookie.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  for (const line of lines) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name && value) out.push(`${name}=${value}`);
  }
  return out;
}

async function refreshSession() {
  const cookieRes = await fetch(YAHOO_FC, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(10_000),
  });
  // 404 is expected and fine — we just want the Set-Cookie headers.
  const setCookie = cookieRes.headers.getSetCookie?.() ?? cookieRes.headers.get('set-cookie');
  const cookies = parseSetCookie(setCookie);
  if (cookies.length === 0) {
    // Yahoo sometimes serves no cookies if the IP is suspect; the crumb call
    // will then 401 and we'll log a clearer error.
    cookieHeader = '';
  } else {
    cookieHeader = cookies.join('; ');
  }

  const crumbRes = await fetch(`${YAHOO_QUERY1}/v1/test/getcrumb`, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/plain',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!crumbRes.ok) {
    throw new Error(`yahoo getcrumb HTTP ${crumbRes.status}`);
  }
  const newCrumb = (await crumbRes.text()).trim();
  if (!newCrumb || newCrumb.length > 64) {
    throw new Error(`yahoo getcrumb invalid response: ${newCrumb.slice(0, 80)}`);
  }
  crumb = newCrumb;
  crumbAcquiredAt = Date.now();
}

async function ensureSession() {
  if (!crumb || Date.now() - crumbAcquiredAt > CRUMB_TTL_MS) {
    await refreshSession();
  }
}

// --- spot ---

async function fetchSpotOnce() {
  const url = `${YAHOO_QUERY1}/v8/finance/chart/CL=F?interval=1m&range=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`yahoo spot HTTP ${res.status}`);
  const j = await res.json();
  const meta = j?.chart?.result?.[0]?.meta;
  const price = num(meta?.regularMarketPrice);
  if (price == null) throw new Error('yahoo spot empty payload');
  const publishTimeMs = (num(meta?.regularMarketTime) ?? Math.floor(Date.now() / 1000)) * 1000;
  return { price, publishTimeMs, source: 'yahoo_cl_f' };
}

async function pollSpotOnce() {
  try {
    spotCache = await fetchSpotOnce();
    recordTick(SPOT_FEED);
    setFeedStatus(SPOT_FEED, { connected: true, lastError: null });
  } catch (err) {
    setFeedStatus(SPOT_FEED, {
      connected: false,
      lastError: (err?.message || String(err)).slice(0, 240),
    });
    console.warn(`[yahoo-oil] spot poll failed: ${err?.message || err}`);
  }
}

// --- options chain ---

function pickExpiryClosestTo(expirationDates, targetUnix) {
  if (!expirationDates?.length) return null;
  return expirationDates.reduce((best, cur) =>
    Math.abs(cur - targetUnix) < Math.abs(best - targetUnix) ? cur : best,
  );
}

// Yahoo contract → engine-internal contract shape. Mirrors massive.js's
// normalizeContract output so the smile builder + filters apply uniformly.
function normalizeYahooContract(c, contractType) {
  return {
    ticker: c.contractSymbol || null,
    contractType, // 'call' | 'put'
    strike: num(c.strike),
    expirationDate: c.expiration ? new Date(c.expiration * 1000).toISOString().slice(0, 10) : null,
    iv: num(c.impliedVolatility),
    delta: null, // Yahoo doesn't publish Greeks; engine treats null delta as filter-pass
    gamma: null,
    theta: null,
    vega: null,
    bid: num(c.bid),
    ask: num(c.ask),
    last: num(c.lastPrice),
    volume24h: num(c.volume),
    openInterest: num(c.openInterest),
    breakEven: null,
    underlyingPrice: null, // populated at row level via chain.quote below
  };
}

async function fetchChainOnce(expirationDateRef) {
  await ensureSession();

  const targetIso = expirationDateRef?.value;
  // Pick the Yahoo expiry closest to the engine's target (Kalshi event close).
  // First call: no `?date=` so Yahoo returns its default expiry plus the full
  // expirationDates list. We use that list to pick the closest, then re-fetch
  // if it's different.
  async function fetchAt(expiryUnix) {
    const url = expiryUnix
      ? `${YAHOO_QUERY1}/v7/finance/options/USO?date=${expiryUnix}&crumb=${encodeURIComponent(crumb)}`
      : `${YAHOO_QUERY1}/v7/finance/options/USO?crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      // Crumb expired or Yahoo dropped our session — refresh once and retry.
      crumb = '';
      await refreshSession();
      const retryUrl = expiryUnix
        ? `${YAHOO_QUERY1}/v7/finance/options/USO?date=${expiryUnix}&crumb=${encodeURIComponent(crumb)}`
        : `${YAHOO_QUERY1}/v7/finance/options/USO?crumb=${encodeURIComponent(crumb)}`;
      const retry = await fetch(retryUrl, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!retry.ok) throw new Error(`yahoo chain HTTP ${retry.status} (post-refresh)`);
      return retry.json();
    }
    if (!res.ok) throw new Error(`yahoo chain HTTP ${res.status}`);
    return res.json();
  }

  // First fetch — picks Yahoo's default expiry, gives us the expirationDates list.
  const j1 = await fetchAt(null);
  const r1 = j1?.optionChain?.result?.[0];
  if (!r1) throw new Error('yahoo chain empty payload');

  let chosen = r1;
  if (targetIso) {
    const targetUnix = Math.floor(new Date(`${targetIso}T00:00:00Z`).getTime() / 1000);
    const picked = pickExpiryClosestTo(r1.expirationDates ?? [], targetUnix);
    const currentUnix = r1.options?.[0]?.expirationDate;
    if (picked && picked !== currentUnix) {
      const j2 = await fetchAt(picked);
      const r2 = j2?.optionChain?.result?.[0];
      if (r2) chosen = r2;
    }
  }

  const underlyingPrice = num(chosen.quote?.regularMarketPrice);
  const calls = (chosen.options?.[0]?.calls ?? []).map((c) => normalizeYahooContract(c, 'call'));
  const puts = (chosen.options?.[0]?.puts ?? []).map((c) => normalizeYahooContract(c, 'put'));

  const contracts = [...calls, ...puts]
    .map((c) => ({ ...c, underlyingPrice })) // commodity-base reads first non-null
    .filter((c) => c.strike != null)
    .filter(passesDeltaFilter) // null delta passes
    .filter(passesQualityFilters)
    .map((c) => ({ ...c, speculative: isSpeculativeOption(c) }));

  const expirationUnix = chosen.options?.[0]?.expirationDate;
  const expirationDate = expirationUnix
    ? new Date(expirationUnix * 1000).toISOString().slice(0, 10)
    : null;

  return { contracts, expirationDate };
}

async function pollChainOnce(expirationDateRef) {
  try {
    const { contracts, expirationDate } = await fetchChainOnce(expirationDateRef);
    chainCache = {
      fetchedAt: Date.now(),
      expirationDate,
      contracts,
    };
    recordTick(CHAIN_FEED);
    setFeedStatus(CHAIN_FEED, { connected: true, lastError: null });
  } catch (err) {
    setFeedStatus(CHAIN_FEED, {
      connected: false,
      lastError: (err?.message || String(err)).slice(0, 240),
    });
    console.warn(`[yahoo-oil] chain poll failed: ${err?.message || err}`);
  }
}

// --- scheduling ---

function scheduleSpot() {
  if (stopRequested) return;
  const delay = isOptionsMarketOpen() ? POLL_INTERVAL_MARKET_MS : POLL_INTERVAL_OFF_MS;
  const t = setTimeout(async () => {
    await pollSpotOnce();
    scheduleSpot();
  }, delay);
  timers.set('spot', t);
}

function scheduleChain(expirationDateRef) {
  if (stopRequested) return;
  const delay = isOptionsMarketOpen() ? POLL_INTERVAL_MARKET_MS : POLL_INTERVAL_OFF_MS;
  const t = setTimeout(async () => {
    await pollChainOnce(expirationDateRef);
    scheduleChain(expirationDateRef);
  }, delay);
  timers.set('chain', t);
}

// --- public API ---

export function startYahooOil(expirationDateRef) {
  stopRequested = false;
  pollSpotOnce().then(() => scheduleSpot());
  pollChainOnce(expirationDateRef).then(() => scheduleChain(expirationDateRef));
  console.log('[yahoo-oil] started spot + chain pollers');
}

export function stopYahooOil() {
  stopRequested = true;
  for (const [k, t] of timers) {
    clearTimeout(t);
    timers.delete(k);
  }
}

export function getOilSpot() {
  return spotCache;
}

export function getUsoChain() {
  return chainCache;
}

export { pickExpiryClosestTo, POLL_INTERVAL_MARKET_MS, POLL_INTERVAL_OFF_MS };
