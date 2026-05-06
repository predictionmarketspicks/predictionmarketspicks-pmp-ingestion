// World Cup 2026 Kalshi feed.
//
// Fetches the 5 WC series in parallel (KXMENWORLDCUP, KXWCGROUPWIN,
// KXWCGAME, KXWCROUND, KXWCSQUAD) and emits normalized
// world_cup_market_snapshot rows. Title parsing is conservative — markets
// that don't match a known shape are dropped (and logged at DEBUG). PR 4
// will add coverage as new ticker shapes appear.
//
// Output shape (one entry per row): { entity_id, kind, platform: 'kalshi',
// ticker_or_id, yes_price_cents, volume_24h, price_change_24h_pp, liquidity,
// url, _raw_title } where _raw_title is debug-only and stripped before write.

import { kalshiGet, withConcurrency, toCents, toNum } from './movers.js';
import {
  lookupTeamByName,
  lookupTeamBySlug,
  lookupGroupMatchId,
  detectReachKind,
  priceToCents,
  kalshiMarketUrl,
} from './wc-shared.js';

const KALSHI_API_BASE =
  process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

const KALSHI_REST_CONCURRENCY = Number(process.env.KALSHI_REST_CONCURRENCY || 2);

// Series → market_kind mapping rules. Each rule's `parse` takes the Kalshi
// market record and returns { entity_id, kind, metadata } or null to drop.
const WC_SERIES = [
  { series: 'KXMENWORLDCUP', parse: parseChampionMarket },
  { series: 'KXWCGROUPWIN', parse: parseGroupWinMarket },
  { series: 'KXWCROUND', parse: parseReachRoundMarket },
  { series: 'KXWCGAME', parse: parseGameMarket },
  { series: 'KXWCSQUAD', parse: parseSquadMarket },
];

async function fetchSeriesMarkets(series, signal) {
  const url = `${KALSHI_API_BASE}/markets?series_ticker=${series}&status=open&limit=200`;
  try {
    const res = await kalshiGet(url, {
      signal,
      label: 'wc-kalshi',
      userAgent: 'pmp-ingestion/wc-kalshi',
    });
    if (!res.ok) {
      console.warn(`[wc-kalshi] ${series} HTTP ${res.status}`);
      return { series, markets: [] };
    }
    const json = await res.json();
    return { series, markets: Array.isArray(json?.markets) ? json.markets : [] };
  } catch (err) {
    console.warn(`[wc-kalshi] ${series} fetch error:`, err?.message || err);
    return { series, markets: [] };
  }
}

// Pick a yes-price field with the same fallback order the macro engine uses:
// yes_ask → yes_bid → last_price. Both the older numeric fields and newer
// *_dollars string fields are checked.
function readYesPriceCents(m) {
  const candidates = [
    m.yes_ask_dollars,
    m.yes_bid_dollars,
    m.last_price_dollars,
    m.yes_ask,
    m.yes_bid,
    m.last_price,
  ];
  for (const v of candidates) {
    if (v == null) continue;
    const cents = toCents(v);
    if (cents != null && cents >= 1 && cents <= 99) return cents;
  }
  return null;
}

function readVolume24h(m) {
  return toNum(m.volume_24h_fp ?? m.volume_24h) || null;
}

function readPriceChange24hPp(m) {
  // implied price change in percentage points across the last 24h.
  const cur = toCents(m.yes_ask_dollars ?? m.yes_bid_dollars ?? m.last_price_dollars);
  const prev = toCents(
    m.previous_yes_ask_dollars ?? m.previous_yes_bid_dollars ?? m.previous_price_dollars,
  );
  if (cur == null || prev == null) return null;
  return cur - prev;
}

function readLiquidity(m) {
  return toNum(m.liquidity ?? m.open_interest_fp ?? m.open_interest) || null;
}

// "{Team} to win the World Cup" → champion. Kalshi sometimes phrases as
// "Will {Team} win the 2026 FIFA World Cup?". Accept both.
function parseChampionMarket(m) {
  const title = `${m.title || ''} ${m.subtitle || ''}`.trim();
  if (!/world cup/i.test(title)) return null;
  // Strip generic preamble before extracting team name.
  const cleaned = title
    .replace(/^will\s+/i, '')
    .replace(/\s+(?:to\s+)?win the\s+(?:2026\s+)?(?:fifa\s+)?world cup\??$/i, '')
    .replace(/\?+$/, '')
    .trim();
  const team = lookupTeamByName(cleaned) || lookupTeamByName(m.subtitle) || lookupTeamByName(m.title);
  if (!team) return null;
  return { entity_id: `team:${team.slug}`, kind: 'champion' };
}

// "{Team} to win Group {Letter}" → group_winner.
function parseGroupWinMarket(m) {
  const title = `${m.title || ''} ${m.subtitle || ''}`.trim();
  if (!/group/i.test(title)) return null;
  // Best-effort: try the subtitle first (usually just team name), then the
  // full title minus group phrasing.
  const subteam = lookupTeamByName(m.subtitle);
  if (subteam) return { entity_id: `team:${subteam.slug}`, kind: 'group_winner' };
  const cleaned = title
    .replace(/\s*(?:to\s+)?win\s+group\s+[a-l]\b.*$/i, '')
    .replace(/^will\s+/i, '')
    .replace(/\?+$/, '')
    .trim();
  const team = lookupTeamByName(cleaned);
  if (!team) return null;
  return { entity_id: `team:${team.slug}`, kind: 'group_winner' };
}

// "{Team} to reach the {Round}" → reach_r16/qf/sf/final.
function parseReachRoundMarket(m) {
  const title = `${m.title || ''} ${m.subtitle || ''}`.trim();
  const kind = detectReachKind(title);
  if (!kind) return null;
  // Subtitle is usually the team name.
  const subteam = lookupTeamByName(m.subtitle);
  if (subteam) return { entity_id: `team:${subteam.slug}`, kind };
  // Otherwise strip the round phrasing and try again.
  const cleaned = title
    .replace(/\bto reach\b.*$/i, '')
    .replace(/\bto make\b.*$/i, '')
    .replace(/^will\s+/i, '')
    .trim();
  const team = lookupTeamByName(cleaned);
  if (!team) return null;
  return { entity_id: `team:${team.slug}`, kind };
}

// "{Team A} vs {Team B}" markets. Kalshi typically lists 3-way moneyline +
// totals + BTTS as separate markets; we use the floor_strike + market title
// to choose the correct kind. Team name fallback list is exhaustive.
function parseGameMarket(m) {
  const title = `${m.title || ''}`.trim();
  // Split on " vs " or " v. " — accept trailing context after a delimiter.
  // Em-dash (—), en-dash (–), and hyphen (-) all signal the end of team B.
  const vs = title.match(/^(.+?)\s+vs?\.?\s+(.+?)(?:\s*[—–-].*|\s*\(.*|\s*[:|].*|\s+over\b.*|\s+under\b.*|\s+to\b.*|\s+wins?\b.*|\s+draw\b.*|\s+both\b.*|\s*$)/i);
  if (!vs) return null;
  const teamA = lookupTeamByName(vs[1]);
  const teamB = lookupTeamByName(vs[2]);
  if (!teamA || !teamB) return null;
  const match = lookupGroupMatchId(teamA.slug, teamB.slug);
  if (!match) return null; // knockout markets — defer to PR 4

  // Decide kind from title/subtitle text.
  const fullText = `${m.title || ''} ${m.subtitle || ''}`;
  if (/over 2\.?5|\b(o\s*2\.?5|>\s*2\.?5)\b/i.test(fullText)) {
    return { entity_id: match.id, kind: 'match_o25' };
  }
  if (/both teams to score|\bbtts\b|both teams score/i.test(fullText)) {
    return { entity_id: match.id, kind: 'match_btts' };
  }
  // 3-way moneyline. Subtitle on Kalshi is usually the outcome side
  // ("Mexico", "Korea Republic", or "Draw"); some markets put the outcome
  // in the title after a separator ("Brazil vs Morocco — Draw").
  const sub = (m.subtitle || '').trim();
  if (/^draw$/i.test(sub) || /\bdraw\b/i.test(fullText)) {
    return { entity_id: match.id, kind: 'match_winner_draw' };
  }
  const subteam = lookupTeamByName(sub);
  if (subteam) {
    if (subteam.slug === match.home) return { entity_id: match.id, kind: 'match_winner_home' };
    if (subteam.slug === match.away) return { entity_id: match.id, kind: 'match_winner_away' };
  }
  // Title-after-separator phrasing: "France vs Senegal — France wins".
  const after = title.split(/\s*[—–-]\s*/i).slice(1).join(' ').trim();
  if (after) {
    const t = lookupTeamByName(after.replace(/\s+wins?\b.*$/i, '').trim());
    if (t) {
      if (t.slug === match.home) return { entity_id: match.id, kind: 'match_winner_home' };
      if (t.slug === match.away) return { entity_id: match.id, kind: 'match_winner_away' };
    }
  }
  // Couldn't tell — drop quietly.
  return null;
}

// Squad markets: golden boot + anytime scorer props.
function parseSquadMarket(m) {
  const title = `${m.title || ''} ${m.subtitle || ''}`.trim();
  if (/golden boot|top scorer/i.test(title)) {
    const player = playerSlugFromText(m.subtitle) || playerSlugFromText(title);
    if (!player) return null;
    return { entity_id: `player:${player}`, kind: 'golden_boot' };
  }
  if (/(anytime|to score|first goal|first scorer)/i.test(title)) {
    const player = playerSlugFromText(m.subtitle) || playerSlugFromText(title);
    if (!player) return null;
    return { entity_id: `player:${player}`, kind: 'player_anytime_scorer' };
  }
  return null;
}

// Loose player-name → slug. Lowercase, strip punctuation, hyphenate. We
// accept any string here; the seed maintains 25 known players but Kalshi may
// list more — we don't filter to the seed list because PR 4 is the consumer
// and can decide which players to score.
function playerSlugFromText(s) {
  if (typeof s !== 'string') return null;
  const cleaned = s
    .toLowerCase()
    .replace(/(golden boot|top scorer|to score|anytime|first|prop|world cup|2026)/gi, '')
    .replace(/[^a-z0-9 -]/g, '')
    .trim();
  if (!cleaned) return null;
  const slug = cleaned.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  // Reject if too short — likely a bad parse.
  if (slug.length < 3) return null;
  return slug;
}

// Returns one row per parseable Kalshi WC market across all 5 series.
export async function fetchWcKalshiRows({ timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const results = await withConcurrency(WC_SERIES, KALSHI_REST_CONCURRENCY, ({ series }) =>
      fetchSeriesMarkets(series, controller.signal),
    );

    const rows = [];
    let totalMarkets = 0;
    let dropped = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== 'fulfilled') continue;
      const { series, markets } = r.value;
      const parser = WC_SERIES[i].parse;
      totalMarkets += markets.length;

      for (const m of markets) {
        if (typeof m.ticker !== 'string') continue;
        if (m.ticker.startsWith('KXMVE')) continue; // catalog safety filter

        const yesCents = readYesPriceCents(m);
        if (yesCents == null) {
          dropped++;
          continue;
        }

        const parsed = parser(m);
        if (!parsed) {
          dropped++;
          continue;
        }

        rows.push({
          entity_id: parsed.entity_id,
          kind: parsed.kind,
          platform: 'kalshi',
          ticker_or_id: m.ticker,
          yes_price_cents: yesCents,
          volume_24h: readVolume24h(m),
          price_change_24h_pp: readPriceChange24hPp(m),
          liquidity: readLiquidity(m),
          url: kalshiMarketUrl(m.event_ticker || m.ticker),
        });
      }
    }
    console.log(
      `[wc-kalshi] parsed ${rows.length}/${totalMarkets} markets across ${WC_SERIES.length} series (${dropped} dropped)`,
    );
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

export const __test__ = {
  parseChampionMarket,
  parseGroupWinMarket,
  parseReachRoundMarket,
  parseGameMarket,
  parseSquadMarket,
  playerSlugFromText,
  readYesPriceCents,
};
