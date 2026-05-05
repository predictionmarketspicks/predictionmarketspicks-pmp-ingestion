// Kalshi macro markets REST fetcher — full per-market shape.
//
// Distinct from feeds/movers.js which collapses each market to a single
// `Candidate` row (yes_price/volume/24h-change). The macro snapshot writer
// needs the raw fields (yes_bid, yes_ask, last, OI, prev_*, close_time) so
// downstream consumers can rebuild any view without a second Kalshi call.
//
// Reuses the watchlist + concurrency limiter from feeds/movers.js — single
// source of truth for which series the engine tracks. KXMVE filter (sports
// parlay junk) stays in place; without it Kalshi's catalog dumps ~2800
// zero-vol markets at us.
//
// Pre-2026-05-04 this fan-out used Promise.allSettled with no concurrency cap.
// Kalshi REST throttled ~7 of 22 simultaneous calls with 429s, which the old
// catch silently turned into empty arrays — a quiet loss of ~7 series per
// snapshot for weeks. withConcurrency caps in-flight requests; the 429 branch
// below now logs explicitly so the next regression is visible.

import { KALSHI_SERIES, toCents, toNum, withConcurrency, kalshiGet } from './movers.js';

const KALSHI_API_BASE =
  process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

const KALSHI_REST_CONCURRENCY = Number(process.env.KALSHI_REST_CONCURRENCY || 2);

async function fetchSeriesMarkets(series, category, signal) {
  const url = `${KALSHI_API_BASE}/markets?series_ticker=${series}&status=open&limit=200`;
  try {
    const res = await kalshiGet(url, { signal, label: 'macro', userAgent: 'pmp-ingestion/macro' });
    if (!res.ok) return { series, category, markets: [] };
    const json = await res.json();
    return { series, category, markets: Array.isArray(json?.markets) ? json.markets : [] };
  } catch {
    // Network error / abort. Caller logs at the engine layer if every series fails.
    return { series, category, markets: [] };
  }
}

// Returns one row per Kalshi market across the watchlist (zero-vol markets
// dropped). Shape matches macro_market_snapshots columns 1:1 — the engine
// wraps this in snapshot_at + writes directly.
//
// Field-fallback order for yes_price/prev_price mirrors macro-movers.ts so
// downstream readers see identical numbers whether they hit Kalshi directly
// (legacy) or this table (Session 3).
export async function fetchAllMacroMarkets({ timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const results = await withConcurrency(KALSHI_SERIES, KALSHI_REST_CONCURRENCY, ({ series, category }) =>
      fetchSeriesMarkets(series, category, controller.signal),
    );
    const rows = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { series, category, markets } = r.value;
      for (const m of markets) {
        if (typeof m.ticker !== 'string') continue;
        if (m.ticker.startsWith('KXMVE')) continue; // catalog-wide safety filter

        const volume_24h = toNum(m.volume_24h_fp);
        if (volume_24h <= 0) continue; // drop dead markets

        const yes_bid_cents = toCentsOrNull(m.yes_bid_dollars);
        const yes_ask_cents = toCentsOrNull(m.yes_ask_dollars);
        const last_price_cents = toCentsOrNull(m.last_price_dollars);
        const prev_yes_ask_cents = toCentsOrNull(m.previous_yes_ask_dollars);
        const prev_yes_bid_cents = toCentsOrNull(m.previous_yes_bid_dollars);
        const prev_price_cents = toCentsOrNull(m.previous_price_dollars);

        // implied_pct mirrors the field-fallback order used by tweet-daily-pick
        // and discord-market-movers. Stored as a percentage (0–100), not 0–1.
        const implied_pct = toCents(
          m.yes_ask_dollars ?? m.yes_bid_dollars ?? m.last_price_dollars,
        );

        rows.push({
          series_ticker: series,
          category,
          event_ticker: typeof m.event_ticker === 'string' ? m.event_ticker : null,
          ticker: m.ticker,
          title: m.title ?? m.subtitle ?? m.ticker,
          strike: toNumOrNull(m.floor_strike ?? m.cap_strike),
          yes_bid_cents,
          yes_ask_cents,
          last_price_cents,
          prev_yes_ask_cents,
          prev_yes_bid_cents,
          prev_price_cents,
          volume_24h,
          open_interest: toIntOrNull(m.open_interest_fp ?? m.open_interest),
          implied_pct,
          close_time: typeof m.close_time === 'string' ? m.close_time : null,
        });
      }
    }
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

// Cents helpers that preserve null instead of coercing to 0 — the table column
// is INTEGER NULLABLE and we want "no quote yet" to read as NULL, not 0.
function toCentsOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

function toNumOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

export const __test__ = { toCentsOrNull, toNumOrNull, toIntOrNull };
