// Yahoo Finance daily-close history for ETF spots.
//
// Ported from scripts/backtest-calibration.js (fetchYahooDaily, lines 97-118).
// Used by:
//   - src/engine/drift.js — 60-day realized drift estimator
//   - src/engine/vol.js — 20-day realized vol estimator
//   - scripts/backtest-calibration.js (refactored to import from here)
//
// UA quirk (mirrors src/feeds/yahoo-oil.js):
//   - bare "Mozilla/5.0" → 200 OK
//   - full Chrome UA → 429 (Mac/Chrome blanket-throttled by Yahoo)
//
// v8 chart endpoint, daily resolution, no cookie/crumb required.
// See reference_yahoo_unauth_endpoints.md for the gotcha catalog.

const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Fetch closes between fromIso and toIso. Returns Map<'YYYY-MM-DD', close>.
// Throws on HTTP error / empty result — caller decides whether that is fatal.
export async function fetchYahooDaily(symbol, fromIso, toIso) {
  const p1 = Math.floor(new Date(fromIso).getTime() / 1000);
  const p2 = Math.floor(new Date(toIso).getTime() / 1000);
  const url = `${YAHOO_CHART_BASE}/${symbol}?period1=${p1}&period2=${p2}&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`yahoo ${symbol} HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`yahoo ${symbol} empty result`);
  const stamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const map = new Map();
  for (let i = 0; i < stamps.length; i++) {
    if (closes[i] == null) continue;
    const d = new Date(stamps[i] * 1000).toISOString().slice(0, 10);
    map.set(d, closes[i]);
  }
  return map;
}

// Fetch the last `lookbackDays` calendar days of closes ending today (UTC).
// Returns the same Map shape as fetchYahooDaily. The window is calendar days,
// not trading days — Yahoo returns the trading-day subset within it.
export async function fetchYahooDailyLookback(symbol, lookbackDays) {
  const now = new Date();
  const fromIso = new Date(now.getTime() - lookbackDays * 24 * 3600 * 1000).toISOString();
  const toIso = now.toISOString();
  return fetchYahooDaily(symbol, fromIso, toIso);
}

// Sorted list of {date, close} from a Yahoo Map, oldest first.
// Convenience wrapper for the realized-stat estimators in drift.js / vol.js.
export function sortedClosesFromMap(map) {
  const out = [];
  for (const [date, close] of map.entries()) {
    out.push({ date, close });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}
