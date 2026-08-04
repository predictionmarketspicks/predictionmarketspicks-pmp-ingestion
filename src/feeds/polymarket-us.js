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
// Public, unauthenticated, no key.
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
// 4. THE BOOK IS QUOTED ON OUTCOME INDEX 0, AND INDEX 0 IS NOT ALWAYS "Yes".
//    In a 200-market sample: 113 were ["Yes","No"], 87 were ["No","Yes"].
//    bestBidQuote/bestAskQuote were verified to bracket outcomePrices[0] on all
//    196 two-sided markets, never [1]. Write those straight into
//    best_bid/best_ask and the arb engine compares a YES price against a NO
//    price on ~43% of rows — each one a ~100-point phantom gap that clears any
//    ARB threshold. normalizeUsMarket() flips to YES; see the tests.
//
const POLY_US_BASE = process.env.POLYMARKET_US_BASE || 'https://gateway.polymarket.us';
const POLY_US_TIMEOUT_MS = Number(process.env.POLY_US_FETCH_TIMEOUT_MS || 30_000);
const POLY_US_RETRY_DELAY_MS = Number(process.env.POLY_US_RETRY_DELAY_MS || 800);
const POLY_US_MAX_ATTEMPTS = 4;
const PAGE_SIZE = 500; // hard cap — limit=1000 silently returns 500

// Curated category allowlist. The live universe is ~8,500 active markets and
// 7,382 of them are sports — the same zero-signal flood the Kalshi series rule
// warns about. Sports is deliberately EXCLUDED here and is a later phase, gated
// by the existing SPORT_CONFIG allowlist rather than an open pull.
// Add a category ONLY after wiring a consumer that needs it.
export const POLY_US_CATEGORY_ALLOWLIST = [
  'politics',
  'macro',
  'finance',
  'crypto',
  'culture',
  'geopolitics',
  'technology',
  'climate',
  'science',
];

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
 * Normalize one gateway market to the polymarket_market_snapshots row shape,
 * with the book expressed on the YES outcome.
 *
 * Returns null for anything we cannot state confidently — a non-binary market,
 * an unparseable outcome list, a missing slug. Skipping is always correct here;
 * guessing an outcome mapping is what manufactures phantom arb.
 */
export function normalizeUsMarket(m) {
  if (!m || typeof m !== 'object') return null;
  const id = m.id == null ? null : String(m.id);
  const slug = typeof m.slug === 'string' ? m.slug : null;
  if (!id || !slug) return null;

  const outcomes = parseJsonArray(m.outcomes);
  if (!outcomes || outcomes.length !== 2) return null; // binary only

  const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
  if (yesIdx === -1) return null; // not a Yes/No market — do not guess

  const rawBid = quoteToNum(m.bestBidQuote);
  const rawAsk = quoteToNum(m.bestAskQuote);

  // The book is on outcome index 0. When index 0 IS Yes it maps straight
  // through; otherwise it describes NO and must be complemented — and the sides
  // SWAP, because the complement of the best ask is the best bid. Getting the
  // swap backwards yields a crossed book (bid > ask), which is at least loud.
  const bookIsYes = yesIdx === 0;
  const best_bid = bookIsYes ? rawBid : rawAsk == null ? null : 1 - rawAsk;
  const best_ask = bookIsYes ? rawAsk : rawBid == null ? null : 1 - rawBid;

  const prices = parseJsonArray(m.outcomePrices);
  const yesPrice = prices && prices.length === 2 ? toNumOrNull(prices[yesIdx]) : null;

  return {
    // Namespaced so a small integer id can never collide with an international
    // 0x-prefixed conditionId under the (condition_id, snapshot_at) upsert key.
    condition_id: `pmus:${id}`,
    slug,
    question: typeof m.question === 'string' ? m.question : null,
    category: typeof m.category === 'string' ? m.category : null,
    tags: parseJsonArray(m.tags),
    best_bid,
    best_ask,
    last_trade_price: yesPrice,
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
    outcomes,
    venue: 'us',
  };
}

async function fetchPage(offset) {
  const url =
    `${POLY_US_BASE}/v1/markets?active=true&closed=false` +
    `&limit=${PAGE_SIZE}&offset=${offset}`;

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
 * Every allowlisted active market, normalized and deduped.
 *
 * Sequential pagination (concurrency 1) — no rate limit is documented and none
 * was observed across an 8,500-row scan, but one page at a time is the same
 * courtesy the Gamma feed extends.
 */
export async function fetchUsMarkets({ categories = POLY_US_CATEGORY_ALLOWLIST } = {}) {
  const wanted = new Set(categories);
  const byId = new Map();
  let offset = 0;

  // Safety stop: the universe is ~8.5k and sports dominates it. If the gateway
  // ever starts paging forever, bail rather than spin.
  const MAX_OFFSET = 12_000;

  while (offset <= MAX_OFFSET) {
    const page = await fetchPage(offset);
    if (page.length === 0) break;
    for (const raw of page) {
      if (!wanted.has(raw?.category)) continue;
      const row = normalizeUsMarket(raw);
      if (row) byId.set(row.condition_id, row);
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return Array.from(byId.values());
}
