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

// Soonest-closing open event for a series. Sorts by event_ticker, which encodes
// YYMMMDDHH date — same trick the Python engine uses.
export async function getNextEvent(seriesTicker) {
  const json = await getJson(`${KALSHI_API_BASE}/events?series_ticker=${seriesTicker}&status=open&limit=20`);
  const events = Array.isArray(json?.events) ? json.events : [];
  if (events.length === 0) return null;
  events.sort((a, b) => String(a.event_ticker).localeCompare(String(b.event_ticker)));
  return events[0];
}

// Per-market REST fetch — full data (event-nested response is abbreviated).
export async function fetchMarket(marketTicker) {
  const json = await getJson(`${KALSHI_API_BASE}/markets/${marketTicker}`);
  return json?.market || null;
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
      const ct = m.close_time;
      closeTime = closeTime || ct;
      markets.push({
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
        closeTime: ct,
        status: m.status || '',
      });
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
  };
}
