// World Cup 2026 — DraftKings consensus via The Odds API.
//
// Two sport keys are relevant:
//   soccer_fifa_world_cup_winner   → outright champion + group winner futures
//   soccer_fifa_world_cup          → individual matches (lit up ~7 days
//                                    before kickoff; pre-tournament returns
//                                    [])
//
// Free tier: 500 credits/month. We're a single 30min consumer; even at
// peak (48 credits per scan × 48 scans/day × 30 days) we'd well exceed
// quota — so we ALWAYS use a single fetch per sport key per scan
// (~1 credit each) and DK-only bookmaker filter to keep payloads small.
//
// Output rows use platform='draftkings' (DK consensus) and kind=champion or
// match_winner_*. Group winner outrights aren't surfaced by The Odds API in
// a structured way so we skip them.

import {
  lookupTeamByName,
  lookupGroupMatchId,
  americanOddsToImpliedPct,
  priceToCents,
} from './wc-shared.js';

const ODDS_BASE = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4/sports';
const ODDS_TIMEOUT_MS = Number(process.env.ODDS_API_TIMEOUT_MS || 15_000);
const ODDS_MIN_REMAINING = Number(process.env.ODDS_API_MIN_REMAINING || 30);

let lastRemaining = null;

async function oddsGet(url, signal) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'pmp-ingestion/wc-odds-api' },
    signal,
  });
  const remaining = Number(res.headers.get('x-requests-remaining'));
  if (Number.isFinite(remaining)) lastRemaining = remaining;
  return res;
}

async function fetchOutrights(signal) {
  if (!process.env.THE_ODDS_API_KEY) return [];
  const qs = new URLSearchParams({
    apiKey: process.env.THE_ODDS_API_KEY,
    regions: 'us',
    markets: 'outrights',
    oddsFormat: 'american',
    bookmakers: 'draftkings',
  }).toString();
  const url = `${ODDS_BASE}/soccer_fifa_world_cup_winner/odds?${qs}`;
  try {
    const res = await oddsGet(url, signal);
    if (!res.ok) {
      console.warn(`[wc-odds-api] outrights HTTP ${res.status}`);
      return [];
    }
    return await res.json();
  } catch (err) {
    console.warn('[wc-odds-api] outrights fetch error:', err?.message || err);
    return [];
  }
}

async function fetchH2H(signal) {
  if (!process.env.THE_ODDS_API_KEY) return [];
  const qs = new URLSearchParams({
    apiKey: process.env.THE_ODDS_API_KEY,
    regions: 'us',
    markets: 'h2h',
    oddsFormat: 'american',
    bookmakers: 'draftkings',
  }).toString();
  const url = `${ODDS_BASE}/soccer_fifa_world_cup/odds?${qs}`;
  try {
    const res = await oddsGet(url, signal);
    if (!res.ok) {
      // Pre-tournament this returns 404 with "unknown sport key"; quiet log.
      if (res.status !== 404) console.warn(`[wc-odds-api] h2h HTTP ${res.status}`);
      return [];
    }
    return await res.json();
  } catch (err) {
    console.warn('[wc-odds-api] h2h fetch error:', err?.message || err);
    return [];
  }
}

// DK affiliate URL is the same for every WC market — per CLAUDE.md
// "every DK click routes through the BRich11 referral path".
const DK_REFERRAL_URL =
  'https://sportsbook.draftkings.com/r/sb/BRich11/US-NJ-SB/US-NJ';

function rowsFromOutrights(events) {
  const rows = [];
  for (const ev of events) {
    if (!Array.isArray(ev?.bookmakers)) continue;
    for (const bk of ev.bookmakers) {
      if (bk.key !== 'draftkings') continue;
      for (const market of bk.markets || []) {
        if (market.key !== 'outrights') continue;
        for (const out of market.outcomes || []) {
          const team = lookupTeamByName(out.name);
          if (!team) continue;
          const pct = americanOddsToImpliedPct(out.price);
          const cents = priceToCents(pct);
          if (cents == null) continue;
          rows.push({
            entity_id: `team:${team.slug}`,
            kind: 'champion',
            platform: 'draftkings',
            ticker_or_id: `${ev.id || 'wc-outright'}:${team.code}`,
            yes_price_cents: cents,
            volume_24h: null,
            price_change_24h_pp: null,
            liquidity: null,
            url: DK_REFERRAL_URL,
          });
        }
      }
    }
  }
  return rows;
}

function rowsFromH2H(events) {
  const rows = [];
  for (const ev of events) {
    if (!Array.isArray(ev?.bookmakers)) continue;
    const home = lookupTeamByName(ev.home_team);
    const away = lookupTeamByName(ev.away_team);
    if (!home || !away) continue;
    const match = lookupGroupMatchId(home.slug, away.slug);
    if (!match) continue; // knockout matches deferred to PR 4
    for (const bk of ev.bookmakers) {
      if (bk.key !== 'draftkings') continue;
      for (const market of bk.markets || []) {
        if (market.key !== 'h2h') continue;
        for (const out of market.outcomes || []) {
          const pct = americanOddsToImpliedPct(out.price);
          const cents = priceToCents(pct);
          if (cents == null) continue;
          let kind = null;
          if (/^draw$/i.test(out.name || '')) {
            kind = 'match_winner_draw';
          } else {
            const t = lookupTeamByName(out.name);
            if (!t) continue;
            if (t.slug === match.home) kind = 'match_winner_home';
            else if (t.slug === match.away) kind = 'match_winner_away';
            else continue;
          }
          rows.push({
            entity_id: match.id,
            kind,
            platform: 'draftkings',
            ticker_or_id: `${ev.id}:${kind}`,
            yes_price_cents: cents,
            volume_24h: null,
            price_change_24h_pp: null,
            liquidity: null,
            url: DK_REFERRAL_URL,
          });
        }
      }
    }
  }
  return rows;
}

export async function fetchWcOddsApiRows({ timeoutMs = ODDS_TIMEOUT_MS } = {}) {
  if (!process.env.THE_ODDS_API_KEY) {
    console.log('[wc-odds-api] THE_ODDS_API_KEY not set — skipping');
    return [];
  }
  if (lastRemaining != null && lastRemaining < ODDS_MIN_REMAINING) {
    console.warn(`[wc-odds-api] quota guard: ${lastRemaining} remaining, skipping scan`);
    return [];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [outrights, h2h] = await Promise.all([
      fetchOutrights(controller.signal),
      fetchH2H(controller.signal),
    ]);
    const rows = [...rowsFromOutrights(outrights), ...rowsFromH2H(h2h)];
    console.log(
      `[wc-odds-api] outright_events=${outrights.length} h2h_events=${h2h.length} rows=${rows.length} quota_remaining=${lastRemaining}`,
    );
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

export function getOddsApiQuotaRemaining() {
  return lastRemaining;
}

export const __test__ = { rowsFromOutrights, rowsFromH2H };
