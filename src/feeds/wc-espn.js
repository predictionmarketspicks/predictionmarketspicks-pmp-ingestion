// World Cup 2026 ESPN scoreboard feed.
//
// Fetches ESPN's public scoreboard for the FIFA World Cup. ESPN is read-only
// game state — score, period/minute, status — not a price source. The data
// doesn't write to world_cup_market_snapshot. PR 4 (mispricing) consumes it
// to gate live-game alerts.
//
// In-memory state only. The engine module exposes getWcEspnState() so
// /health and PR 4 can read the latest snapshot.
//
// ESPN endpoint: site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard
// No auth, no rate limit documented; we fetch once per 30min scan and cache
// the JSON in memory.

import { lookupTeamByName, lookupGroupMatchId } from './wc-shared.js';

// Knockout fixtures aren't in the group schedule, so lookupGroupMatchId() returns
// null for them and the result writer (which requires a match_id) used to drop
// every bracket score. Mint a stable id from the sorted 3-letter codes: each pair
// meets at most once in single-elimination, so the unordered pair is unique and
// home/away orientation between ESPN and our fixtures never splits it in two.
function knockoutMatchId(codeA, codeB) {
  const [a, b] = [codeA, codeB].sort();
  return `match:KO-${a}-${b}`;
}

const ESPN_BASE =
  process.env.ESPN_WC_BASE ||
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const ESPN_TIMEOUT_MS = Number(process.env.ESPN_TIMEOUT_MS || 15_000);

// Pull the FIFA World Cup scoreboard (defaults to today). ESPN uses
// `?dates=YYYYMMDD` for arbitrary dates; we don't pin one — the default
// returns the current matchday window.
async function fetchEspnScoreboard(signal) {
  try {
    const res = await fetch(ESPN_BASE, {
      headers: { Accept: 'application/json', 'User-Agent': 'pmp-ingestion/wc-espn' },
      signal,
    });
    if (!res.ok) {
      console.warn(`[wc-espn] HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn('[wc-espn] fetch error:', err?.message || err);
    return null;
  }
}

// Reduce ESPN's verbose payload to one row per match.
// status.type.state ∈ {'pre','in','post'}.
function normalizeEvents(json) {
  if (!json || !Array.isArray(json.events)) return [];
  const out = [];
  for (const ev of json.events) {
    const competition = Array.isArray(ev.competitions) ? ev.competitions[0] : null;
    const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
    const homeC = competitors.find((c) => c.homeAway === 'home');
    const awayC = competitors.find((c) => c.homeAway === 'away');
    if (!homeC || !awayC) continue;
    const home = lookupTeamByName(homeC.team?.displayName || homeC.team?.name);
    const away = lookupTeamByName(awayC.team?.displayName || awayC.team?.name);
    if (!home || !away) continue;

    const match = lookupGroupMatchId(home.slug, away.slug);
    const isKnockout = !match;
    out.push({
      espn_event_id: String(ev.id || ''),
      match_id: match?.id || knockoutMatchId(home.code, away.code),
      is_knockout: isKnockout,
      home_slug: home.slug,
      away_slug: away.slug,
      start_time: ev.date || null,
      state: ev.status?.type?.state || null, // pre / in / post
      status_name: ev.status?.type?.name || null, // e.g. STATUS_FULL_TIME
      detail: ev.status?.type?.shortDetail || ev.status?.type?.description || null,
      clock: ev.status?.displayClock || null,
      period: ev.status?.period ?? null,
      home_score: numOrNull(homeC.score),
      away_score: numOrNull(awayC.score),
      // Penalty-shootout tally + winner flag (knockout only; null/false in group).
      // ESPN carries these on the competitor once a tie is decided on penalties.
      home_shootout: numOrNull(homeC.shootoutScore),
      away_shootout: numOrNull(awayC.shootoutScore),
      home_winner: homeC.winner === true,
      away_winner: awayC.winner === true,
    });
  }
  return out;
}

function numOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function fetchWcEspnGames({ timeoutMs = ESPN_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const json = await fetchEspnScoreboard(controller.signal);
    const games = normalizeEvents(json);
    const live = games.filter((g) => g.state === 'in').length;
    const pre = games.filter((g) => g.state === 'pre').length;
    const post = games.filter((g) => g.state === 'post').length;
    console.log(`[wc-espn] events=${games.length} live=${live} pre=${pre} post=${post}`);
    return games;
  } finally {
    clearTimeout(timer);
  }
}

export const __test__ = { normalizeEvents };
