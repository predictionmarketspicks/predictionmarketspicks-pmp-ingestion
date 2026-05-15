// Kalshi macro-mover REST fetcher.
//
// Ports the watchlist + normalize logic from
// supabase/functions/_shared/macro-movers.ts (Deno) to Node, so the engine can
// own the discord-market-movers cadence going forward (Phase 3).
//
// The Edge Function and this fetcher must produce equivalent Candidate shapes
// during the soak window — engine + Edge Function will both run for ~7 days
// post-Phase-3-merge. Diff drift here = silent disagreement at handoff time.
// Field-fallback order and KXMVE filter are deliberately identical.
//
// Kalshi REST quirk: /markets?series_ticker=... uses the 'limit' param as page
// size; 200 is the max page Kalshi will return. With the volume_24h_fp > 0
// filter applied downstream, no series in this watchlist exceeds 200 active +
// non-zero-vol markets in practice. If that ever changes the writer needs
// cursor pagination.
//
// Concurrency: Kalshi REST throttles ~7 simultaneous /markets calls. Earlier
// versions ran all series in parallel and silently lost ~7 series per scan to
// 429s (kalshi-macro.js suffered the same). withConcurrency caps in-flight
// requests so every series gets a fair shot.

const KALSHI_API_BASE =
  process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

const KALSHI_REST_CONCURRENCY = Number(process.env.KALSHI_REST_CONCURRENCY || 2);
const KALSHI_REST_RETRY_DELAY_MS = Number(process.env.KALSHI_REST_RETRY_DELAY_MS || 600);

// Single source of truth for what the macro engine ingests into
// macro_market_snapshots. Curated 2026-05-15 — every series here has a
// verified site/edge-fn consumer. Sports beyond KXNBAGAME, World Cup KXWC*,
// and NFL future-pick series intentionally excluded:
//   - KXNBAGAME → lib/api/draftkings-page.ts (DK NBA comparison)
//   - World Cup → world_cup_market_snapshot table (separate writer)
//   - NFL games → nfl_weekly_edges / Gridiron Edge pipeline (separate)
//   - KXNFLMVP/KXNBAMVP/KXHEISMAN/etc → no consumer, retire
// Add a series here ONLY when a consumer is shipping that reads it.
export const KALSHI_SERIES = [
  // Economics (5)
  { series: 'KXCPIYOY',      category: 'Economics' },
  { series: 'KXGDP',         category: 'Economics' },
  { series: 'KXINXY',        category: 'Economics' },
  { series: 'KXFED',         category: 'Economics' },
  { series: 'KXNBERRECESSQ', category: 'Economics' },

  // Sports — DK comparison only
  { series: 'KXNBAGAME', category: 'Sports' },

  // Politics (3) — KXNEWOUTBREAK added per macro-movers.ts (Hantavirus momentum play, sunset 2026-06-15)
  { series: 'KXPRESPARTY',   category: 'Politics' },
  { series: 'KXIMPEACH',     category: 'Politics' },
  { series: 'KXNEWOUTBREAK', category: 'Politics' },

  // Crypto (4)
  { series: 'KXBTCMINY', category: 'Crypto' },
  { series: 'KXBTCMAXY', category: 'Crypto' },
  { series: 'KXBTC15M',  category: 'Crypto' },
  { series: 'KXETH',     category: 'Crypto' },

  // Entertainment (1)
  { series: 'KXSURVIVOR', category: 'Entertainment' },

  // Weather (2)
  { series: 'KXHURCTOTMAJ', category: 'Weather' },
  { series: 'KXRAINAUSM',   category: 'Weather' },
];

// Sliding-window concurrency limiter. Returns Promise.allSettled-shape results
// so callers don't have to change. Used by both fetchKalshiCandidates and the
// macro writer in kalshi-macro.js.
export async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = { status: 'fulfilled', value: await fn(items[idx]) };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function toCents(v) {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return 0;
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

export function toNum(v) {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

// Single GET with up to 3 retries on 429. Linear backoff at
// KALSHI_REST_RETRY_DELAY_MS unless server sent Retry-After. Local testing
// shows Kalshi REST throttles ~5 req/sec per IP; 3 retries at 600ms covers a
// full 1.8s burst without dropping the series.
export async function kalshiGet(url, { signal, label = 'kalshi', userAgent = 'pmp-ingestion' } = {}) {
  const maxAttempts = 4;
  let res;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal,
    });
    if (res.status !== 429) return res;
    if (attempt === maxAttempts - 1) {
      console.warn(`[${label}] kalshi 429 — gave up after ${maxAttempts} attempts`);
      return res;
    }
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : KALSHI_REST_RETRY_DELAY_MS;
    console.warn(`[${label}] kalshi 429 — retrying after ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return res;
}

async function fetchSeries(series, category, signal) {
  const url = `${KALSHI_API_BASE}/markets?series_ticker=${series}&status=open&limit=200`;
  try {
    const res = await kalshiGet(url, { signal, label: 'movers', userAgent: 'pmp-ingestion/movers' });
    if (!res.ok) return { series, category, items: [] };
    const json = await res.json();
    return { series, category, items: Array.isArray(json?.markets) ? json.markets : [] };
  } catch {
    return { series, category, items: [] };
  }
}

export async function fetchKalshiCandidates({ timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const results = await withConcurrency(KALSHI_SERIES, KALSHI_REST_CONCURRENCY, ({ series, category }) =>
      fetchSeries(series, category, controller.signal),
    );
    const out = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { series, category, items } = r.value;
      for (const m of items) {
        if (typeof m.ticker !== 'string') continue;
        if (m.ticker.startsWith('KXMVE')) continue; // system-wide safety filter
        const volume_24h = toNum(m.volume_24h_fp);
        if (volume_24h <= 0) continue; // drop dead markets — keep payload tight
        const yes_price = toCents(
          m.yes_ask_dollars ?? m.yes_bid_dollars ?? m.last_price_dollars,
        );
        const prev_price = toCents(
          m.previous_yes_ask_dollars ??
            m.previous_yes_bid_dollars ??
            m.previous_price_dollars,
        );
        const price_change_24h = prev_price > 0 ? yes_price - prev_price : 0;
        out.push({
          source: 'kalshi',
          seriesOrSlug: series,
          ticker: m.ticker,
          title: m.title ?? m.subtitle ?? m.ticker,
          yes_price,
          volume_24h,
          price_change_24h,
          category,
          close_time: m.close_time,
        });
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
