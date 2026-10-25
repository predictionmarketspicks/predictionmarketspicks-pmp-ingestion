// Market-movers selection logic.
//
// Pure functions — no I/O. Takes a list of Candidate (from feeds/movers.js),
// applies filters, ranks by score, returns top-N gainers + losers. Mirrors the
// behavior of supabase/functions/discord-market-movers/index.ts so the engine
// can take over Phase 3's cadence without changing what readers see.
//
// Scoring formula: |Δ24h| × log10(max(volume_24h, 10)). Same formula the Edge
// Function uses — biggest mover wins, ties broken by liquidity. log10 keeps
// volume from dominating the rank for thin markets that happen to be churny.

export const VOL_MIN = 500;
export const DELTA_MIN_PP = 3;
export const PRICE_MIN_C = 5;
export const PRICE_MAX_C = 95;
export const TOP_N_PER_DIRECTION = 5;

export function score(c) {
  return Math.abs(c.price_change_24h) * Math.log10(Math.max(c.volume_24h, 10));
}

export function applyFilters(candidates, { sportsRestricted = false, isTest = false } = {}) {
  return candidates.filter((c) => {
    if (sportsRestricted && c.ticker.startsWith('KXNFL')) return false;
    if (c.yes_price < PRICE_MIN_C || c.yes_price > PRICE_MAX_C) return false;
    if (!isTest && c.volume_24h < VOL_MIN) return false;
    if (!isTest && Math.abs(c.price_change_24h) < DELTA_MIN_PP) return false;
    return true;
  });
}

export function selectTop(candidates, { isTest = false } = {}) {
  const gainers = candidates
    .filter((c) => c.price_change_24h > 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, isTest ? 2 : TOP_N_PER_DIRECTION);

  const losers = candidates
    .filter((c) => c.price_change_24h < 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, isTest ? 1 : TOP_N_PER_DIRECTION);

  return { gainers, losers };
}

// posted_alerts key shape — must match the Edge Function so the engine + Edge
// Function dedup against each other during the soak.
export function alertKey(c) {
  const norm = c.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 60);
  return `market_movers:${norm}`;
}

export function moverTier(absDelta) {
  if (absDelta >= 8) return 3;
  if (absDelta >= 5) return 2;
  return 1;
}

// ---------- #market-movers v2 (DISCORD_CLEANUP_AUTOPILOT_2026-10-25 F3) ----------
//
// Before: every 4h, up to 10 embeds, both sides of a game as separate "movers"
// (Toronto ▲9 and Minnesota ▼9 are ONE move), the same markets every run —
// ~400 embeds a week. Now: 2 posts a day, ONE embed, ≤8 lines, one line per
// EVENT, a repost only when the market moved another ≥5pp, ≤4 sports lines.

export const MAX_LINES = 8;
export const MAX_SPORTS_LINES = 4;
export const REPOST_MIN_MOVE_PP = 5;
// Non-sports lines fill from these only (F3: "econ, politics and crypto").
export const FILL_CATEGORIES = new Set(['Economics', 'Politics', 'Crypto']);

const SITE = 'https://predictionmarketspicks.com';
export const MOVERS_UTM = 'utm_source=discord&utm_medium=feed&utm_campaign=market-movers';

// Closest PMP page per Kalshi series (F8: links go to OUR pages, never the
// Kalshi referral). Unknown series fall back by category.
const PAGE_BY_SERIES = {
  KXFED: '/tools/fed-rate-tracker',
  KXCPIYOY: '/tools/inflation-tracker',
  KXNBERRECESSQ: '/tools/recession-tracker',
  KXGDP: '/macro',
  KXINXY: '/macro',
  KXNBAGAME: '/nba',
  KXSB: '/nfl/futures',
  KXNFLAFCCHAMP: '/nfl/futures',
  KXNFLNFCCHAMP: '/nfl/futures',
  KXNFLPLAYOFF: '/nfl/futures',
  KXNFLMVP: '/nfl/mvp',
  KXNFLWINS: '/nfl/win-totals',
  KXPRESPARTY: '/politics/2028-president',
  KXPRESPERSON: '/politics/2028-president',
  KXIMPEACH: '/politics',
  KXNEWOUTBREAK: '/politics',
  KXBTCMINY: '/crypto-markets',
  KXBTCMAXY: '/crypto-markets',
  KXBTC15M: '/crypto-markets',
  KXETH: '/crypto-markets',
  KXSURVIVOR: '/entertainment',
  KXHURCTOTMAJ: '/weather',
  KXRAINAUSM: '/weather',
};
const PAGE_BY_CATEGORY = {
  Economics: '/macro',
  Sports: '/sports',
  Politics: '/politics',
  Crypto: '/crypto-markets',
  Entertainment: '/entertainment',
  Weather: '/weather',
};

export function moverPageUrl(c) {
  const path = PAGE_BY_SERIES[c.seriesOrSlug] ?? PAGE_BY_CATEGORY[c.category] ?? '/kalshi';
  return `${SITE}${path}?${MOVERS_UTM}`;
}

// Kalshi market tickers are `<event_ticker>-<suffix>`; the feed carries
// event_ticker explicitly, the fallback strips the last segment.
export function eventKeyOf(c) {
  if (c.event_ticker) return c.event_ticker;
  const i = c.ticker.lastIndexOf('-');
  return i > 0 ? c.ticker.slice(0, i) : c.ticker;
}

// One candidate per event: the best-scored side that moved UP; an event with
// no gainer keeps its best-scored loser (a Fed strike sliding is still a move).
// `pool` (the unfiltered scan) lets a loser-only event swap to its other side
// when that side moved up but missed the volume floor — Minnesota ▼9 passing
// the filter while Toronto ▲9 traded thinner is still "Toronto ▲9".
export function collapseByEvent(candidates, pool = null) {
  const byEvent = new Map();
  for (const c of candidates) {
    const k = eventKeyOf(c);
    const cur = byEvent.get(k);
    if (!cur) { byEvent.set(k, c); continue; }
    const cUp = c.price_change_24h > 0;
    const curUp = cur.price_change_24h > 0;
    if (cUp && !curUp) byEvent.set(k, c);
    else if (cUp === curUp && score(c) > score(cur)) byEvent.set(k, c);
  }
  if (pool) {
    for (const [k, cur] of byEvent) {
      if (cur.price_change_24h > 0) continue;
      const up = pool
        .filter((p) => eventKeyOf(p) === k && p.price_change_24h >= DELTA_MIN_PP
          && p.yes_price >= PRICE_MIN_C && p.yes_price <= PRICE_MAX_C)
        .sort((a, b) => score(b) - score(a))[0];
      if (up) byEvent.set(k, up);
    }
  }
  return [...byEvent.values()];
}

// Repost rule. lastPosts: Map<eventKey, { market_id, alert_price }> for posts
// in the last 24h; priceByTicker: Map<ticker, yes_price> from the full scan.
// An event posted in the window re-qualifies only when the market we posted
// has moved ≥REPOST_MIN_MOVE_PP since. A posted market that is no longer
// listed (closed) can't be compared, so the event stays suppressed.
export function applyRepostRule(candidates, lastPosts, priceByTicker, { minMovePp = REPOST_MIN_MOVE_PP } = {}) {
  return candidates.filter((c) => {
    const last = lastPosts?.get(eventKeyOf(c));
    if (!last) return true;
    const now = priceByTicker?.get(last.market_id);
    if (!Number.isFinite(now) || !Number.isFinite(Number(last.alert_price))) return false;
    return Math.abs(now - Number(last.alert_price)) >= minMovePp;
  });
}

// ≤maxSports sports lines first (by score), then econ/politics/crypto by score
// up to maxLines total.
export function selectMoverLines(candidates, { maxLines = MAX_LINES, maxSports = MAX_SPORTS_LINES } = {}) {
  const ranked = [...candidates].sort((a, b) => score(b) - score(a));
  const sports = ranked.filter((c) => c.category === 'Sports').slice(0, Math.min(maxSports, maxLines));
  const fill = ranked
    .filter((c) => FILL_CATEGORIES.has(c.category))
    .slice(0, maxLines - sports.length);
  return [...sports, ...fill];
}

function cleanTitle(t) {
  return String(t ?? '').trim().replace(/\?+$/, '').trim();
}

// `Toronto vs Minnesota — Toronto 50¢ (▲9 in 24h)`. eventTitle comes from
// Kalshi's /events/{ticker}; without it the market title stands alone.
export function moverLineText(c, eventTitle) {
  const d = c.price_change_24h;
  const arrow = d > 0 ? '▲' : '▼';
  const move = `${c.yes_price}¢ (${arrow}${Math.abs(d)} in 24h)`;
  const side = c.yes_sub_title ? cleanTitle(c.yes_sub_title) : null;
  const ev = cleanTitle(eventTitle);
  if (ev && side) return `${ev} — ${side} ${move}`;
  return `${cleanTitle(ev || c.title)} — ${move}`;
}
