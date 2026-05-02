// Kalshi macro-mover REST fetcher.
//
// Ports the 22-series watchlist + normalize logic from
// supabase/functions/_shared/macro-movers.ts (Deno) to Node, so the engine can
// own the discord-market-movers cadence going forward (Phase 3).
//
// The Edge Function and this fetcher must produce equivalent Candidate shapes
// during the soak window — engine + Edge Function will both run for ~7 days
// post-Phase-3-merge. Diff drift here = silent disagreement at handoff time.
// Field-fallback order and KXMVE filter are deliberately identical.
//
// Kalshi REST quirk: /markets?series_ticker=... uses the 'limit' param to bound
// page size, not to mean "give me everything"; series with >100 active markets
// would need pagination. The watchlist below all stay <100 in practice.

const KALSHI_API_BASE =
  process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

// Validated live with 24h volume on Apr 23, 2026 (mirrors macro-movers.ts).
// Keep in sync — both surfaces (this fetcher + the Edge Fn shared module) feed
// the same Discord channel during the soak.
export const KALSHI_SERIES = [
  { series: 'KXCPIYOY', category: 'Economics' },
  { series: 'KXGDP', category: 'Economics' },
  { series: 'KXINXY', category: 'Economics' },
  { series: 'KXFED', category: 'Economics' },
  { series: 'KXNBERRECESSQ', category: 'Economics' },

  { series: 'KXNFLMVP', category: 'Sports' },
  { series: 'KXNBAMVP', category: 'Sports' },
  { series: 'KXNFLDRAFTPICK', category: 'Sports' },
  { series: 'KXHEISMAN', category: 'Sports' },
  { series: 'KXSUPERBOWLHEADLINE', category: 'Sports' },
  { series: 'KXUCLTOTAL', category: 'Sports' },
  { series: 'KXMLBF5TOTAL', category: 'Sports' },
  { series: 'KXLALIGABTTS', category: 'Sports' },
  { series: 'KXATPGRANDSLAM', category: 'Sports' },

  { series: 'KXPRESPARTY', category: 'Politics' },
  { series: 'KXIMPEACH', category: 'Politics' },

  { series: 'KXBTCMINY', category: 'Crypto' },
  { series: 'KXBTCMAXY', category: 'Crypto' },
  { series: 'KXBTC15M', category: 'Crypto' },

  { series: 'KXSURVIVOR', category: 'Entertainment' },

  { series: 'KXHURCTOTMAJ', category: 'Weather' },
  { series: 'KXRAINAUSM', category: 'Weather' },
];

export function toCents(v) {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return 0;
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

export function toNum(v) {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

async function fetchSeries(series, category, signal) {
  const url = `${KALSHI_API_BASE}/markets?series_ticker=${series}&status=open&limit=100`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'pmp-ingestion/movers' },
      signal,
    });
    if (!res.ok) return { series, category, items: [] };
    const json = await res.json();
    return { series, category, items: Array.isArray(json?.markets) ? json.markets : [] };
  } catch {
    return { series, category, items: [] };
  }
}

export async function fetchKalshiCandidates({ timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const results = await Promise.allSettled(
      KALSHI_SERIES.map(({ series, category }) =>
        fetchSeries(series, category, controller.signal),
      ),
    );
    const out = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { series, category, items } = r.value;
      for (const m of items) {
        if (typeof m.ticker !== 'string') continue;
        if (m.ticker.startsWith('KXMVE')) continue; // system-wide safety filter
        const yes_price = toCents(
          m.yes_ask_dollars ?? m.yes_bid_dollars ?? m.last_price_dollars,
        );
        const prev_price = toCents(
          m.previous_yes_ask_dollars ??
            m.previous_yes_bid_dollars ??
            m.previous_price_dollars,
        );
        const price_change_24h = prev_price > 0 ? yes_price - prev_price : 0;
        const volume_24h = toNum(m.volume_24h_fp);
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
