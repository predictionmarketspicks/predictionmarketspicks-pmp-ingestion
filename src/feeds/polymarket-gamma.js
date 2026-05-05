// Polymarket Gamma REST fetcher — top markets by 24h volume.
//
// Sibling to feeds/kalshi-macro.js for the Polymarket side. The CLOB WS feed
// (feeds/polymarket.js) is real-time but token-id-scoped, useful only for the
// hardcoded arb pairs. The vast majority of site/edge-fn callers do "top N by
// 24h vol" against Gamma — that's what this writer replaces.
//
// Endpoint: https://gamma-api.polymarket.com/markets?active=true&closed=false
//           &order=volume24hr&ascending=false&limit=N
// No auth, no rate-limit headers documented; we still cap concurrency at 1
// (single page request per scan) and back off on 429 just in case.
//
// Row shape matches polymarket_market_snapshots columns 1:1 — engine wraps
// each batch in snapshot_at + writes directly. Pricing is NUMERIC in the
// table, so we keep raw 0.0000–1.0000 floats here (no cents conversion).

const GAMMA_API_BASE = process.env.POLYMARKET_GAMMA_BASE || 'https://gamma-api.polymarket.com';
const GAMMA_FETCH_TIMEOUT_MS = Number(process.env.GAMMA_FETCH_TIMEOUT_MS || 30_000);
const GAMMA_RETRY_DELAY_MS = Number(process.env.GAMMA_RETRY_DELAY_MS || 800);
const GAMMA_MAX_ATTEMPTS = 4;

// Log first N markets per fresh scan so a Gamma field rename is visible.
// Polymarket has a ship-of-Theseus history (handoff §5) — silent shape drift
// has bitten us before.
const RAW_SHAPE_LOG_LIMIT = 5;

async function gammaGet(url, { signal, label = 'gamma' } = {}) {
  let res;
  for (let attempt = 0; attempt < GAMMA_MAX_ATTEMPTS; attempt++) {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'pmp-ingestion/polymarket-gamma' },
      signal,
    });
    if (res.status !== 429) return res;
    if (attempt === GAMMA_MAX_ATTEMPTS - 1) {
      console.warn(`[${label}] gamma 429 — gave up after ${GAMMA_MAX_ATTEMPTS} attempts`);
      return res;
    }
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    const wait =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : GAMMA_RETRY_DELAY_MS;
    console.warn(
      `[${label}] gamma 429 — retrying after ${wait}ms (attempt ${attempt + 1}/${GAMMA_MAX_ATTEMPTS})`,
    );
    await new Promise((r) => setTimeout(r, wait));
  }
  return res;
}

// Top N markets by 24h volume. Returns rows ready for upsert (sans snapshot_at,
// which the delivery layer stamps). Filters volume_24h_usdc > 0 to drop the
// dead tail Gamma's order=volume24hr query still includes. Limit defaults to
// 200 — Gamma's max page is 500 but 200 keeps payload manageable and matches
// the macro engine's row budget per scan.
export async function fetchTopMarkets({ limit = 200, timeoutMs = GAMMA_FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // include_tag=true (singular, not the plural include_tags some Polymarket
    // mirrors document) is required — Gamma's /markets default response omits
    // the tags array entirely. Without this, every row stores tags=NULL and
    // Session C's `tags @> ARRAY[...]` reads return zero hits.
    const url = `${GAMMA_API_BASE}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}&include_tag=true`;
    const res = await gammaGet(url, { signal: controller.signal, label: 'polymarket-gamma' });
    if (!res.ok) {
      console.warn(`[polymarket-gamma] HTTP ${res.status} — returning 0 rows`);
      return [];
    }
    const json = await res.json();
    const markets = Array.isArray(json) ? json : Array.isArray(json?.markets) ? json.markets : [];

    let logged = 0;
    const rows = [];
    for (const m of markets) {
      if (logged < RAW_SHAPE_LOG_LIMIT) {
        logged += 1;
        console.log(
          `[polymarket-gamma:shape ${logged}/${RAW_SHAPE_LOG_LIMIT}]`,
          JSON.stringify(m).slice(0, 600),
        );
      }
      const row = normalizeMarket(m);
      if (!row) continue;
      if ((row.volume_24h_usdc ?? 0) <= 0) continue; // drop dead tail
      rows.push(row);
    }
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

// Map a Gamma market response to our row shape. Returns null if the market is
// missing the required identity fields (condition_id + slug); both are NOT
// NULL in the table.
export function normalizeMarket(m) {
  if (!m || typeof m !== 'object') return null;
  const condition_id = typeof m.conditionId === 'string' ? m.conditionId : null;
  const slug = typeof m.slug === 'string' ? m.slug : null;
  if (!condition_id || !slug) return null;

  return {
    condition_id,
    slug,
    question: typeof m.question === 'string' ? m.question : null,
    category: typeof m.category === 'string' ? m.category : null,
    tags: parseTags(m.tags),
    best_bid: toNumOrNull(m.bestBid),
    best_ask: toNumOrNull(m.bestAsk),
    last_trade_price: toNumOrNull(m.lastTradePrice),
    volume_24h_usdc: toNumOrNull(m.volume24hr ?? m.volumeNum),
    volume_total_usdc: toNumOrNull(m.volume),
    liquidity_usdc: toNumOrNull(m.liquidity ?? m.liquidityNum),
    open_interest_usdc: toNumOrNull(m.openInterest),
    start_date: parseTimestamp(m.startDate),
    end_date: parseTimestamp(m.endDate),
    active: typeof m.active === 'boolean' ? m.active : null,
    closed: typeof m.closed === 'boolean' ? m.closed : null,
    outcomes: parseOutcomes(m),
  };
}

// Polymarket tag responses come in two shapes depending on which Gamma route
// you hit: `[{id, label, slug}]` (most common) or a flat `string[]`. Coerce
// to slugs since Pattern B reads filter on `tags @> ARRAY['sports']`.
export function parseTags(input) {
  if (!Array.isArray(input)) return null;
  const slugs = [];
  for (const t of input) {
    if (typeof t === 'string') {
      slugs.push(t);
    } else if (t && typeof t === 'object') {
      const slug = typeof t.slug === 'string' ? t.slug : typeof t.label === 'string' ? t.label : null;
      if (slug) slugs.push(slug);
    }
  }
  return slugs.length ? slugs : null;
}

// Outcomes for binary markets come as parallel `outcomes` + `outcomePrices`
// arrays serialized as JSON strings (Polymarket quirk). Multi-outcome markets
// are the same shape with N entries. clobTokenIds (also a JSON-string array)
// indexes the same N. Pack into a single `[{outcome, price, token_id}]`
// JSONB column — readers don't need to know about the parallel-array quirk.
export function parseOutcomes(m) {
  const names = parseJsonArray(m?.outcomes);
  const prices = parseJsonArray(m?.outcomePrices);
  const tokens = parseJsonArray(m?.clobTokenIds);
  if (!names) return null;
  const out = [];
  for (let i = 0; i < names.length; i++) {
    out.push({
      outcome: names[i] != null ? String(names[i]) : null,
      price: prices?.[i] != null ? Number(prices[i]) : null,
      token_id: tokens?.[i] != null ? String(tokens[i]) : null,
    });
  }
  return out.length ? out : null;
}

function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function toNumOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// Coerce ISO-ish strings to ISO; pass through unparseable values as null so
// the TIMESTAMPTZ column doesn't reject the row.
export function parseTimestamp(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

export const __test__ = { normalizeMarket, parseTags, parseOutcomes, parseTimestamp, toNumOrNull };
