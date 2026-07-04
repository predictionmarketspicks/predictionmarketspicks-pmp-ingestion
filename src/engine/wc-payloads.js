// World Cup 2026 — V2 widget_payloads writer.
//
// Runs once per wc-snapshot tick (after market write + matview refresh +
// mispricing run). Two slugs:
//
//   world-cup-2026 — top 10 champion contenders by display-platform price.
//                    Builds the `_raw` array consumed by lib/world-cup.ts
//                    getWCPredictionMarketOdds() and the V2 hero/sidebar
//                    renderers (lib/widgets/v2/renderers/world-cup-2026.ts).
//
//   wc-mispricings  — top 5 STRONG mispricings as carousel cards. Mirrors
//                     lib/widgets/v2/renderers/wc-mispricings.types.ts —
//                     keep field names in sync if either changes.
//
// Failure model: each upsert is independent. A bad world-cup-2026 build
// doesn't block wc-mispricings (or vice versa), and an envelope build fault
// just logs — next 30min tick retries.
//
// Note: this module fetches sim/market/mispricings rows fresh from the
// matviews instead of threading them in from the orchestrator. The cost is
// two extra small selects per tick; the upside is the orchestrator stays
// simple and these payloads can be re-run via /dev/wc-payloads on demand.

import {
  fetchWcSimulationLatest,
  fetchWcMarketLatest,
  fetchWcMispricingsLatest,
  upsertWidgetPayloads,
} from '../delivery/supabase.js';
import { lookupTeamBySlug, lookupTeamByCode } from '../feeds/wc-shared.js';
import { recordTick } from '../observability/health.js';

const WORLD_CUP_2026_VARIANTS = ['hero', 'sidebar'];
const WC_MISPRICINGS_VARIANTS = ['hero', 'sidebar'];
const WORLD_CUP_2026_TOP_N = 10;
const WC_MISPRICINGS_TOP_N = 5;

// Eliminated-team guard for the champion board. Kalshi delists a settled
// champion outright, so an eliminated team's last snapshot freezes at its last
// traded price (e.g. ~6%) and — ranked by market price — floats onto the board
// (Netherlands sat 8th at 6% after being knocked out, until hand-patched with
// 1¢ rows). Two gates kill it permanently, no per-round patching:
//   1. Alive set — the standings-aware sim scores an eliminated team at exactly
//      0% champion, updated the moment it reruns post-result. Drop those teams.
//   2. Freshness — ignore any market snapshot older than 48h so a frozen/delisted
//      price can't drive the board; the team falls back to its (near-zero) sim.
// Alive teams during the tournament re-price well inside 48h, so neither gate
// ever false-drops a live contender.
const CHAMPION_STALE_SEC = 48 * 3600; // 172800 — market snapshots older than this are frozen/delisted

const state = {
  runs: 0,
  lastRunAt: null,
  lastError: null,
  lastErrorAt: null,
  worldCup2026: { teams: 0, source: null },
  wcMispricings: { cards: 0, strong: 0 },
};

// ── world-cup-2026 ──────────────────────────────────────────────────────

// Display precedence for the champion-row payload only — Kalshi if it has
// any volume, else Polymarket if any volume. DraftKings is intentionally NOT
// a source here: it's sportsbook data (off-brand for a prediction-markets
// widget per CLAUDE.md) and its implied outright probabilities were dominating
// the probability sort, surfacing non-contenders (e.g. Scotland at ~50%) above
// real Kalshi favourites. Callers pre-filter `rows` to Kalshi/Polymarket only,
// so any DraftKings row never reaches this function — kept defensive anyway.
// More permissive than the mispricing engine's selectDisplayPlatform() because
// pre-tournament champion outright Kalshi books may have low volume but still
// represent the market.
function pickChampionRow(rows) {
  if (!rows || rows.length === 0) return null;
  const k = rows.find((r) => r.platform === 'kalshi');
  if (k && Number(k.volume_24h ?? 0) > 0) return k;
  const p = rows.find((r) => r.platform === 'polymarket');
  if (p && Number(p.volume_24h ?? 0) > 0) return p;
  // No platform has volume — fall back to whichever Kalshi/Poly row exists
  // so the team still appears (probability > 0). Keeps pre-tournament
  // skeleton data on screen until volume arrives.
  return k || p || null;
}

function teamSlugFromEntity(entityId) {
  if (!entityId || typeof entityId !== 'string') return null;
  if (!entityId.startsWith('team:')) return null;
  return entityId.slice(5);
}

// Build the world-cup-2026 envelope from sim_latest (display name source) and
// market_latest (champion price + volume per platform).
export function buildWorldCup2026Envelope({ simRows, marketRows }) {
  const championMarketByTeam = new Map();
  for (const row of marketRows) {
    if (row.kind !== 'champion') continue;
    const slug = teamSlugFromEntity(row.entity_id);
    if (!slug) continue;
    const arr = championMarketByTeam.get(slug) || [];
    arr.push(row);
    championMarketByTeam.set(slug, arr);
  }

  // Use sim rows (entity_id LIKE 'team:%' AND kind='champion') to seed the
  // team list — gives us every WC participant even if their market hasn't
  // priced yet. Sim rows always exist post-PR2.
  const simChampions = simRows.filter(
    (r) => r.kind === 'champion' && typeof r.entity_id === 'string' && r.entity_id.startsWith('team:'),
  );

  const _raw = [];
  const teams = [];

  for (const sim of simChampions) {
    const slug = teamSlugFromEntity(sim.entity_id);
    if (!slug) continue;
    const team = lookupTeamBySlug(slug);
    const displayName = team?.name || slug;

    // Alive-set gate: the standings-aware sim scores an eliminated team at
    // exactly 0% champion. Drop them so a frozen/delisted market price can't
    // float a knocked-out team onto the board (see CHAMPION_STALE_SEC note).
    const simPctRaw = Number(sim.sim_pct);
    if (Number.isFinite(simPctRaw) && simPctRaw <= 0) continue;

    // Kalshi-first, Polymarket fallback. DraftKings sportsbook outrights are
    // dropped before they reach the display payload or the _raw array — they
    // are off-brand for a prediction-markets widget and their probabilities
    // were polluting the champion leaderboard (see pickChampionRow note).
    // Freshness gate: drop snapshots older than 48h so a frozen/delisted price
    // never drives the row — the team falls back to its sim probability instead.
    const platformRows = (championMarketByTeam.get(slug) || []).filter(
      (r) =>
        (r.platform === 'kalshi' || r.platform === 'polymarket') &&
        // Missing age → treat as fresh (keep); only an explicit stale age drops
        // the row. The alive-set (sim=0) gate above is the primary eliminated guard.
        Number(r.as_of_age_seconds ?? 0) < CHAMPION_STALE_SEC,
    );
    const pick = pickChampionRow(platformRows);

    let probability;
    let source;
    let url;
    let volume24h;

    if (pick) {
      const cents = Number(pick.yes_price_cents);
      probability = Number.isFinite(cents) ? Math.max(0.001, Math.min(0.999, cents / 100)) : null;
      source = pick.platform;
      url = pick.url || null;
      volume24h = pick.volume_24h != null ? Math.round(Number(pick.volume_24h)) : null;
    } else {
      // No fresh market row — fall back to sim probability so the team still
      // appears in the list with a sensible ordering, marked as `sim` source.
      probability = Number.isFinite(simPctRaw) ? Math.max(0.001, Math.min(0.999, simPctRaw / 100)) : null;
      source = 'sim';
      url = null;
      volume24h = null;
    }

    if (probability == null) continue;

    teams.push({
      outcome: displayName,
      probability,
      volume24h,
      source,
      url,
    });

    // Also emit per-platform _raw rows for getWCPredictionMarketOdds dedup
    // (it reads `_raw` and dedupes by outcome name to honour
    // its own platform-precedence policy).
    if (platformRows.length > 0) {
      for (const r of platformRows) {
        const cents = Number(r.yes_price_cents);
        if (!Number.isFinite(cents)) continue;
        _raw.push({
          outcome: displayName,
          probability: Math.max(0.001, Math.min(0.999, cents / 100)),
          source: r.platform,
          snapshot_at: r.snapshot_at,
          volume_24h: r.volume_24h != null ? Math.round(Number(r.volume_24h)) : null,
          url: r.url || null,
        });
      }
    }
  }

  teams.sort((a, b) => b.probability - a.probability);
  const top = teams.slice(0, WORLD_CUP_2026_TOP_N);

  const snapshotAt = new Date().toISOString();
  return {
    as_of: snapshotAt,
    stale: top.length === 0,
    data: {
      teams: top,
      topTeam: top[0] || null,
      snapshotAt,
      _raw,
    },
  };
}

// ── wc-mispricings ──────────────────────────────────────────────────────

const KIND_LABELS = {
  champion: 'Champion',
  advance: 'Advance from Group',
  group_winner: 'Group Winner',
  match_winner_home: 'Match Winner (Home)',
  match_winner_draw: 'Match Winner (Draw)',
  match_winner_away: 'Match Winner (Away)',
  match_o25: 'Over 2.5 Goals',
  match_btts: 'Both Teams to Score',
  reach_r16: 'Reach Round of 16',
  reach_qf: 'Reach Quarter-Final',
  reach_sf: 'Reach Semi-Final',
  reach_final: 'Reach Final',
  golden_boot: 'Golden Boot',
  player_anytime_scorer: 'Anytime Scorer',
};

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind;
}

// Same shape as wc-mispricings.js prettyEntity but kept local so the payload
// builder doesn't import the alert path (avoids a circular dep if either
// module grows).
export function entityLabel(entityId) {
  if (!entityId) return '';
  if (entityId.startsWith('team:')) {
    const slug = entityId.slice(5);
    return lookupTeamBySlug(slug)?.name || slug;
  }
  if (entityId.startsWith('match:')) {
    const m = entityId.slice(6).match(/^([A-L])-MD([1-3])-([A-Z]{3})-([A-Z]{3})$/);
    if (!m) return entityId;
    const [, , md, h, a] = m;
    const home = lookupTeamByCode(h)?.name || h;
    const away = lookupTeamByCode(a)?.name || a;
    return `${home} vs ${away} (MD${md})`;
  }
  if (entityId.startsWith('player:')) {
    return entityId
      .slice(7)
      .split('-')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' ');
  }
  return entityId;
}

export function buildWcMispricingsEnvelope({ rows }) {
  const cards = (rows || []).map((r) => ({
    entity_id: r.entity_id,
    entity_label: entityLabel(r.entity_id),
    kind: r.kind,
    kind_label: kindLabel(r.kind),
    display_platform: r.display_platform,
    sim_pct: Number(r.sim_pct),
    market_pct: Number(r.market_pct),
    edge_pp: Number(r.edge_pp),
    tier: r.tier,
    market_volume_24h: r.market_volume_24h != null ? Number(r.market_volume_24h) : null,
    computed_at: r.computed_at,
  }));

  const snapshotAt = new Date().toISOString();
  return {
    as_of: snapshotAt,
    stale: cards.length === 0,
    data: {
      cards,
      strong_count: cards.length,
    },
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────

export async function runWcPayloadsOnce() {
  state.runs += 1;
  state.lastRunAt = new Date().toISOString();

  let simRows;
  let marketRows;
  let mispricingRows;
  try {
    [simRows, marketRows, mispricingRows] = await Promise.all([
      fetchWcSimulationLatest(),
      fetchWcMarketLatest(),
      fetchWcMispricingsLatest({ tier: 'STRONG', limit: WC_MISPRICINGS_TOP_N }),
    ]);
  } catch (err) {
    state.lastError = (err?.message || String(err)).slice(0, 240);
    state.lastErrorAt = new Date().toISOString();
    console.error('[wc-payloads] read failed:', state.lastError);
    return { ok: false, error: state.lastError };
  }

  const wc2026 = buildWorldCup2026Envelope({ simRows, marketRows });
  const mispricings = buildWcMispricingsEnvelope({ rows: mispricingRows });

  const results = await Promise.allSettled([
    upsertWidgetPayloads('world-cup-2026', wc2026, WORLD_CUP_2026_VARIANTS),
    upsertWidgetPayloads('wc-mispricings', mispricings, WC_MISPRICINGS_VARIANTS),
  ]);

  let writes = 0;
  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled') {
      writes += r.value.count;
    } else {
      const slug = i === 0 ? 'world-cup-2026' : 'wc-mispricings';
      console.error(`[wc-payloads] ${slug} upsert failed:`, r.reason?.message || r.reason);
      state.lastError = (r.reason?.message || String(r.reason)).slice(0, 240);
      state.lastErrorAt = new Date().toISOString();
    }
  }

  state.worldCup2026 = {
    teams: wc2026.data.teams.length,
    source: wc2026.data.topTeam?.source ?? null,
  };
  state.wcMispricings = {
    cards: mispricings.data.cards.length,
    strong: mispricings.data.strong_count,
  };

  recordTick('wc_payloads');
  console.log(
    `[wc-payloads] writes=${writes} world-cup-2026 teams=${state.worldCup2026.teams} top=${wc2026.data.topTeam?.outcome ?? 'n/a'} mispricings=${state.wcMispricings.cards}`,
  );
  return {
    ok: true,
    writes,
    worldCup2026: state.worldCup2026,
    wcMispricings: state.wcMispricings,
  };
}

export function getWcPayloadsState() {
  return {
    runs: state.runs,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    worldCup2026: state.worldCup2026,
    wcMispricings: state.wcMispricings,
  };
}

// Test-only export.
export const __test__ = {
  buildWorldCup2026Envelope,
  buildWcMispricingsEnvelope,
  entityLabel,
  kindLabel,
  pickChampionRow,
};
