// World Cup 2026 Polymarket feed.
//
// Polymarket WC markets are spread across multiple Gamma tags ("world-cup",
// "world-cup-2026", "fifa-world-cup", "soccer"). We fetch by tag and parse
// the question text to derive the entity_id + kind. Slug-based URLs link
// directly to the market page. Tag taxonomy was verified during the
// Polymarket → Fly migration (Session A); plain `tags @>` reads work.
//
// When the parser can't classify a market, the row is dropped and counted
// in the stats line. PR 4 will harden the parser as the WC market catalog
// crystallizes.

import {
  lookupTeamByName,
  lookupGroupMatchId,
  detectReachKind,
  priceToCents,
  polymarketMarketUrl,
} from './wc-shared.js';
import { normalizeMarket } from './polymarket-gamma.js';

const GAMMA_API_BASE = process.env.POLYMARKET_GAMMA_BASE || 'https://gamma-api.polymarket.com';
const GAMMA_FETCH_TIMEOUT_MS = Number(process.env.GAMMA_FETCH_TIMEOUT_MS || 30_000);
const GAMMA_RETRY_DELAY_MS = Number(process.env.GAMMA_RETRY_DELAY_MS || 800);
const GAMMA_MAX_ATTEMPTS = 4;

const WC_TAGS = (process.env.WC_POLYMARKET_TAGS || 'world-cup,world-cup-2026,fifa-world-cup,fifa-world-cup-2026')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

async function gammaGet(url, { signal, label = 'wc-poly' } = {}) {
  let res;
  for (let attempt = 0; attempt < GAMMA_MAX_ATTEMPTS; attempt++) {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'pmp-ingestion/wc-polymarket' },
      signal,
    });
    if (res.status !== 429) return res;
    if (attempt === GAMMA_MAX_ATTEMPTS - 1) return res;
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : GAMMA_RETRY_DELAY_MS;
    console.warn(`[${label}] 429 — retry in ${wait}ms (${attempt + 1}/${GAMMA_MAX_ATTEMPTS})`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return res;
}

// Fetches Gamma markets matching any WC tag. Gamma `?tag=<slug>` is OR-able
// only as repeated params; we fan out one call per tag and dedupe by
// condition_id. Limit per tag is 200 — plenty for WC at any point in time.
async function fetchByTags(signal) {
  const all = new Map(); // condition_id → market record
  for (const tag of WC_TAGS) {
    const url = `${GAMMA_API_BASE}/markets?active=true&closed=false&tag_slug=${encodeURIComponent(tag)}&limit=200&include_tag=true`;
    try {
      const res = await gammaGet(url, { signal, label: `wc-poly:${tag}` });
      if (!res.ok) {
        console.warn(`[wc-polymarket] tag=${tag} HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const markets = Array.isArray(json) ? json : Array.isArray(json?.markets) ? json.markets : [];
      for (const m of markets) {
        if (m && typeof m.conditionId === 'string') all.set(m.conditionId, m);
      }
    } catch (err) {
      console.warn(`[wc-polymarket] tag=${tag} fetch error:`, err?.message || err);
    }
  }
  return [...all.values()];
}

// Polymarket question parser. WC questions are typically:
//   "Will {Team} win the 2026 FIFA World Cup?" → champion
//   "Will {Team} win Group X?" → group_winner
//   "Will {Team} reach the {round}?" → reach_*
//   "Will {Team A} beat {Team B}?" or "{Team A} vs {Team B} winner" → match_*
//   "Will {Player} win Golden Boot?" → golden_boot
//   "Will {Player} score in {Match}?" → player_anytime_scorer
//
// Returns { entity_id, kind } or null.
export function classifyPolymarketQuestion(question, slug) {
  if (typeof question !== 'string') return null;
  const q = question.trim();

  // Champion
  if (/win the\s*(?:2026\s+)?(?:fifa\s+)?world cup/i.test(q)) {
    const cleaned = q
      .replace(/^will\s+/i, '')
      .replace(/\s+win the\s+(?:2026\s+)?(?:fifa\s+)?world cup\??$/i, '')
      .replace(/\?+$/, '')
      .trim();
    const team = lookupTeamByName(cleaned);
    if (team) return { entity_id: `team:${team.slug}`, kind: 'champion' };
  }

  // Group winner
  const groupMatch = q.match(/^(?:will\s+)?(.+?)\s+win\s+group\s+([a-l])\b/i);
  if (groupMatch) {
    const team = lookupTeamByName(groupMatch[1]);
    if (team) return { entity_id: `team:${team.slug}`, kind: 'group_winner' };
  }

  // Reach round
  const reachKind = detectReachKind(q);
  if (reachKind) {
    const cleaned = q
      .replace(/\b(reach|make).*$/i, '')
      .replace(/^will\s+/i, '')
      .trim();
    const team = lookupTeamByName(cleaned);
    if (team) return { entity_id: `team:${team.slug}`, kind: reachKind };
  }

  // Match-level. Two phrasings: "X to beat Y" / "X beats Y" / "X vs Y winner".
  const beat = q.match(/(?:will\s+)?(.+?)\s+(?:beat|defeat)\s+(.+?)(?:\?|$)/i);
  const vs = q.match(/(.+?)\s+vs\.?\s+(.+?)(?:\?|\s+winner|\s+goals|$)/i);
  if (beat || vs) {
    const m = beat || vs;
    const teamA = lookupTeamByName(m[1]);
    const teamB = lookupTeamByName(m[2]);
    if (teamA && teamB) {
      const match = lookupGroupMatchId(teamA.slug, teamB.slug);
      if (match) {
        if (/over 2\.?5|more than 2\.?5/i.test(q)) return { entity_id: match.id, kind: 'match_o25' };
        if (/both teams to score|btts/i.test(q)) return { entity_id: match.id, kind: 'match_btts' };
        if (/draw\b/i.test(q) && /winner|outcome|result/i.test(q)) return { entity_id: match.id, kind: 'match_winner_draw' };
        if (beat) {
          // explicit beat = teamA winning
          if (teamA.slug === match.home) return { entity_id: match.id, kind: 'match_winner_home' };
          if (teamA.slug === match.away) return { entity_id: match.id, kind: 'match_winner_away' };
        }
      }
    }
  }

  // Golden boot
  if (/golden boot|top scorer/i.test(q)) {
    const cleaned = q
      .replace(/^will\s+/i, '')
      .replace(/\s+win\s+(?:the\s+)?(?:golden boot|top scorer).*$/i, '')
      .replace(/\?+$/, '')
      .trim();
    const slugFromQ = nameToSlug(cleaned);
    if (slugFromQ) return { entity_id: `player:${slugFromQ}`, kind: 'golden_boot' };
  }

  // Anytime scorer
  if (/(score|goal)\s+in\s+(?:the\s+)?world cup/i.test(q) || /score in any (?:world cup\s+)?match/i.test(q)) {
    const m2 = q.match(/(?:will\s+)?(.+?)\s+score/i);
    if (m2) {
      const slugFromQ = nameToSlug(m2[1]);
      if (slugFromQ) return { entity_id: `player:${slugFromQ}`, kind: 'player_anytime_scorer' };
    }
  }

  return null;
}

function nameToSlug(name) {
  if (typeof name !== 'string') return null;
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.length >= 3 ? slug : null;
}

// Pull yes-side price out of the normalized market record. Polymarket binary
// markets have `outcomes: [{outcome, price, token_id}]`; the YES side is
// usually `outcome === 'Yes'`. last_trade_price is the fallback for markets
// without a current bid/ask.
function yesPriceFromMarket(norm) {
  if (norm?.outcomes?.length) {
    const yes = norm.outcomes.find((o) => /^yes$/i.test(o?.outcome || ''));
    if (yes && yes.price != null) return Number(yes.price);
  }
  if (norm?.best_ask != null) return Number(norm.best_ask);
  if (norm?.last_trade_price != null) return Number(norm.last_trade_price);
  if (norm?.best_bid != null) return Number(norm.best_bid);
  return null;
}

export async function fetchWcPolymarketRows({ timeoutMs = GAMMA_FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raw = await fetchByTags(controller.signal);
    const rows = [];
    let dropped = 0;

    for (const m of raw) {
      const norm = normalizeMarket(m);
      if (!norm) {
        dropped++;
        continue;
      }
      const yes = yesPriceFromMarket(norm);
      const cents = priceToCents(yes);
      if (cents == null) {
        dropped++;
        continue;
      }
      const classified = classifyPolymarketQuestion(norm.question, norm.slug);
      if (!classified) {
        dropped++;
        continue;
      }
      rows.push({
        entity_id: classified.entity_id,
        kind: classified.kind,
        platform: 'polymarket',
        ticker_or_id: norm.condition_id,
        yes_price_cents: cents,
        volume_24h: norm.volume_24h_usdc,
        price_change_24h_pp: null, // Gamma doesn't expose 24h-prev for binary markets
        liquidity: norm.liquidity_usdc,
        url: polymarketMarketUrl(norm.slug),
      });
    }
    console.log(
      `[wc-polymarket] parsed ${rows.length}/${raw.length} markets (${dropped} dropped, tags=${WC_TAGS.join(',')})`,
    );
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

export const __test__ = { classifyPolymarketQuestion, nameToSlug, yesPriceFromMarket };
