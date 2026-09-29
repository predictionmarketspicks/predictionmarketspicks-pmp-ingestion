// Polymarket US gateway fetcher — the THIRD venue.
//
// Sibling to feeds/polymarket-gamma.js. Gamma serves Polymarket's INTERNATIONAL
// book, which is closed to US persons. This serves Polymarket US: a separate
// CFTC-designated exchange, live to US traders since December 2025, settling
// off-chain in USD. They share no order book, liquidity or settlement, so their
// prices are NOT interchangeable — every row here is written with venue='us'
// and consumers must ask for a venue explicitly (CI-gated on the site repo).
//
// Endpoint: https://gateway.polymarket.us/v1/markets?active=true&closed=false
// plus server-side filters (US_QUERIES below). Public, unauthenticated, no key.
// What is kept: keepUsMarket(). How often it is written: the snapshot engine.
//
// Full reconnaissance + design rationale:
//   prediction-marketspicks/handoffs/POLYMARKET_US_INGEST_2026-08-04.md
//
// ── Four things that will bite you ───────────────────────────────────────────
//
// 1. A DEFAULT USER-AGENT GETS 403. curl works, most stdlib clients don't.
//    The UA below is mandatory, not politeness.
//
// 2. `status=open` DOES NOT FILTER — it happily returns closed markets. The
//    working filter is `active=true&closed=false`. Same trap as Kalshi's
//    `?status=open&limit=200`, which is already a standing rule in CLAUDE.md.
//
// 3. `outcomes` and `outcomePrices` are JSON-encoded STRINGS, not arrays.
//    Iterate without JSON.parse and you get characters.
//
// 4. THE BOOK IS QUOTED ON OUTCOME INDEX 0 — AND SO IS `outcomePrices`, EVEN
//    WHEN `outcomes` READS ["No","Yes"]. ⚠️ CORRECTED 2026-08-21. The original
//    note here drew the wrong conclusion from a right observation: yes, the book
//    brackets outcomePrices[0] on essentially every two-sided market — but that
//    is because index 0 holds the YES price REGARDLESS of what `outcomes` says.
//    The array is not reordered. So `outcomes[0] !== 'Yes'` is not evidence the
//    book describes NO, and complementing on it INVERTS a correct quote.
//
//    Measured across the allowlisted rows this feed actually writes: 729 of
//    2,789 two-sided binaries list ["No","Yes"], and on 729 of 729 the live book
//    brackets outcomePrices[0]. Zero counterexamples. Every one of those rows was
//    stored inverted — `paccc-usho-midterms-2026-11-03-dem` sat at 0.159/0.160
//    against a real book of 0.840/0.841.
//
//    The crossed-book guard in the snapshot engine cannot catch this: the
//    complement of a valid book is another valid, uncrossed book. Only comparison
//    against another source gives it away.
//
//    The reliable signal is `marketSides` — exactly one side carries `long: true`
//    and it is the affirmative one, on all 22,346 open markets checked. Decide
//    the side from that market's own data, never from field ordering.
//
const POLY_US_BASE = process.env.POLYMARKET_US_BASE || 'https://gateway.polymarket.us';
const POLY_US_TIMEOUT_MS = Number(process.env.POLY_US_FETCH_TIMEOUT_MS || 30_000);
const POLY_US_RETRY_DELAY_MS = Number(process.env.POLY_US_RETRY_DELAY_MS || 800);
const POLY_US_MAX_ATTEMPTS = 4;
const PAGE_SIZE = 500; // hard cap — limit=1000 silently returns 500

// ── What we keep (Benny, 2026-09-29: "keep only what we use") ─────────────────
//
// The live universe is ~68,500 active markets (measured 2026-09-29 — not the
// ~8,500 this header used to say; the old 12,000-offset safety stop silently
// truncated the scan). ~60,900 are sports. Of the ~7,600 non-sports, ~4,900 are
// election margin brackets (vmc-), turnout brackets (vtc-) and closeness
// ladders (cmovc*-) that nothing reads.
//
// Every field below was proven on the live catalog 2026-09-29
// (fixtures: test/fixtures/polymarket-us-markets-2026-09-29.json):
//
//   category          'politics' | 'culture' | 'finance' | 'technology' |
//                     'macro' | 'crypto' | 'climate' | 'science' |
//                     'geopolitics' | 'sports'
//   marketType        'moneyline' | 'spreads' | 'totals' | 'props' |
//                     'futures' | 'drawable_outcome' | 'election'
//   sportsMarketType  full-game vs period vs prop, e.g.
//                     football_team_full_game_winner / _spread / _total vs
//                     football_team_first_half_spread, football_game_first_quarter_total,
//                     football_team_points_full_game_total (a TEAM total, tt-)
//                     ⚠️ football_* is shared with college football — it does
//                     not identify the NFL.
//   slug              '<prefix>-nfl-<...>'. The league is the 2nd token.
//                     Game markets: aec- (moneyline), asc- (spread),
//                     tsc- (totals), e.g. aec-nfl-pit-cle-2026-10-01.
//   gameStartTime     kickoff, ISO UTC (on game markets).
//   marketSides[]     exactly two; exactly one `long: true`; on team markets
//                     each carries `team.{abbreviation,league:'nfl'}`.
//
// NFL = category 'sports' AND slug matches ^[a-z]+-nfl-. On the full catalog
// that set equals the gateway's own NFL tag (`tagIds=1`) minus one cross-league
// "Texas team wins pro OR college title" market, and every market whose side
// carries team.league 'nfl' has an -nfl- slug (4,091 of 4,091).
export const NFL_SLUG_RE = /^[a-z]+-nfl-/;

// Politics we do not read: vote-margin brackets, turnout brackets, closeness
// ladders. 4,867 of 6,560 politics markets on 2026-09-29.
export const POLITICS_BRACKET_RE = /^(vmc|vtc|cmovc[a-z]*)-/;

export const KEEP_CATEGORIES = ['politics', 'culture', 'finance', 'technology', 'macro', 'crypto'];

// Full game only. football_team_points_full_game_total is a TEAM total
// (tsc-…-tt-pit-…) — a prop by another name — and is deliberately absent.
export const NFL_GAME_SPORTS_MARKET_TYPES = new Set([
  'football_team_full_game_winner',
  'football_team_full_game_spread',
  'football_team_full_game_total',
]);
const NFL_GAME_MARKET_TYPES = new Set(['moneyline', 'spreads', 'totals']);

// NFL futures/awards we keep, by slug prefix:
//   tec-   champion, conference, division, MVP/OPOY/DPOY/ROY/COTY/CBPOY
//   aqc-   playoff / conference-championship qualifiers
//   atc-   regular-season series winner
//   aachc- ONLY when a side names an NFL team (win totals, #1 seed,
//          best/worst record, team sacks/INT leader). Teamless aachc- are
//          player stat leaders / 1,000-yard clubs / scorigami — props.
// Dropped: astatc- (season stat thresholds), ftsc-/fptc- (fantasy).
const NFL_FUTURE_PREFIXES = new Set(['tec', 'aqc', 'atc']);

function hasNflTeamSide(m) {
  return (
    Array.isArray(m?.marketSides) &&
    m.marketSides.some((s) => s && s.team && s.team.league === 'nfl')
  );
}

/**
 * Pure classifier. `{ keep: true, kind }` or `{ keep: false, rule }`.
 * kind ∈ nfl_game | nfl_future | politics | culture | finance | technology |
 * macro | crypto. `rule` names the drop rule (used for per-tick counters).
 */
export function classifyUsMarket(m) {
  if (!m || typeof m !== 'object') return { keep: false, rule: 'malformed' };
  const slug = typeof m.slug === 'string' ? m.slug : '';
  const category = m.category;

  if (category === 'sports') {
    if (!NFL_SLUG_RE.test(slug)) return { keep: false, rule: 'sports_non_nfl' };
    if (NFL_GAME_MARKET_TYPES.has(m.marketType)) {
      return NFL_GAME_SPORTS_MARKET_TYPES.has(m.sportsMarketType)
        ? { keep: true, kind: 'nfl_game' }
        : { keep: false, rule: 'nfl_period_or_team_total' };
    }
    if (m.marketType === 'futures') {
      const prefix = slug.split('-')[0];
      if (NFL_FUTURE_PREFIXES.has(prefix)) return { keep: true, kind: 'nfl_future' };
      if (prefix === 'aachc' && hasNflTeamSide(m)) return { keep: true, kind: 'nfl_future' };
      return { keep: false, rule: 'nfl_future_player_prop' };
    }
    return { keep: false, rule: 'nfl_prop' };
  }

  if (category === 'politics') {
    return POLITICS_BRACKET_RE.test(slug)
      ? { keep: false, rule: 'politics_bracket' }
      : { keep: true, kind: 'politics' };
  }
  if (KEEP_CATEGORIES.includes(category)) return { keep: true, kind: category };
  return { keep: false, rule: `category_${category ?? 'none'}` };
}

/** Exported, pure: should this gateway market be written at all? */
export function keepUsMarket(m) {
  return classifyUsMarket(m).keep;
}

/**
 * Kickoff for an NFL game market, ms since epoch. `gameStartTime` first; the
 * slug date (…-2026-10-01) as a fallback, read as that day 00:00 UTC — early
 * by at most a day, which only widens the every-tick window. null if neither.
 */
export function kickoffMsOf(m) {
  const t = typeof m?.gameStartTime === 'string' ? Date.parse(m.gameStartTime) : NaN;
  if (Number.isFinite(t)) return t;
  const d = typeof m?.slug === 'string' ? m.slug.match(/-(\d{4}-\d{2}-\d{2})(?:-|$)/) : null;
  if (d) {
    const u = Date.parse(`${d[1]}T00:00:00Z`);
    if (Number.isFinite(u)) return u;
  }
  return null;
}

function toNumOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/** `{ value: "0.1280", currency: "USD" }` → 0.128. Either quote may be null. */
function quoteToNum(q) {
  if (!q || typeof q !== 'object') return null;
  return toNumOrNull(q.value);
}

/** The gateway hands back JSON-encoded strings for array fields. */
export function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseTimestamp(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Correct a raw gateway book onto the LONG side. The book is quoted on the long
 * side on every two-sided market measured (6,136/6,136 NFL game markets and
 * 3,000 NFL futures on 2026-09-29; 729/729 ["No","Yes"] politics rows on
 * 2026-08-21) — but a market's own long-side price is the evidence, so if the
 * book brackets 1 − long and not long, complement AND swap (the complement of
 * the best ask is the best bid; getting that backwards yields a crossed book).
 */
function bookOnLongSide(rawBid, rawAsk, longRef) {
  let best_bid = rawBid;
  let best_ask = rawAsk;
  if (longRef != null && rawBid != null && rawAsk != null) {
    // A cent of slack: the reference is the long side's buy price against an
    // integer-cent book, so an exact containment test would flip good quotes.
    const inside = (v) => v >= rawBid - 0.01 && v <= rawAsk + 0.01;
    if (!inside(longRef) && inside(1 - longRef)) {
      best_bid = 1 - rawAsk;
      best_ask = 1 - rawBid;
    }
  }
  return { best_bid, best_ask };
}

function baseRow(m, id, slug) {
  return {
    // Namespaced so a small integer id can never collide with an international
    // 0x-prefixed conditionId under the (condition_id, snapshot_at) upsert key.
    condition_id: `pmus:${id}`,
    slug,
    question: typeof m.question === 'string' ? m.question : null,
    category: typeof m.category === 'string' ? m.category : null,
    tags: parseJsonArray(m.tags),
    // The gateway publishes NO volume, liquidity or open-interest field.
    // NULL, never 0 — "not published" and "measured, none" are different facts,
    // and conflating them is what produced five bad brand-status checkpoints.
    volume_24h_usdc: null,
    volume_total_usdc: null,
    liquidity_usdc: null,
    open_interest_usdc: null,
    start_date: parseTimestamp(m.startDate),
    end_date: parseTimestamp(m.endDate),
    active: typeof m.active === 'boolean' ? m.active : null,
    closed: typeof m.closed === 'boolean' ? m.closed : null,
    venue: 'us',
  };
}

/**
 * Normalize one gateway market to the polymarket_market_snapshots row shape.
 *
 * TWO row shapes, by market shape:
 *
 *  • Yes/No binaries (politics, culture, futures, …) — UNCHANGED since
 *    2026-08-21: best_bid/best_ask are the YES book, `outcomes` is the raw
 *    string array as the gateway lists it (["Yes","No"] or ["No","Yes"] —
 *    the order means nothing, see note 4).
 *
 *  • Two-outcome TEAM markets (NFL moneyline ["Steelers","Browns"], spread
 *    ["-3.50","+3.50"], total ["Over","Under"]) — the INTERNATIONAL shape:
 *
 *      outcomes = [
 *        { outcome: <long side label>,  price, team },   ← outcomes[0]
 *        { outcome: <short side label>, price, team },
 *      ]
 *      best_bid / best_ask  = outcomes[0]'s book  (international convention)
 *      last_trade_price     = outcomes[0]'s gateway price (as on yes/no rows)
 *
 *    outcomes[0] is ALWAYS the `long: true` side — never the gateway's
 *    `outcomes` order, which lists ["Under","Over"] on some totals whose long
 *    side is Over (same trap as note 4). The long side is also exactly what a
 *    yes/no row's best_* describe (YES = long), so both shapes read the same
 *    way: best_* is the long side's book.
 *
 *    `team` is the side's team abbreviation ('pit') or null (totals) — a
 *    spread's label is "-3.50", so the team is what says who is laying it.
 *    `price` is that outcome's MID in dollars: outcomes[0] = (bid+ask)/2 of
 *    the corrected book, outcomes[1] = 1 − that. The complement is exact here,
 *    not an assumption: both sides are ONE instrument (same `identifier`), and
 *    the gateway's own side prices are long = best ask and short = 1 − best
 *    bid on 6,136/6,136 two-sided NFL game markets. No two-sided book → both
 *    prices null (a one-sided or empty book has no mid).
 *
 * Returns null for anything we cannot state confidently — >2 outcomes, an
 * unparseable outcome list, a missing slug, or a team market whose sides do
 * not name its outcomes. Skipping is always correct; guessing an outcome
 * mapping is what manufactures phantom arb.
 */
export function normalizeUsMarket(m) {
  if (!m || typeof m !== 'object') return null;
  const id = m.id == null ? null : String(m.id);
  const slug = typeof m.slug === 'string' ? m.slug : null;
  if (!id || !slug) return null;

  const outcomes = parseJsonArray(m.outcomes);
  if (!outcomes || outcomes.length !== 2) return null; // two-outcome only

  const rawBid = quoteToNum(m.bestBidQuote);
  const rawAsk = quoteToNum(m.bestAskQuote);
  const sides = Array.isArray(m.marketSides) ? m.marketSides.filter(Boolean) : [];
  const longSide = sides.find((s) => s.long === true) ?? null;
  const longRef = longSide ? toNumOrNull(longSide.price) : null;

  const isYesNo = outcomes.some((o) => String(o).toLowerCase() === 'yes');

  if (isYesNo) {
    // The YES price according to the market's own structure: exactly one
    // `marketSides` entry carries `long: true` and it is the affirmative one.
    // Default: the book IS the YES book; complement only on this market's own
    // evidence (bookOnLongSide).
    const { best_bid, best_ask } = bookOnLongSide(rawBid, rawAsk, longRef);

    // Same correction for the last trade. `outcomePrices` is not reordered
    // either, so indexing it by the position of 'Yes' in `outcomes` picks the
    // NO price on a ["No","Yes"] market.
    const prices = parseJsonArray(m.outcomePrices);
    let yesPrice = longRef;
    if (yesPrice == null && prices && prices.length === 2) yesPrice = toNumOrNull(prices[0]);

    return {
      ...baseRow(m, id, slug),
      best_bid,
      best_ask,
      last_trade_price: yesPrice,
      outcomes,
    };
  }

  // ── Two-outcome team market ──
  // Shape check: exactly one long and one short side, and their descriptions
  // ARE the two outcomes. Anything else is a market we do not understand.
  if (sides.length !== 2 || !longSide) return null;
  const shortSide = sides.find((s) => s !== longSide);
  if (!shortSide || shortSide.long === true) return null;
  const labels = outcomes.map(String);
  const longLabel = longSide.description == null ? null : String(longSide.description);
  const shortLabel = shortSide.description == null ? null : String(shortSide.description);
  if (!longLabel || !shortLabel || longLabel === shortLabel) return null;
  if (!labels.includes(longLabel) || !labels.includes(shortLabel)) return null;

  const { best_bid, best_ask } = bookOnLongSide(rawBid, rawAsk, longRef);
  const mid0 = best_bid != null && best_ask != null ? round6((best_bid + best_ask) / 2) : null;
  const teamOf = (s) =>
    s.team && typeof s.team.abbreviation === 'string' ? s.team.abbreviation : null;

  return {
    ...baseRow(m, id, slug),
    best_bid,
    best_ask,
    last_trade_price: longRef,
    outcomes: [
      { outcome: longLabel, price: mid0, team: teamOf(longSide) },
      { outcome: shortLabel, price: mid0 == null ? null : round6(1 - mid0), team: teamOf(shortSide) },
    ],
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Server-side pre-filters — every parameter here was proven to filter on the
// live gateway 2026-09-29 (unknown parameters are silently IGNORED, so a typo
// here would quietly pull the whole 68k catalog; keepUsMarket() still decides).
//   categories=<c>  repeatable
//   tagIds=1        the gateway's NFL tag (a superset of the -nfl- slug set)
//   marketTypes=<t> repeatable
// ⚠️ `category=`, `league=`, `tagSlug=` on /v1/markets do NOT filter.
export const US_QUERIES = {
  // Every tick: NFL game markets (moneyline/spreads/totals incl. period lines,
  // which keepUsMarket drops). ~8.3k markets / 17 pages.
  nfl_games: 'tagIds=1&marketTypes=moneyline&marketTypes=spreads&marketTypes=totals',
  // Hourly: NFL futures (~3.6k / 8 pages) and the kept non-sports categories
  // (~7.6k / 16 pages).
  nfl_futures: 'tagIds=1&marketTypes=futures',
  non_sports: KEEP_CATEGORIES.map((c) => `categories=${c}`).join('&'),
};

async function fetchPage(query, offset) {
  const url =
    `${POLY_US_BASE}/v1/markets?active=true&closed=false` +
    `&limit=${PAGE_SIZE}&offset=${offset}&${query}`;

  let lastErr = null;
  for (let attempt = 1; attempt <= POLY_US_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLY_US_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        // MANDATORY — the gateway 403s a default/absent UA.
        headers: { 'User-Agent': 'pmp/1.0', Accept: 'application/json' },
      });
      if (res.status === 429) throw new Error('rate limited (429)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return Array.isArray(body?.markets) ? body.markets : [];
    } catch (err) {
      lastErr = err;
      if (attempt < POLY_US_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, POLY_US_RETRY_DELAY_MS * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`polymarket-us fetch failed at offset ${offset}: ${lastErr?.message}`);
}

/**
 * Fetch the named query groups, keep what keepUsMarket() keeps, normalize.
 *
 * Returns `{ entries, stats }`:
 *   entries  [{ row, kind, kickoffMs }] — `row` is the DB row, untouched;
 *            kind/kickoffMs drive the engine's write cadence and never reach
 *            the table.
 *   stats    { fetched, kept, dropped: { <rule>: n }, unnormalizable }
 *
 * Sequential pagination (concurrency 1) — no rate limit is documented and none
 * was observed across a full 68.5k-market scan.
 */
export async function fetchUsMarkets({ groups = Object.keys(US_QUERIES) } = {}) {
  const byId = new Map();
  const seen = new Set();
  const stats = { fetched: 0, kept: 0, dropped: {}, unnormalizable: 0 };

  // Safety stop per query. The largest filtered query is ~8.3k today; the
  // unfiltered catalog is ~68.5k. The old 12,000 stop was set against a
  // believed ~8.5k universe and truncated it — if this ever trips, the
  // server-side filter has stopped working and we want to hear about it.
  const MAX_OFFSET = 40_000;

  for (const group of groups) {
    const query = US_QUERIES[group];
    if (!query) throw new Error(`polymarket-us: unknown query group ${group}`);
    let offset = 0;
    for (;;) {
      if (offset > MAX_OFFSET) {
        throw new Error(`polymarket-us: ${group} exceeded ${MAX_OFFSET} rows — server filter broken?`);
      }
      const page = await fetchPage(query, offset);
      if (page.length === 0) break;
      for (const raw of page) {
        const key = raw?.id == null ? null : String(raw.id);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        stats.fetched += 1;
        const verdict = classifyUsMarket(raw);
        if (!verdict.keep) {
          stats.dropped[verdict.rule] = (stats.dropped[verdict.rule] ?? 0) + 1;
          continue;
        }
        const row = normalizeUsMarket(raw);
        if (!row) {
          stats.unnormalizable += 1;
          continue;
        }
        stats.kept += 1;
        byId.set(row.condition_id, {
          row,
          kind: verdict.kind,
          kickoffMs: verdict.kind === 'nfl_game' ? kickoffMsOf(raw) : null,
        });
      }
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  return { entries: Array.from(byId.values()), stats };
}
