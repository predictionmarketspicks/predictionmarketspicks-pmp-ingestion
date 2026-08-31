// Kalshi REST helpers — public, unauthenticated.
// Used by the silver engine for event discovery and a cold-start quote seed
// before the WS ticker fills the in-memory quoteMap.

const KALSHI_API_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function getJson(url, timeoutMs = 8000) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'pmp-ingestion/0.1' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`kalshi ${res.status} ${url}`);
  return res.json();
}

// Soonest-closing open event for a series.
//
// ⛔ NEVER a bare lexical sort on event_ticker (fixed 2026-08-31, EDGE_MARKETS
// 0.2). Month abbreviations don't sort chronologically — 26OCT02 < 26SEP04 —
// so when Kalshi lists an October weekly beside a September one (~Sep 18–25
// every year, and every inverted month-end for daily series) a lexical sort
// silently prices the FAR event: T balloons, the board goes all-PASS or
// mispriced. We sort by parsed close date (API close_time/strike_date when the
// payload carries one, else the YYMMMDD[HH] segment of the ticker), lexical as
// tiebreak only. An unparseable candidate is excluded with a warning rather
// than allowed to sort first; if NOTHING parses we fall back to the old
// lexical sort loudly rather than kill the feed.
//
// Optional `filter` callback (event => boolean) lets the caller restrict the
// candidate pool before picking the soonest. Used by the bitcoin engine to
// drop KXBTCD hourly settles that fall outside the IBIT options chain window
// (10 AM – 4 PM ET) so the engine doesn't try to compute edge math against a
// frozen smile + moving spot.
const TICKER_MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// Millisecond sort key for an event, or null when nothing parses.
export function eventSortKey(ev) {
  for (const field of ['close_time', 'strike_date', 'strike_period_end']) {
    const v = ev?.[field];
    if (typeof v === 'string' && v) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  const m = String(ev?.event_ticker || '').match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{2})?/);
  if (!m) return null;
  const [, yy, mon, dd, hh] = m;
  return Date.UTC(2000 + Number(yy), TICKER_MONTHS[mon], Number(dd), hh ? Number(hh) : 0);
}

// Pure selection over an already-fetched candidate list — split out so the
// month-inversion cases are unit-testable without the network.
export function pickNextEvent(candidates) {
  if (!candidates.length) return null;
  const keyed = [];
  for (const ev of candidates) {
    const t = eventSortKey(ev);
    if (t == null) {
      console.warn(`[kalshi-event] unparseable event date, excluded from front-event pick: ${ev?.event_ticker}`);
      continue;
    }
    keyed.push([t, ev]);
  }
  if (!keyed.length) {
    console.warn('[kalshi-event] no candidate parsed to a date — falling back to lexical sort');
    return [...candidates].sort((a, b) => String(a.event_ticker).localeCompare(String(b.event_ticker)))[0];
  }
  keyed.sort((a, b) => a[0] - b[0] || String(a[1].event_ticker).localeCompare(String(b[1].event_ticker)));
  return keyed[0][1];
}

export async function getNextEvent(seriesTicker, { filter } = {}) {
  const json = await getJson(`${KALSHI_API_BASE}/events?series_ticker=${seriesTicker}&status=open&limit=20`);
  const events = Array.isArray(json?.events) ? json.events : [];
  if (events.length === 0) return null;
  const candidates = typeof filter === 'function' ? events.filter(filter) : events;
  if (candidates.length === 0) return null;
  return pickNextEvent(candidates);
}

// Per-market REST fetch — full data.
export async function fetchMarket(marketTicker) {
  const json = await getJson(`${KALSHI_API_BASE}/markets/${marketTicker}`);
  return json?.market || null;
}

// Normalize a raw Kalshi market (REST /markets or the with_nested_markets
// event payload — both now carry the same *_dollars / *_fp fields) into the
// engine's market shape. Single source of truth so fetchEvent and the
// per-snapshot refetch can't drift.
function shapeMarket(m) {
  return {
    ticker: m.ticker,
    eventTicker: m.event_ticker,
    floorStrike: num(m.floor_strike),
    lastPrice: num(m.last_price_dollars),
    previousPrice: num(m.previous_price_dollars),
    yesBid: num(m.yes_bid_dollars),
    yesAsk: num(m.yes_ask_dollars),
    yesBidSize: num(m.yes_bid_size_fp),
    noBid: num(m.no_bid_dollars),
    noAsk: num(m.no_ask_dollars),
    volume24h: num(m.volume_24h_fp) ?? 0,
    volumeTotal: num(m.volume_fp) ?? 0,
    openInterest: num(m.open_interest_fp) ?? 0,
    closeTime: m.close_time,
    status: m.status || '',
  };
}

// Full event with all per-market detail. Polite delay between strike fetches
// to stay under rate limits — we only call this every 5 min during market hours.
export async function fetchEvent(eventTicker, { politeDelayMs = 50 } = {}) {
  const summary = await getJson(`${KALSHI_API_BASE}/events/${eventTicker}?with_nested_markets=true`);
  const event = summary?.event;
  if (!event) throw new Error(`event ${eventTicker} not found`);
  const strikeTickers = (event.markets || []).map((m) => m.ticker).filter(Boolean);

  const markets = [];
  let closeTime = null;
  for (const tk of strikeTickers) {
    try {
      const m = await fetchMarket(tk);
      if (!m) continue;
      closeTime = closeTime || m.close_time;
      markets.push(shapeMarket(m));
      if (politeDelayMs > 0) await new Promise((r) => setTimeout(r, politeDelayMs));
    } catch (err) {
      console.warn(`[kalshi-event] skip ${tk}: ${err?.message || err}`);
    }
  }

  return {
    eventTicker: event.event_ticker || eventTicker,
    seriesTicker: event.series_ticker || '',
    title: event.title || '',
    subTitle: event.sub_title || '',
    closeTime: closeTime || new Date().toISOString(),
    markets,
    // Discovery-time stamp. computeSnapshot uses this as the kalshi_quoted_at
    // fallback when the per-snapshot refetch fails, so the staleness guard can
    // still flag a book that's only as fresh as the last event refresh.
    fetchedAtMs: Date.now(),
  };
}

// Per-snapshot atomic quote refresh (2026-06-10 stale-Kalshi-leg fix). One
// with_nested_markets call returns the CURRENT resting book for every strike in
// a single request sharing one timestamp — no per-strike fan-out, no leg skew
// across strikes. Replaces reuse of the discovery-time markets array (which
// could be up to ~1h stale for hourly KXBTCD while spot + chain ran live).
// Returns { markets, fetchedAtMs }; markets is [] if the call yields none, and
// the caller falls back to the discovery snapshot + flags staleness.
export async function refetchEventMarkets(eventTicker) {
  const summary = await getJson(`${KALSHI_API_BASE}/events/${eventTicker}?with_nested_markets=true`);
  const fetchedAtMs = Date.now();
  const nested = Array.isArray(summary?.event?.markets) ? summary.event.markets : [];
  const markets = nested.filter((m) => m && m.ticker).map(shapeMarket);
  return { markets, fetchedAtMs };
}
