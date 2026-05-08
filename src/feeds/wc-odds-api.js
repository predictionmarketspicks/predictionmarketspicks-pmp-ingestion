// World Cup 2026 — DraftKings consensus via The Odds API.
//
// Two sport keys are relevant:
//   soccer_fifa_world_cup_winner   → outright champion + group winner futures
//   soccer_fifa_world_cup          → individual matches (lit up ~7 days
//                                    before kickoff; pre-tournament returns
//                                    [])
//
// Free tier: 500 credits/month. The wc-snapshot orchestrator calls this
// feed every 30min, but we cannot afford 48 calls/day × 2 sport keys.
// Three nested gates keep credit burn inside budget — see
// handoffs/ODDS_API_QUOTA_PLAN_2026-05-08.md for the full phasing plan.
//
//   1. Interval gate — `WC_ODDS_API_INTERVAL_MS` (default 7 days; bumped to
//      ~24h on June 4, kept at 24h through the tournament). Within the
//      interval we re-emit the cached row set so DK columns in
//      world_cup_market_snapshot stay populated without re-spending credits.
//   2. Match-day gate — H2H (per-match) sweep only fires when a kickoff is
//      within `[-LOOKBACK, +LOOKAHEAD]` of now (defaults: 6h / 24h). Outside
//      that window only the cheap outright sweep runs. Schedule lives in
//      `data/wc-2026-schedule.json`.
//   3. Floor gate — if `x-requests-remaining < ODDS_API_MIN_REMAINING`
//      (default 100, raised from 30 on 2026-05-08), all fetches are
//      skipped and a Discord #bot-logs alert fires (24h dedup).
//
// Output rows use platform='draftkings' (DK consensus) and kind=champion or
// match_winner_*. Group winner outrights aren't surfaced by The Odds API in
// a structured way so we skip them.

import { readFileSync } from 'node:fs';
import {
  lookupTeamByName,
  lookupGroupMatchId,
  americanOddsToImpliedPct,
  priceToCents,
} from './wc-shared.js';
import { postBotLog } from '../delivery/discord.js';

const ODDS_BASE = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4/sports';
const ODDS_TIMEOUT_MS = Number(process.env.ODDS_API_TIMEOUT_MS || 15_000);
const ODDS_API_MIN_REMAINING = Number(process.env.ODDS_API_MIN_REMAINING || 100);
const WC_ODDS_API_INTERVAL_MS = Number(
  process.env.WC_ODDS_API_INTERVAL_MS || 7 * 24 * 60 * 60 * 1000,
);
const WC_ODDS_API_ALERT_DEDUP_MS = Number(
  process.env.WC_ODDS_API_ALERT_DEDUP_MS || 24 * 60 * 60 * 1000,
);
const MATCH_DAY_LOOKAHEAD_MS = Number(
  process.env.WC_MATCH_DAY_LOOKAHEAD_MS || 24 * 60 * 60 * 1000,
);
const MATCH_DAY_LOOKBACK_MS = Number(
  process.env.WC_MATCH_DAY_LOOKBACK_MS || 6 * 60 * 60 * 1000,
);

let lastRemaining = null;
let lastFetchAt = null;
let cachedRows = null;
let lastAlertAt = null;

const SCHEDULE = loadSchedule();

function loadSchedule() {
  try {
    const url = new URL('../../data/wc-2026-schedule.json', import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch (err) {
    console.warn('[wc-odds-api] schedule load failed — match-day gate disabled, fail-open:', err?.message || err);
    return null;
  }
}

// Match-day window check. Returns true if any match kickoff is within
// `[-LOOKBACK, +LOOKAHEAD]` of `now` (covers pre-game line build + post-game
// settlement noise), or if any knockout round window straddles now.
// Fail-open: if schedule is missing or malformed, return true.
export function isMatchDayWindow(now = Date.now()) {
  if (!SCHEDULE) return true;
  const matches = SCHEDULE.group_stage || [];
  for (const m of matches) {
    const k = Date.parse(m.kickoff_utc);
    if (!Number.isFinite(k)) continue;
    const delta = now - k;
    if (delta < 0 && -delta <= MATCH_DAY_LOOKAHEAD_MS) return true;
    if (delta >= 0 && delta <= MATCH_DAY_LOOKBACK_MS) return true;
  }
  for (const w of SCHEDULE.knockout_windows || []) {
    const start = Date.parse(`${w.start_date_utc}T00:00:00Z`);
    const end = Date.parse(`${w.end_date_utc}T23:59:59Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (now >= start - MATCH_DAY_LOOKAHEAD_MS && now <= end + MATCH_DAY_LOOKBACK_MS) {
      return true;
    }
  }
  return false;
}

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

async function tryAlertQuotaGuard(remaining) {
  const now = Date.now();
  if (lastAlertAt && (now - lastAlertAt) < WC_ODDS_API_ALERT_DEDUP_MS) return;
  lastAlertAt = now;
  try {
    const msg =
      `:warning: **The Odds API quota guard tripped**\n` +
      `Remaining: \`${remaining}\` (floor: \`${ODDS_API_MIN_REMAINING}\`)\n` +
      `wc-odds-api is now skipping fetches until quota resets or floor is lowered.\n` +
      `Source: \`pmp-ingestion/src/feeds/wc-odds-api.js\` on Fly.`;
    await postBotLog(msg);
  } catch (err) {
    console.error('[wc-odds-api] quota alert post failed:', err?.message || err);
  }
}

export async function fetchWcOddsApiRows({ timeoutMs = ODDS_TIMEOUT_MS } = {}) {
  if (!process.env.THE_ODDS_API_KEY) {
    console.log('[wc-odds-api] THE_ODDS_API_KEY not set — skipping');
    return [];
  }

  const now = Date.now();

  // Gate 1 — interval throttle. Re-emit cached rows on close ticks so DK
  // entries in world_cup_market_snapshot stay populated without re-spend.
  // First boot has no cache; let it fall through.
  const intervalElapsed =
    !lastFetchAt || now - lastFetchAt >= WC_ODDS_API_INTERVAL_MS;
  if (!intervalElapsed && Array.isArray(cachedRows) && cachedRows.length > 0) {
    const hoursSince = ((now - lastFetchAt) / 3_600_000).toFixed(1);
    const intervalH = (WC_ODDS_API_INTERVAL_MS / 3_600_000).toFixed(1);
    console.log(
      `[wc-odds-api] interval gate (${hoursSince}h since last fetch, threshold ${intervalH}h) — emitting ${cachedRows.length} cached rows`,
    );
    return cachedRows;
  }

  // Gate 3 (early) — quota floor. Skip the network entirely and alert once
  // per 24h. We hit this case on the first tick AFTER a fetch dropped the
  // counter under the floor; subsequent ticks will keep emitting cached rows
  // until interval rolls over.
  if (lastRemaining != null && lastRemaining < ODDS_API_MIN_REMAINING) {
    console.warn(
      `[wc-odds-api] quota guard: ${lastRemaining} remaining, below floor ${ODDS_API_MIN_REMAINING} — skipping scan`,
    );
    await tryAlertQuotaGuard(lastRemaining);
    return Array.isArray(cachedRows) ? cachedRows : [];
  }

  // Gate 2 — match-day awareness for the per-match (H2H) sweep. Outrights
  // are 1 cheap event so they always run.
  const matchDay = isMatchDayWindow(now);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const tasks = [fetchOutrights(controller.signal)];
    if (matchDay) {
      tasks.push(fetchH2H(controller.signal));
    } else {
      console.log('[wc-odds-api] match-day gate: no kickoff in window — skipping H2H sweep');
      tasks.push(Promise.resolve([]));
    }
    const [outrights, h2h] = await Promise.all(tasks);
    const rows = [...rowsFromOutrights(outrights), ...rowsFromH2H(h2h)];

    lastFetchAt = now;
    cachedRows = rows;

    console.log(
      `[wc-odds-api] outright_events=${outrights.length} h2h_events=${h2h.length} rows=${rows.length} quota_remaining=${lastRemaining} match_day=${matchDay}`,
    );

    // If THIS fetch dropped the counter below the floor, alert immediately
    // (don't wait for the next tick to skip).
    if (lastRemaining != null && lastRemaining < ODDS_API_MIN_REMAINING) {
      await tryAlertQuotaGuard(lastRemaining);
    }

    return rows;
  } finally {
    clearTimeout(timer);
  }
}

export function getOddsApiQuotaRemaining() {
  return lastRemaining;
}

// Test-only state reset so vitest specs don't bleed module state across cases.
export function __resetWcOddsApiState() {
  lastRemaining = null;
  lastFetchAt = null;
  cachedRows = null;
  lastAlertAt = null;
}

export const __test__ = { rowsFromOutrights, rowsFromH2H, isMatchDayWindow };
