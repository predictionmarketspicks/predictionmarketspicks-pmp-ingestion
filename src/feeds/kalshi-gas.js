// Kalshi gas markets REST fetcher.
//
// Fetches KXAAAGASD (daily AAA gas price) + KXAAAGASM (monthly AAA gas price)
// open markets and shapes them for the kalshi_gas_strikes table. The Oracle
// Gas Edge dashboard at /tools/oracle-gas reads from this table; the nightly
// prediction pipeline (oracle-gas-edge) reads "tomorrow's strike" from the
// most-recent rows.
//
// Pattern mirrors feeds/kalshi-macro.js: same kalshiGet retry + withConcurrency
// helpers, same volume_24h_fp filter to drop dead-tail markets. The shape is
// gas-specific (resolution_date + strike + close_time) so consumers can rebuild
// any gas view without a second Kalshi call.
//
// Ticker shapes (verified May 8 2026):
//   Daily:   KXAAAGASD-26MAY09-T4.535        → resolution 2026-05-09, strike 4.535
//   Monthly: KXAAAGASM-26MAY-T5.00           → resolution 2026-05-31, strike 5.00
// The trailing -T<strike> segment is also exposed via the API's floor_strike
// field, which we prefer over ticker-string parsing.

import { kalshiGet, toNum, withConcurrency } from './movers.js';

const KALSHI_API_BASE =
  process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

const KALSHI_REST_CONCURRENCY = Number(process.env.KALSHI_REST_CONCURRENCY || 2);

// Both gas series get hit on every snapshot. Add monthly alongside daily so the
// dashboard's "Aug 31 monthly" / "May 31 monthly" rows populate without a
// second writer.
export const GAS_SERIES = [
  { series: 'KXAAAGASD', cadence: 'daily' },
  { series: 'KXAAAGASM', cadence: 'monthly' },
];

const MONTH_ABBR_TO_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Parse the resolution date encoded in a Kalshi gas event ticker. Tickers
// arrive uppercase from the API (KXAAAGASD-26MAY09); we lowercase before
// matching so handcrafted lowercase tickers in tests still work.
//
// Returns YYYY-MM-DD string or null when the prefix isn't recognized.
export function parseResolutionDate(eventOrMarketTicker) {
  if (typeof eventOrMarketTicker !== 'string') return null;
  const lc = eventOrMarketTicker.toLowerCase();

  // Daily: kxaaagasd-{yy}{mmm}{dd}[-...]
  const daily = lc.match(/^kxaaagasd-(\d{2})([a-z]{3})(\d{2})(?:[-_]|$)/);
  if (daily) {
    const year = 2000 + parseInt(daily[1], 10);
    const monthIdx = MONTH_ABBR_TO_INDEX[daily[2]];
    const day = parseInt(daily[3], 10);
    if (monthIdx == null || !Number.isFinite(day)) return null;
    return formatYmd(year, monthIdx, day);
  }

  // Monthly: kxaaagasm-{yy}{mmm}[-...]  → resolves on the last day of that month
  const monthly = lc.match(/^kxaaagasm-(\d{2})([a-z]{3})(?:[-_]|$)/);
  if (monthly) {
    const year = 2000 + parseInt(monthly[1], 10);
    const monthIdx = MONTH_ABBR_TO_INDEX[monthly[2]];
    if (monthIdx == null) return null;
    // Last day of the month: day 0 of month+1.
    const last = new Date(Date.UTC(year, monthIdx + 1, 0));
    return last.toISOString().slice(0, 10);
  }

  return null;
}

function formatYmd(year, monthIdx, day) {
  const d = new Date(Date.UTC(year, monthIdx, day));
  return d.toISOString().slice(0, 10);
}

// Quotes can land as either dollar strings ('0.82') or cent integers (82).
// Mirrors the toCentsOrNull pattern in kalshi-macro.js but exported here so
// tests can exercise it directly.
export function toCentsOrNull(v) {
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

async function fetchSeriesMarkets(series, cadence, signal) {
  const url = `${KALSHI_API_BASE}/markets?series_ticker=${series}&status=open&limit=200`;
  try {
    const res = await kalshiGet(url, { signal, label: 'gas', userAgent: 'pmp-ingestion/gas' });
    if (!res.ok) return { series, cadence, markets: [] };
    const json = await res.json();
    return { series, cadence, markets: Array.isArray(json?.markets) ? json.markets : [] };
  } catch {
    return { series, cadence, markets: [] };
  }
}

// Returns one row per Kalshi gas market across both series. Shape matches the
// kalshi_gas_strikes columns 1:1 — engine wraps with captured_at + writes.
//
// Filters:
//   - drop markets whose ticker doesn't parse to a resolution date
//   - drop markets with no quote AND no recent volume (kalshi catalog dust)
export async function fetchAllGasStrikes({ timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const results = await withConcurrency(
      GAS_SERIES,
      KALSHI_REST_CONCURRENCY,
      ({ series, cadence }) => fetchSeriesMarkets(series, cadence, controller.signal),
    );
    const rows = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { series, markets } = r.value;
      for (const m of markets) {
        if (typeof m.ticker !== 'string') continue;

        // Prefer the event_ticker for date parsing — it's the stable prefix.
        const sourceTicker = typeof m.event_ticker === 'string' ? m.event_ticker : m.ticker;
        const resolution_date = parseResolutionDate(sourceTicker);
        if (!resolution_date) continue;

        const yes_bid = toCentsOrNull(m.yes_bid_dollars ?? m.yes_bid);
        const yes_ask = toCentsOrNull(m.yes_ask_dollars ?? m.yes_ask);
        const no_bid = toCentsOrNull(m.no_bid_dollars ?? m.no_bid);
        const no_ask = toCentsOrNull(m.no_ask_dollars ?? m.no_ask);
        const last_price = toCentsOrNull(m.last_price_dollars ?? m.last_price);
        const volume_24h = toNum(m.volume_24h_fp ?? m.volume_24h);
        const open_interest = toNumOrNull(m.open_interest_fp ?? m.open_interest);

        // Drop catalog dust: no quote AND no recent volume → not a real market.
        const hasQuote = yes_bid != null || yes_ask != null || last_price != null;
        if (!hasQuote && volume_24h <= 0) continue;

        rows.push({
          ticker: m.ticker,
          series_ticker: series,
          resolution_date,
          strike: toNumOrNull(m.floor_strike ?? m.cap_strike),
          yes_bid,
          yes_ask,
          no_bid,
          no_ask,
          last_price,
          volume_24h,
          open_interest,
          close_time: typeof m.close_time === 'string' ? m.close_time : null,
        });
      }
    }
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

export const __test__ = { parseResolutionDate, toCentsOrNull };
