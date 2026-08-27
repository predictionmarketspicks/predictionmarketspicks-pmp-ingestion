// BRTI-constituent BTC/USD spot basket — the free replacement for Pyth BTC/USD.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// Pyth ran a "Core upgrade" on 2026-08-26 16:00 UTC that made Hermes require an
// API key. Our four Pyth feeds died at 16:16:05 UTC that day, all within 244ms
// of each other, and stayed 401 for 28h before anyone noticed. See
// handoffs/BITCOIN_EDGE_PAGE_READS_DECAYED_STATE_2026-08-27.md.
//
// The important part is not the outage. It is that for BTC, Pyth was never the
// right feed in the first place. Kalshi settles KXBTCD on a 60-second TWAP of
// the **CF Benchmarks BRTI** (confirmed live from Kalshi's own series endpoint:
// settlement_sources = [{name: "CF Benchmarks", url: cfbenchmarks.com/.../BRTI}]).
// Pyth BTC/USD is its own aggregate — a proxy for BRTI, correlated but not it.
//
// BRTI is COMPUTED from a basket of spot exchanges. Four of them publish free,
// keyless tickers: Coinbase, Kraken, Bitstamp and Gemini are all current BRTI
// constituent exchanges (CF Benchmarks "CME CF Constituent Exchanges", and
// verified against the BRTI methodology on 2026-08-27). So polling them and
// taking a median is not a downgrade from Pyth — it moves us one step CLOSER to
// the number the contract actually settles on, for $0.
//
// Measured at build time, all four live within 0.014% of each other:
//     Coinbase 80048.89 · Kraken 80050.00 · Bitstamp 80055.33 · Gemini 80044.17
//
// ⚠️ This is deliberately NOT extended to silver/gold. Kalshi settles KXSILVERW
// and KXGOLDW on **Pyth itself** (settlement_sources = "Pyth - Silver" /
// "Pyth - Gold"). Swapping those to a free substitute would price us against a
// different number than the one that settles the contract — basis risk we would
// be introducing, not removing. Metals need a real Pyth key. Do not "finish the
// job" by pointing XAG/XAU here.
//
// ── Why a basket rather than one exchange ────────────────────────────────────
//
// A single vendor is exactly what just bit us: one Pyth cutover took all four
// commodities dark simultaneously. A median over N independent venues has no
// single point of failure, and a venue printing a bad tick gets outvoted rather
// than believed. We require MIN_SOURCES responses before publishing a price at
// all — degrade honestly instead of quietly pricing off one exchange.

import { setFeedStatus, recordTick } from '../observability/health.js';
import { recordTick as recordPriceTick } from '../engine/short-horizon-vol.js';

const POLL_INTERVAL_MS = 10_000; // matches the Pyth poller this replaces
const FETCH_TIMEOUT_MS = 8_000;

/** Publish nothing below this many live sources. Two is enough to cross-check;
 *  one is just an unlabelled single-exchange feed wearing a basket's name. */
const MIN_SOURCES = 2;

export const BTC_SYMBOL = 'BTC/USD';
export const BRTI_SOURCE_TAG = 'brti_basket';

/** All four are current BRTI constituent exchanges. Public endpoints, no key.
 *  `parse` returns a positive finite USD price or throws. */
const SOURCES = [
  {
    name: 'coinbase',
    url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    parse: (d) => Number(d.price),
  },
  {
    name: 'kraken',
    url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    // Kraken keys the result by its own pair code (XXBTZUSD), which has changed
    // before — read the single value rather than hardcoding the key.
    parse: (d) => Number(Object.values(d.result)[0].c[0]),
  },
  {
    name: 'bitstamp',
    url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    parse: (d) => Number(d.last),
  },
  {
    name: 'gemini',
    url: 'https://api.gemini.com/v1/pubticker/btcusd',
    parse: (d) => Number(d.last),
  },
];

let latest = null; // { symbol, price, confidence, publishTimeMs, source, sources }
let timer = null;
let stopRequested = false;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function fetchSource(src) {
  const res = await fetch(src.url, {
    headers: { 'User-Agent': 'pmp-ingestion/0.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${src.name} ${res.status}`);
  const price = src.parse(await res.json());
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${src.name} bad price`);
  return price;
}

async function pollOnce() {
  const results = await Promise.allSettled(SOURCES.map(fetchSource));
  const prices = [];
  const live = [];

  results.forEach((r, i) => {
    const src = SOURCES[i];
    const key = `brti_${src.name}`;
    if (r.status === 'fulfilled') {
      prices.push(r.value);
      live.push(src.name);
      setFeedStatus(key, { connected: true, lastError: null });
      recordTick(key);
    } else {
      setFeedStatus(key, {
        connected: false,
        lastError: (r.reason?.message || String(r.reason)).slice(0, 240),
      });
    }
  });

  if (prices.length < MIN_SOURCES) {
    // Leave `latest` alone rather than overwriting it with a worse estimate, but
    // do NOT refresh lastTickAt — the readiness gate must see this as stale.
    // Freezing a price while still reporting the feed healthy is the exact
    // failure this module was written after.
    setFeedStatus(BRTI_SOURCE_TAG, {
      connected: false,
      lastError: `only ${prices.length}/${SOURCES.length} BRTI sources responded (need ${MIN_SOURCES})`,
    });
    console.warn(`[brti] ${prices.length}/${SOURCES.length} sources — holding, not publishing`);
    return;
  }

  const price = median(prices);
  const publishTimeMs = Date.now();
  // Dispersion across venues, as a Pyth-comparable confidence band. Half the
  // spread is the honest analogue: it widens exactly when the venues disagree.
  const confidence = (Math.max(...prices) - Math.min(...prices)) / 2;

  latest = {
    symbol: BTC_SYMBOL,
    price,
    confidence,
    publishTimeMs,
    source: BRTI_SOURCE_TAG,
    sources: live,
  };

  recordTick(BRTI_SOURCE_TAG);
  setFeedStatus(BRTI_SOURCE_TAG, { connected: true, lastError: null });
  // Feeds the short-horizon vol buffer that supplies sigma/mu for the TWAP
  // model. Without this the engine falls back to shortHorizonVolScale and tags
  // every row quality_flag='cold_buffer' — i.e. skipping it looks like it works
  // and silently degrades every snapshot.
  recordPriceTick('bitcoin', price, publishTimeMs);
}

function schedule() {
  if (stopRequested) return;
  timer = setTimeout(async () => {
    await pollOnce();
    schedule();
  }, POLL_INTERVAL_MS);
}

export function startBrtiSpot() {
  stopRequested = false;
  setFeedStatus(BRTI_SOURCE_TAG, { connected: false, lastError: 'starting' });
  // Fire immediately so a cold start doesn't wait a full interval for spot.
  pollOnce().finally(schedule);
}

export function stopBrtiSpot() {
  stopRequested = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Same shape `getPrice()` returns from pyth.js, so commodity-base.js can treat
 *  the two interchangeably. Null until MIN_SOURCES have answered at least once. */
export function getBrtiSpot() {
  return latest;
}
