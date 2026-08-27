// Pyth price poller — the same XAG/USD feed Kalshi settles its silver weeklies
// on, and XAU/USD for gold. Reads PYTHNET DIRECTLY (see ./pythnet.js); the
// Hermes HTTP API this used to call went behind a $500/month key on 2026-08-26.
// Only the catalogue call below still uses Hermes, because /v2/price_feeds
// remains open and it fails safe (a failed refresh keeps the committed table).
//
// 10s cadence is plenty: Pyth itself updates the on-chain price every ~400ms,
// and Kalshi settles on a snapshot at 5pm ET Friday. Our edge math doesn't
// need sub-second spot.

import { setFeedStatus, recordTick } from '../observability/health.js';
import { fetchPythnetPrice } from './pythnet.js';
import { recordTick as recordPriceTick } from '../engine/short-horizon-vol.js';

// Pyth feed symbols → commodity tags consumed by the short-horizon vol
// estimator. Only listed symbols here get fed into the tick buffer; others
// pass through the price map without short-horizon stats.
const SHORT_HORIZON_COMMODITY = {
  'BTC/USD': 'bitcoin',
  'XAG/USD': 'silver',
  'XAU/USD': 'gold',
  'SPY/USD': 'spx',
  'WTI/USD': 'wti',
};

const HERMES_BASE = process.env.PYTH_HERMES_BASE || 'https://hermes.pyth.network';
const POLL_INTERVAL_MS = 10_000;

// Verified via https://hermes.pyth.network/v2/price_feeds — the IDs Kalshi
// names in its series settlement_sources for the silver/gold weeklies, plus
// the canonical Crypto.BTC/USD feed for KXBTCD.
//
// XCU/USD is intentionally omitted — no validated copper feed. The Phase 2A
// copper engine fails open when getPrice() returns null; see
// docs/COMMODITY_FEEDS.md for the resolution path.
// WTI is NOT in this table on purpose: Pyth serves it as per-expiry futures, so
// its feed id changes on every roll. It resolves dynamically — see the WTI front
// month block below, and ask for it by the logical symbol `WTI/USD`.
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
  'WTI/USD': 'pyth_wti_front_month',
  'XCU/USD': 'pyth_xcu_usd',
};

// ── WTI front month ─────────────────────────────────────────────────────────
// Kalshi's KXWTI15M names `Commodities.Index.PYTHOIL/USD` as its settlement
// source. That feed is DEAD on both public Pyth channels — Hermes `latest` last
// published 2026-03-30 at $103.27 against a ~$75 market, and the Benchmarks API
// does not know the symbol at all. So the named feed cannot be polled.
//
// We measured the alternatives against Kalshi's own published settlement prints
// (`expiration_value` on settled markets) across 200 windows. Verdict agreement:
//
//   front-month WTI future   99.5%   <- this
//   Commodities.USOILSPOT    49.7%   <- the obvious-looking CFD. A coin flip.
//   next contract month      47.4%
//
// Re-run any time: `npx tsx scripts/validate-15m-settlement-feed.ts` in the site
// repo. NOTE the 47.4% row: once a contract stops being the front month it is
// worse than useless, because the poller keeps returning a confident number.
// That is why this resolves by EXPIRY at call time instead of pinning an id.
//
// The table is a committed floor; refreshWtiContracts() merges anything new from
// Pyth's catalogue so a contract listed after this shipped is picked up without
// a deploy.
const WTI_CONTRACTS = new Map(
  Object.entries({
    'Commodities.WTIU6/USD': { id: '0x17d0b3b03f9ccb6bb6721960f034b8601b3d89ef70743b33f86304a1565cebda', expiry: '2026-08-20' },
    'Commodities.WTIV6/USD': { id: '0x9526e04755ebaed86733913b84fe14db4ea165da8f40f97710014cd877fe545b', expiry: '2026-09-22' },
    'Commodities.WTIX6/USD': { id: '0xf8c2191e76f7f4d5335e7f4e8f81ab0df6360d54ee020874222841894203e9d7', expiry: '2026-10-20' },
    'Commodities.WTIZ6/USD': { id: '0x0a76185a3bd608f10216036ee37140112c1c296d4cba31c4e2822f44e8dc0433', expiry: '2026-11-20' },
  }),
);

/** Logical symbol the engines ask for. Never a contract id — that rolls. */
export const WTI_FRONT_MONTH_SYMBOL = 'WTI/USD';

/** Nearest contract whose expiry is still ahead of us, or null if the table has
 *  run dry (loud, because the alternative is silently pricing off a dead one). */
export function resolveWtiFrontMonth(now = Date.now()) {
  let best = null;
  for (const [symbol, meta] of WTI_CONTRACTS) {
    const expiryMs = Date.parse(`${meta.expiry}T00:00:00Z`);
    if (!Number.isFinite(expiryMs) || expiryMs <= now) continue;
    if (!best || expiryMs < best.expiryMs) best = { symbol, id: meta.id, expiryMs };
  }
  return best;
}

/** Merge newly-listed WTI contracts from Pyth's catalogue. Best-effort: a failed
 *  refresh leaves the committed table in place rather than emptying it. */
export async function refreshWtiContracts() {
  try {
    const res = await fetch(`${HERMES_BASE}/v2/price_feeds?asset_type=commodities`, {
      headers: { 'User-Agent': 'pmp-ingestion/0.1', Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`catalogue ${res.status}`);
    const feeds = await res.json();
    let added = 0;
    for (const f of Array.isArray(feeds) ? feeds : []) {
      const symbol = f?.attributes?.symbol ?? '';
      const desc = f?.attributes?.description ?? '';
      if (!/^Commodities\.WTI[A-Z]\d\/USD$/.test(symbol)) continue;
      if (/DEPRECATED/i.test(desc)) continue;
      if (WTI_CONTRACTS.has(symbol)) continue;
      const m = desc.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
      if (!m) continue;
      const d = new Date(`${m[1]} ${m[2]} ${m[3]} 00:00:00 UTC`);
      if (Number.isNaN(d.getTime())) continue;
      WTI_CONTRACTS.set(symbol, { id: `0x${String(f.id).replace(/^0x/, '')}`, expiry: d.toISOString().slice(0, 10) });
      added++;
    }
    if (added) console.log(`[pyth] WTI catalogue refresh: +${added} contract(s)`);
  } catch (err) {
    console.warn(`[pyth] WTI catalogue refresh failed (keeping committed table): ${err?.message || err}`);
  }
}

const priceMap = new Map(); // symbol → { symbol, price, confidence, publishTimeMs, feedId, source }
const timers = new Map();
let stopRequested = false;

function feedKey(symbol) {
  return symbol.replace(/[/]/g, '_').toLowerCase();
}

/** Feed id for a symbol. WTI resolves at CALL TIME so a contract roll needs no
 *  deploy and, more importantly, cannot silently keep pricing off a dead one. */
function feedIdFor(symbol) {
  if (symbol === WTI_FRONT_MONTH_SYMBOL) return resolveWtiFrontMonth()?.id ?? null;
  return FEED_IDS[symbol] ?? null;
}

/** Can we poll this symbol? Callers building a subscription list MUST use this
 *  rather than `FEED_IDS[symbol]` — the WTI front month is resolved dynamically
 *  and is deliberately absent from that table. */
export function hasPythFeed(symbol) {
  return feedIdFor(symbol) != null;
}

async function fetchOnce(symbol) {
  const feedId = feedIdFor(symbol);
  if (!feedId) {
    // Phase 2A: WTI / XCU/USD are registered symbols without verified feed IDs.
    // Throwing here would crash the poller; instead skip silently so the engine
    // sees getPrice(symbol) === null and fails open.
    throw new Error(`pyth feed for ${symbol} not configured (see docs/COMMODITY_FEEDS.md)`);
  }
  // ── Transport swapped to Pythnet, 2026-08-27 ──────────────────────────────
  // Was `${HERMES_BASE}/v2/updates/price/latest`. Pyth's Core upgrade put that
  // endpoint behind a $500/month API key on 2026-08-26 16:00 UTC and every feed
  // here 401'd sixteen minutes later. Hermes is a hosted convenience layer over
  // Pythnet; reading the price account directly gets the identical number for
  // free, from the chain Hermes itself reads.
  //
  // This is deliberately a TRANSPORT change and nothing else. The return shape,
  // the exported functions and SOURCE_TAGS are unchanged, so `getPrice()`
  // callers, the health feed keys (`pyth_xag_usd`, …) and the `spot_source`
  // written to commodity_edge_signals all keep working — and `pyth_xag_usd`
  // stays TRUE, because it is still Pyth. Kalshi settles KXSILVERW/KXGOLDW on
  // these exact feeds, so any non-Pyth substitute would have been wrong here.
  const px = await fetchPythnetPrice(symbol, feedId);
  return {
    symbol,
    price: px.price,
    confidence: px.confidence,
    publishTimeMs: px.publishTimeMs,
    feedId,
    // `trading:false` is a market break (metals close 17:00-18:00 ET, and all
    // weekend), not a fault — the price carried is the last traded one and its
    // real on-chain timestamp rides with it, so commodity-base.js's
    // config.maxSpotAgeMs gate decides usability per snapshot as it always has.
    trading: px.trading,
    source: SOURCE_TAGS[symbol],
  };
}

async function pollOnce(symbol) {
  const key = `pyth_${feedKey(symbol)}`;
  try {
    const px = await fetchOnce(symbol);
    priceMap.set(symbol, px);
    recordTick(key);
    const commodity = SHORT_HORIZON_COMMODITY[symbol];
    if (commodity) recordPriceTick(commodity, px.price, px.publishTimeMs);
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
    if (!feedIdFor(s)) {
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
