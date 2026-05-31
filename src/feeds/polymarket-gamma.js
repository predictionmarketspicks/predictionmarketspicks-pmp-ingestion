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

// Curated allowlist of Polymarket tag slugs PMP actually surfaces.
// Derived 2026-05-15 from caller audit in handoffs/POLYMARKET_FLY_MIGRATION_PLAN.md:
//   - lib/api/sports.ts          → sports
//   - lib/api/world.ts           → world
//   - lib/api/politics.ts        → politics
//   - lib/api/polymarket.ts      → trending + crypto
//   - lib/home/get-homepage-mover-boxes.ts → crypto
//   - ingest-election-2028        → us-election-2028
//   - signal-compute + arb-scanner work off slugs that surface via the above
// Add a slug here ONLY after wiring a consumer that needs it.
export const POLY_TAG_ALLOWLIST = [
  'crypto',
  'politics',
  'us-election-2028',
  'world',
  'sports',         // narrow — Gamma's "sports" tag is the cross-platform set we use
  'economy',
  'fed-rate',
  'culture',        // entertainment / cultural moments
];

// ── Sports daily-game coverage ───────────────────────────────────────────────
// The top-N-by-volume pull above competes sports games against crypto/politics
// for SNAPSHOT_LIMIT slots, so daily MLB/NBA/NHL/WC games below the global cut
// never get ingested — and the Kalshi↔Poly arb engine can't match what isn't
// there. fetchSportsGameMarkets() pulls the full daily game slate directly off
// Gamma's `games` tag (id 100639 — binary game-outcome markets ONLY; futures
// like World Series / MVP live under `mlb`/`mlb-playoffs`, NOT `games`).
// Verified live 2026-05-31. Numeric tag_id is required — Gamma's /markets
// ignores tag_slug.
const GAMES_TAG_ID = 100639;

// Only the leagues the site arb engine actually matches (lib/arb SPORT_CONFIG:
// MLB/NBA/NHL/NFL + FIFA World Cup). Storing other leagues' games would write
// rows nothing consumes. WC slug prefix isn't final pre-tournament; cover the
// observed FIFA variants.
const ARB_LEAGUE_PREFIXES = new Set(['mlb', 'nba', 'nhl', 'nfl', 'wc', 'fifwc', 'fif']);

// Date-stamped game slug: <league>-<away>-<home>-YYYY-MM-DD (matches the PR #151
// site matcher). The trailing date anchor rejects futures/props
// (will-…-championship-199, mlb-world-series-champion-2026, …-al-mvp).
const GAME_SLUG_RE = /^[a-z0-9]+-.+-\d{4}-\d{2}-\d{2}$/;

// Thin-market noise gate. A Poly game with trivial 24h volume can post a stale
// last-trade price that manufactures a fake edge vs Kalshi. Live distribution
// (2026-05-31): real games $1.3k–$3.4M; the <$2k tail was just-opened/illiquid.
// $2k keeps ~18/20 and kills the noise. Retune via env — no redeploy.
const SPORTS_GAME_MIN_VOL_USDC = Number(process.env.POLY_SPORTS_MIN_VOL_USDC || 2000);

// Pure per-row decision (unit-testable without a live Gamma call): returns a
// normalized, sports-categorized row if the market is an arb-league game market
// at/above the floor, else null.
export function keepSportsGameRow(m, minVolumeUsdc = SPORTS_GAME_MIN_VOL_USDC) {
  const slug = typeof m?.slug === 'string' ? m.slug : '';
  if (!GAME_SLUG_RE.test(slug)) return null; // futures/props/non-game
  if (!ARB_LEAGUE_PREFIXES.has(slug.split('-')[0])) return null; // non-arb league
  const row = normalizeMarket(m);
  if (!row) return null;
  if ((row.volume_24h_usdc ?? 0) < minVolumeUsdc) return null; // noise gate
  row.category = 'sports'; // arb read filters on category='sports'
  return row;
}

// Pull the full daily game slate for arb leagues, floored to kill thin-market
// noise. Paginates the `games` tag by volume desc and stops once a page's top
// volume is already below the floor (nothing useful past it) — so it never
// walks the whole tag. Row shape matches fetchTopMarkets (category='sports').
export async function fetchSportsGameMarkets({
  minVolumeUsdc = SPORTS_GAME_MIN_VOL_USDC,
  maxPages = 5,
  timeoutMs = GAMMA_FETCH_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const nowIso = new Date().toISOString();
  const rows = [];
  try {
    for (let page = 0; page < maxPages; page++) {
      const url =
        `${GAMMA_API_BASE}/markets?active=true&closed=false&tag_id=${GAMES_TAG_ID}` +
        `&order=volume24hr&ascending=false&end_date_min=${encodeURIComponent(nowIso)}` +
        `&limit=100&offset=${page * 100}&include_tag=true`;
      const res = await gammaGet(url, { signal: controller.signal, label: 'poly-sports-games' });
      if (!res.ok) {
        console.warn(`[poly-sports-games] HTTP ${res.status} on page ${page} — stopping`);
        break;
      }
      const json = await res.json();
      const markets = Array.isArray(json) ? json : Array.isArray(json?.markets) ? json.markets : [];
      if (markets.length === 0) break;
      const pageMaxVol = markets.reduce(
        (mx, m) => Math.max(mx, toNumOrNull(m?.volume24hr ?? m?.volumeNum) ?? 0),
        0,
      );
      for (const m of markets) {
        const row = keepSportsGameRow(m, minVolumeUsdc);
        if (row) rows.push(row);
      }
      // Everything past this page is below the floor (volume-desc order) — stop.
      if (pageMaxVol < minVolumeUsdc || markets.length < 100) break;
    }
    console.log(`[poly-sports-games] kept ${rows.length} game markets >= $${minVolumeUsdc} 24h vol`);
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

// Pick the most-specific allowlist tag as category. Falls through priority
// order so `us-election-2028` wins over generic `politics`.
export function pickCategory(tags) {
  if (!Array.isArray(tags)) return null;
  const priority = ['us-election-2028', 'fed-rate', 'economy', 'crypto', 'politics', 'sports', 'world', 'culture'];
  const tagSlugs = tags
    .map((t) => (typeof t === 'string' ? t : t?.slug))
    .filter(Boolean);
  for (const p of priority) if (tagSlugs.includes(p)) return p;
  return tagSlugs[0] ?? null;
}

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

    // 2026-05-15: filter to allowlist tags. Reduces 200-row payload to ~60–80
    // rows of markets we actually surface, with no downstream caller change.
    const filtered = markets.filter((m) => {
      const tags = Array.isArray(m?.tags) ? m.tags : [];
      for (const t of tags) {
        const slug = typeof t === 'string' ? t : t?.slug;
        if (slug && POLY_TAG_ALLOWLIST.includes(slug)) return true;
      }
      return false;
    });

    // Sanity log — drop a counter so a misconfigured tag list is visible.
    console.log(
      `[polymarket-gamma] filtered ${markets.length} → ${filtered.length} after allowlist`,
    );

    let logged = 0;
    const rows = [];
    for (const m of filtered) {
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
    category: pickCategory(m.tags) ?? (typeof m.category === 'string' ? m.category : null),
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

export const __test__ = { normalizeMarket, parseTags, parseOutcomes, parseTimestamp, toNumOrNull, pickCategory, keepSportsGameRow };
