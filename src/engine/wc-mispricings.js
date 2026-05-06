// World Cup 2026 mispricing engine.
//
// Runs immediately after each wc-snapshot tick (30min). For every (entity_id,
// kind) where we have both a sim probability and at least one fresh market
// quote, we:
//   1. pick the display platform (Kalshi-first per CLAUDE.md / PR 3 spec)
//   2. compute edge_pp = sim_pct - market_pct
//   3. tier the absolute edge (STRONG ≥8pp / MODERATE ≥5pp / SPEC ≥3pp)
//   4. drop edges in dead markets (volume_24h < ALERT_MIN_VOL_24H)
//   5. insert into world_cup_mispricings (append; no upsert — every tick is a
//      distinct detection event, the _latest matview collapses by entity+kind)
//   6. for STRONG/MODERATE rows, post Discord (with WRITER_TAG gating +
//      posted_alerts 6h dedup) and write feed_performance
//
// Same WRITER_TAG / posted_alerts / feed_performance pattern as commodity-edge
// and movers in src/index.js — kept inline here so the WC orchestrator owns
// the full chain (snapshot → matview refresh → mispricing → discord) end to
// end without index.js having to know about WC internals.

import {
  getClient,
  filterAlreadyPostedKeys,
  recordPostedAlerts,
  recordFeedPerformance,
  insertWcMispricings,
  refreshWcMarketMatviews,
  fetchWcSimulationLatest,
  fetchWcMarketLatest,
} from '../delivery/supabase.js';
import { postWcMispricingAlert } from '../delivery/wc-discord.js';
import { lookupTeamBySlug } from '../feeds/wc-shared.js';
import { recordTick } from '../observability/health.js';

// Tier thresholds (mirror Weather Edge / commodity edge convention but tuned
// for tournament markets: long-tail outright probabilities are noisier than
// commodity options-implied probs, so the ladder is 8/5/3 instead of 12/8).
export const TIER_STRONG_PP = 8.0;
export const TIER_MODERATE_PP = 5.0;
export const TIER_SPEC_PP = 3.0;

// Liquidity gate — anything below this on the chosen display platform is
// suppressed. Stale 24h volume on Kalshi ghost markets (KXMVE-style) was the
// noise source the watchlist filter caught for movers; same idea here.
export const ALERT_MIN_VOL_24H = 250;

// Display precedence (Kalshi-first per CLAUDE.md May 2 update + PR 3 spec).
// Reads the array of latest rows for a single (entity_id, kind) across all
// platforms and picks one — null means "no row to display".
export const KALSHI_MIN_VOL = 100;
export const POLY_MIN_VOL = 500;
export const STALE_LIVE_SEC = 1800; // 30 min
export const STALE_DK_SEC = 86400; // 24 hr (Odds API quota)

const DISCORD_COOLDOWN_HOURS = 6;

const state = {
  runs: 0,
  lastRunAt: null,
  lastError: null,
  lastErrorAt: null,
  rowsWritten: 0,
  rowsAlerted: 0,
  rowsSuppressed: 0,
  perTier: { STRONG: 0, MODERATE: 0, SPECULATIVE: 0 },
};

export function selectDisplayPlatform(latestRows) {
  if (!Array.isArray(latestRows) || latestRows.length === 0) return null;
  const byPlatform = Object.fromEntries(latestRows.map((r) => [r.platform, r]));

  const k = byPlatform.kalshi;
  if (
    k &&
    Number(k.volume_24h ?? 0) >= KALSHI_MIN_VOL &&
    Number(k.as_of_age_seconds ?? Infinity) < STALE_LIVE_SEC
  ) {
    return { platform: 'kalshi', row: k };
  }
  const p = byPlatform.polymarket;
  if (
    p &&
    Number(p.volume_24h ?? 0) >= POLY_MIN_VOL &&
    Number(p.as_of_age_seconds ?? Infinity) < STALE_LIVE_SEC
  ) {
    return { platform: 'polymarket', row: p };
  }
  const d = byPlatform.draftkings;
  if (d && Number(d.as_of_age_seconds ?? Infinity) < STALE_DK_SEC) {
    return { platform: 'draftkings', row: d };
  }
  return null;
}

export function tierFor(absEdgePp) {
  if (!Number.isFinite(absEdgePp)) return null;
  if (absEdgePp >= TIER_STRONG_PP) return 'STRONG';
  if (absEdgePp >= TIER_MODERATE_PP) return 'MODERATE';
  if (absEdgePp >= TIER_SPEC_PP) return 'SPECULATIVE';
  return null;
}

// Pure: given a sim row + a chosen market row, return a mispricing row or null.
// Returns null when no tier fires or when liquidity is below the alert gate.
// Liquidity gate only suppresses the *write*; the matview consumer can still
// inspect the underlying snapshot if needed.
export function computeMispricing({ sim, marketPick }) {
  if (!sim || !marketPick) return null;
  const sim_pct = Number(sim.sim_pct);
  const market_pct = Number(marketPick.row.yes_price_cents);
  if (!Number.isFinite(sim_pct) || !Number.isFinite(market_pct)) return null;
  const edge_pp = Number((sim_pct - market_pct).toFixed(2));
  const abs = Math.abs(edge_pp);
  const tier = tierFor(abs);
  if (!tier) return null;

  const volume_24h = Number(marketPick.row.volume_24h ?? 0);
  if (volume_24h < ALERT_MIN_VOL_24H) return null;

  return {
    entity_id: sim.entity_id,
    kind: sim.kind,
    display_platform: marketPick.platform,
    sim_pct,
    market_pct,
    edge_pp,
    tier,
    market_volume_24h: volume_24h,
    metadata: {
      sim_run_id: sim.sim_run_id,
      sim_ran_at: sim.sim_ran_at,
      market_ticker_or_id: marketPick.row.ticker_or_id,
      market_url: marketPick.row.url,
      market_snapshot_at: marketPick.row.snapshot_at,
    },
  };
}

// Group market rows by (entity_id, kind) so selectDisplayPlatform sees the
// full per-(entity, kind) cross-platform set.
function groupMarketRows(marketRows) {
  const byKey = new Map();
  for (const row of marketRows) {
    const key = `${row.entity_id}|${row.kind}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  return byKey;
}

export function wcMispricingAlertKey(row) {
  const direction = row.edge_pp >= 0 ? 'positive' : 'negative';
  return `wc_mispricing:${row.entity_id}:${row.kind}:${row.tier}:${direction}`;
}

// Pretty entity for Discord title — turns 'team:france' into 'France' and
// 'match:I-MD1-FRA-SEN' into 'France vs Senegal'. Falls back to the raw id
// when a team isn't recognized; never throws.
export function prettyEntity(entityId) {
  if (!entityId) return '';
  if (entityId.startsWith('team:')) {
    const slug = entityId.slice(5);
    const t = lookupTeamBySlug(slug);
    return t?.name || slug;
  }
  if (entityId.startsWith('match:')) {
    const m = entityId.slice(6).match(/^([A-L])-MD([1-3])-([A-Z]{3})-([A-Z]{3})$/);
    if (!m) return entityId;
    const [, , md, h, a] = m;
    const home = lookupTeamFromCode(h);
    const away = lookupTeamFromCode(a);
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

function lookupTeamFromCode(code) {
  // Inline reverse — wc-shared exports lookupTeamByCode but we keep this
  // helper local to avoid a circular reference if shared/internal change.
  const slug = CODE_TO_SLUG[code];
  return slug ? lookupTeamBySlug(slug)?.name || slug : code;
}

const CODE_TO_SLUG = {
  MEX: 'mexico', KOR: 'korea-republic', RSA: 'south-africa', CZE: 'czechia',
  CAN: 'canada', SUI: 'switzerland', QAT: 'qatar', BIH: 'bosnia',
  BRA: 'brazil', MOR: 'morocco', SCO: 'scotland', HAI: 'haiti',
  USA: 'united-states', PAR: 'paraguay', AUS: 'australia', TUR: 'turkiye',
  GER: 'germany', CIV: 'cote-divoire', ECU: 'ecuador', CUW: 'curacao',
  NED: 'netherlands', JPN: 'japan', TUN: 'tunisia', SWE: 'sweden',
  BEL: 'belgium', IRN: 'iran', EGY: 'egypt', NZL: 'new-zealand',
  ESP: 'spain', URU: 'uruguay', KSA: 'saudi-arabia', CPV: 'cape-verde',
  FRA: 'france', SEN: 'senegal', NOR: 'norway', IRQ: 'iraq',
  ARG: 'argentina', AUT: 'austria', ALG: 'algeria', JOR: 'jordan',
  POR: 'portugal', COL: 'colombia', UZB: 'uzbekistan', COD: 'dr-congo',
  ENG: 'england', CRO: 'croatia', GHA: 'ghana', PAN: 'panama',
};

// Returns ALL mispricing rows (any tier) computed from the latest sim ×
// market snapshot. The orchestrator separately decides which to alert on.
export function computeAllMispricings({ simRows, marketRows }) {
  const simByKey = new Map();
  for (const s of simRows) simByKey.set(`${s.entity_id}|${s.kind}`, s);
  const grouped = groupMarketRows(marketRows);

  const out = [];
  for (const [key, rows] of grouped) {
    const sim = simByKey.get(key);
    if (!sim) continue;
    const pick = selectDisplayPlatform(rows);
    if (!pick) continue;
    const row = computeMispricing({ sim, marketPick: pick });
    if (row) out.push(row);
  }
  return out;
}

export async function runWcMispricingsOnce() {
  state.runs += 1;
  state.lastRunAt = new Date().toISOString();

  let simRows;
  let marketRows;
  try {
    [simRows, marketRows] = await Promise.all([
      fetchWcSimulationLatest(),
      fetchWcMarketLatest(),
    ]);
  } catch (err) {
    state.lastError = (err?.message || String(err)).slice(0, 240);
    state.lastErrorAt = new Date().toISOString();
    console.error('[wc-mispricings] read failed:', state.lastError);
    return { rowsWritten: 0, rowsAlerted: 0, error: state.lastError };
  }

  if (simRows.length === 0 || marketRows.length === 0) {
    console.log(
      `[wc-mispricings] skipped — sim=${simRows.length} market=${marketRows.length}`,
    );
    recordTick('wc_mispricings');
    return { rowsWritten: 0, rowsAlerted: 0 };
  }

  const rows = computeAllMispricings({ simRows, marketRows });

  if (rows.length === 0) {
    console.log(`[wc-mispricings] no mispricings (sim=${simRows.length} market=${marketRows.length})`);
    recordTick('wc_mispricings');
    return { rowsWritten: 0, rowsAlerted: 0 };
  }

  let written = 0;
  try {
    const { count } = await insertWcMispricings(rows);
    written = count;
    state.rowsWritten += count;
  } catch (err) {
    state.lastError = (err?.message || String(err)).slice(0, 240);
    state.lastErrorAt = new Date().toISOString();
    console.error('[wc-mispricings] insert failed:', state.lastError);
    return { rowsWritten: 0, rowsAlerted: 0, error: state.lastError };
  }

  // Refresh _latest matview so /world-cup hub reads the fresh row immediately.
  // Refresh failure is non-fatal — next tick retries.
  try {
    await refreshWcMarketMatviews();
  } catch (err) {
    console.warn('[wc-mispricings] matview refresh failed:', err?.message || err);
  }

  // Tier-tally for /health visibility.
  for (const r of rows) state.perTier[r.tier] = (state.perTier[r.tier] || 0) + 1;

  // Alert candidates = STRONG + MODERATE only (SPEC is silent).
  const alertCandidates = rows.filter((r) => r.tier === 'STRONG' || r.tier === 'MODERATE');
  const tag = process.env.WRITER_TAG || 'delayed_test';

  if (alertCandidates.length === 0) {
    recordTick('wc_mispricings');
    console.log(
      `[wc-mispricings] wrote ${written} rows tag=${tag} STRONG=${state.perTier.STRONG} MODERATE=${state.perTier.MODERATE} SPEC=${state.perTier.SPECULATIVE} alerted=0`,
    );
    return { rowsWritten: written, rowsAlerted: 0 };
  }

  if (tag === 'delayed_test') {
    console.log(
      `[wc-mispricings] would post ${alertCandidates.length} (gated by writer_tag=${tag})`,
    );
    recordTick('wc_mispricings');
    return { rowsWritten: written, rowsAlerted: 0, gated: true };
  }

  // Dedup against posted_alerts (6h cooldown, keyed by entity+kind+tier+direction).
  const keys = alertCandidates.map(wcMispricingAlertKey);
  const suppressed = await filterAlreadyPostedKeys(keys, { hoursWindow: DISCORD_COOLDOWN_HOURS });
  state.rowsSuppressed += suppressed.size;
  const toPost = alertCandidates.filter((r) => !suppressed.has(wcMispricingAlertKey(r)));

  if (toPost.length === 0) {
    recordTick('wc_mispricings');
    console.log(
      `[wc-mispricings] all ${alertCandidates.length} suppressed by 6h cooldown`,
    );
    return { rowsWritten: written, rowsAlerted: 0 };
  }

  const postedRows = [];
  for (const r of toPost) {
    try {
      const sent = await postWcMispricingAlert(r);
      if (sent) {
        postedRows.push(r);
        state.rowsAlerted += 1;
      }
    } catch (err) {
      console.error('[wc-mispricings] discord post failed', err?.message || err);
    }
  }

  if (postedRows.length > 0) {
    const now = new Date().toISOString();
    await recordPostedAlerts(
      postedRows.map((r) => ({
        alert_key: wcMispricingAlertKey(r),
        title: `WC ${prettyEntity(r.entity_id)} ${r.kind} ${r.tier} ${r.edge_pp >= 0 ? '+' : ''}${r.edge_pp}pp`.slice(0, 200),
        alert_type: 'world_cup',
        platform: 'kalshi',
        posted_at: now,
      })),
    );
    await recordFeedPerformance(
      postedRows.map((r) => ({
        feed_type: 'world_cup',
        alert_id: wcMispricingAlertKey(r),
        platform: r.display_platform,
        market_id: r.metadata?.market_ticker_or_id || null,
        confidence_tier: r.tier === 'STRONG' ? 3 : r.tier === 'MODERATE' ? 2 : 1,
        direction: r.edge_pp >= 0 ? 'yes' : 'no',
        alert_price: Math.round(r.market_pct),
        alert_edge_pp: Math.abs(r.edge_pp),
      })),
    );
  }

  recordTick('wc_mispricings');
  console.log(
    `[wc-mispricings] wrote ${written} rows alerted ${postedRows.length}/${alertCandidates.length} STRONG=${state.perTier.STRONG} MODERATE=${state.perTier.MODERATE} SPEC=${state.perTier.SPECULATIVE} tag=${tag}`,
  );
  return { rowsWritten: written, rowsAlerted: postedRows.length };
}

export function getWcMispricingsState() {
  return {
    runs: state.runs,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    rowsWritten: state.rowsWritten,
    rowsAlerted: state.rowsAlerted,
    rowsSuppressed: state.rowsSuppressed,
    perTier: { ...state.perTier },
  };
}

// Test-only export — pure helpers grouped for vitest visibility.
export const __test__ = {
  selectDisplayPlatform,
  computeMispricing,
  computeAllMispricings,
  tierFor,
  prettyEntity,
  wcMispricingAlertKey,
  groupMarketRows,
};
