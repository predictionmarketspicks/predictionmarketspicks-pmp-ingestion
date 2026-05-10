// Supabase writer — single source of upserts into commodity_edge_signals.
// Uses the service role key (RLS bypass) — engine writes only, never reads
// production user data through this client.
//
// Bridge week: WRITER_TAG=delayed_test gates rows out of front-end reads.
// Mon/Tue Massive Advanced cutover = flip env var to 'intraday'. Zero code change.

import { createClient } from '@supabase/supabase-js';

let _client = null;

export function getClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'X-Pmp-Engine': 'pmp-ingestion' } },
  });
  return _client;
}

function writerTag() {
  const t = process.env.WRITER_TAG || 'delayed_test';
  if (!['daily', 'intraday', 'delayed_test'].includes(t)) {
    throw new Error(`invalid WRITER_TAG: ${t}`);
  }
  return t;
}

// Upsert all rows in one batch. Conflict on the table's UNIQUE
// (commodity, snapshot_date, event_ticker, strike). snapshot_date is generated
// from snapshot_at server-side. Intraday writes during the same UTC day update
// the row in place rather than appending.
export async function upsertCommodityEdgeRows(rows) {
  if (!rows || rows.length === 0) return { count: 0 };
  const tag = writerTag();
  const stamped = rows.map((r) => ({ ...r, snapshot_type: tag }));
  const sb = getClient();
  const { data, error } = await sb
    .from('commodity_edge_signals')
    .upsert(stamped, { onConflict: 'commodity,snapshot_date,event_ticker,strike' })
    .select('id');
  if (error) throw new Error(`commodity_edge_signals upsert: ${error.message}`);
  return { count: data?.length ?? 0, tag };
}

// Daily dealer-gamma snapshot. UNIQUE (commodity, snapshot_date) — intraday
// ticks during the same UTC day update the row in place; tomorrow gets a new
// one. Failures are logged, not thrown — gamma is a secondary signal and a
// missed write must never block the primary edge upsert.
//
// snapshot_date defaults to today UTC. spot_price + gamma_neutral_price are
// in the underlying ETF's units (SLV/GLD/USO), matching legacy behavior so
// the readers in lib/tools/gamma-snapshot.ts don't need a units update.
export async function upsertGammaSnapshot({
  commodity,
  etfSpot,
  netDealerGamma,
  gammaNeutralPrice,
  gammaEnvironment,
  signalModifier,
  snapshotDate,
}) {
  if (!commodity || !(etfSpot > 0)) return { ok: false, reason: 'invalid_input' };
  const date = snapshotDate || new Date().toISOString().slice(0, 10);
  const sb = getClient();
  const { error } = await sb
    .from('commodity_gamma_snapshots')
    .upsert(
      {
        commodity,
        snapshot_date: date,
        spot_price: etfSpot,
        net_dealer_gamma: netDealerGamma,
        gamma_neutral_price: gammaNeutralPrice,
        gamma_environment: gammaEnvironment,
        signal_modifier: signalModifier,
      },
      { onConflict: 'commodity,snapshot_date' },
    );
  if (error) {
    console.error(`[commodity_gamma_snapshots] upsert failed for ${commodity}: ${error.message}`);
    return { ok: false, reason: error.message };
  }
  return { ok: true, date };
}

// Phase 2B: insert arb alert rows into arb_alerts. Append-only — each row is a
// distinct detection event. Cleanup is handled by the cron job that drops rows
// older than 7 days. Bridge-week safety: rows still write under writer_tag=
// delayed_test (cheap historical record), but the Pro dashboard reads via
// Realtime and the <ArbAlerts /> component is feature-flagged off until the
// engine stabilizes.
export async function insertArbAlerts(rows) {
  if (!rows || rows.length === 0) return { count: 0 };
  const sb = getClient();
  const { data, error } = await sb.from('arb_alerts').insert(rows).select('id');
  if (error) throw new Error(`arb_alerts insert: ${error.message}`);
  return { count: data?.length ?? 0 };
}

// ---------- posted_alerts (Phase 3) ----------
//
// Cross-scanner dedup. Engine + Edge Functions all write the same alert_keys,
// so posted_alerts is the canonical "did we already alert on this in the last
// N hours?" check. 24h cooldown for movers (matches the Edge Function it
// replaces); 6h cooldown for commodity edges (matches the commodity-edge cron
// cadence).
//
// On dedup-query failure we fall through to "post unfiltered" — a noisy
// re-alert is less harmful than missing one entirely if posted_alerts itself
// goes down.

export async function filterAlreadyPostedKeys(alertKeys, { hoursWindow = 24 } = {}) {
  if (!alertKeys || alertKeys.length === 0) return new Set();
  const sb = getClient();
  const cutoff = new Date(Date.now() - hoursWindow * 3600_000).toISOString();
  const { data, error } = await sb
    .from('posted_alerts')
    .select('alert_key')
    .in('alert_key', alertKeys)
    .gte('posted_at', cutoff);
  if (error) {
    console.warn('[posted_alerts] dedup query failed, posting unfiltered:', error.message);
    return new Set();
  }
  return new Set((data ?? []).map((r) => r.alert_key));
}

// Upsert posted-alert rows. onConflict on alert_key — same key + a fresh
// posted_at extends the cooldown window, which is the desired behavior.
export async function recordPostedAlerts(rows) {
  if (!rows || rows.length === 0) return { count: 0 };
  const sb = getClient();
  const { error } = await sb
    .from('posted_alerts')
    .upsert(rows, { onConflict: 'alert_key' });
  if (error) {
    console.error('[posted_alerts] upsert failed:', error.message);
    return { count: 0 };
  }
  return { count: rows.length };
}

// ---------- macro_market_snapshots (Session 2) ----------
//
// Append-only time series of Kalshi macro markets. One row per (ticker,
// snapshot_at). The table's UNIQUE index on (ticker, snapshot_at) collapses
// retries that land on the same instant, so we use upsert + ignoreDuplicates
// to make the write idempotent at the millisecond.
//
// Failures throw — the engine logs and moves on. Loss of a single 5min
// snapshot is acceptable; the next tick fills in.
export async function insertMacroSnapshots(rows, { snapshotAt } = {}) {
  if (!rows || rows.length === 0) return { count: 0 };
  const stamp = snapshotAt || new Date().toISOString();
  const stamped = rows.map((r) => ({ ...r, snapshot_at: stamp }));
  const sb = getClient();
  const { data, error } = await sb
    .from('macro_market_snapshots')
    .upsert(stamped, { onConflict: 'ticker,snapshot_at', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`macro_market_snapshots upsert: ${error.message}`);
  return { count: data?.length ?? 0 };
}

// ---------- kalshi_gas_strikes (Oracle Gas Edge) ----------
//
// Append-only time series of Kalshi gas markets (KXAAAGASD daily +
// KXAAAGASM monthly). Sibling to macro_market_snapshots — same shape, same
// failure model. The table has a UNIQUE index on (ticker, captured_at), so
// upsert + ignoreDuplicates makes the write idempotent at the millisecond.
//
// Failures throw — engine logs and the next 5min/15min tick retries; a missed
// snapshot is acceptable. The /tools/oracle-gas dashboard tolerates a 30min
// gap before showing a stale-data warning.
export async function insertKalshiGasStrikes(rows) {
  if (!rows || rows.length === 0) return { count: 0 };
  const sb = getClient();
  const { data, error } = await sb
    .from('kalshi_gas_strikes')
    .upsert(rows, { onConflict: 'ticker,captured_at', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`kalshi_gas_strikes upsert: ${error.message}`);
  return { count: data?.length ?? 0 };
}

// ---------- polymarket_market_snapshots (Polymarket Session A) ----------
//
// Append-only time series of Polymarket Gamma markets. Sibling to
// macro_market_snapshots — same shape (one row per scan, batch upsert), same
// failure model (throw on insert error so the engine logs and the next tick
// retries; a missed 5min snapshot is acceptable).
//
// onConflict on (condition_id, snapshot_at) collapses retries that land on the
// same instant — ignoreDuplicates lets the writer be idempotent at the ms.
export async function insertPolymarketSnapshots(rows, { snapshotAt } = {}) {
  if (!rows || rows.length === 0) return { count: 0 };
  const stamp = snapshotAt || new Date().toISOString();
  const stamped = rows.map((r) => ({ ...r, snapshot_at: stamp }));
  const sb = getClient();
  const { data, error } = await sb
    .from('polymarket_market_snapshots')
    .upsert(stamped, { onConflict: 'condition_id,snapshot_at', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`polymarket_market_snapshots upsert: ${error.message}`);
  return { count: data?.length ?? 0 };
}

// ---------- world_cup_market_snapshot (WC PR 3) ----------
//
// Append-only time series of WC market quotes from kalshi/polymarket/
// draftkings (DK consensus via The Odds API). One row per (entity_id, kind,
// platform) per scan. Engine runs every 30min; the table has no UNIQUE
// constraint, so plain insert (not upsert). 30-day retention is enforced by
// pg_cron jobid 75 (created in PR 1).
//
// Failures throw so the engine logs and the next 30min tick retries; a
// missed snapshot is acceptable.
export async function insertWorldCupMarketSnapshots(rows, { snapshotAt } = {}) {
  if (!rows || rows.length === 0) return { count: 0 };
  const stamp = snapshotAt || new Date().toISOString();
  const stamped = rows.map((r) => ({ ...r, snapshot_at: stamp }));
  const sb = getClient();
  const { data, error } = await sb
    .from('world_cup_market_snapshot')
    .insert(stamped)
    .select('id');
  if (error) throw new Error(`world_cup_market_snapshot insert: ${error.message}`);
  return { count: data?.length ?? 0 };
}

// ---------- world_cup_simulation_latest / world_cup_market_latest reads (PR 4) ----------
//
// PR 4 mispricing engine joins these two matviews. Both are kept fresh by
// upstream writers: the nightly Python sim refreshes simulation_latest via
// refresh_world_cup_latest_matviews(); the Fly engine refreshes market_latest
// + mispricings_latest via refresh_world_cup_market_matviews() (companion
// migration 20260506_wc_market_matview_refresh_rpc.sql).

export async function fetchWcSimulationLatest() {
  const sb = getClient();
  const { data, error } = await sb
    .from('world_cup_simulation_latest')
    .select('entity_id, kind, sim_run_id, sim_pct, sim_american_odds, sim_ran_at, metadata');
  if (error) throw new Error(`world_cup_simulation_latest read: ${error.message}`);
  return data || [];
}

export async function fetchWcMarketLatest() {
  const sb = getClient();
  const { data, error } = await sb
    .from('world_cup_market_latest')
    .select(
      'entity_id, kind, platform, ticker_or_id, yes_price_cents, volume_24h, price_change_24h_pp, liquidity, url, snapshot_at, as_of_age_seconds',
    );
  if (error) throw new Error(`world_cup_market_latest read: ${error.message}`);
  return data || [];
}

// Append-only insert into world_cup_mispricings. One row per (entity, kind,
// computed_at) — every tick is a distinct detection event. _latest matview
// collapses by (entity_id, kind). 30-day TTL via pg_cron jobid created in
// PR 1 schema migration.
//
// Failures throw — engine logs and skips the Discord/feed_performance side
// effects so we don't double-post on a retry that succeeds writing later.
export async function insertWcMispricings(rows) {
  if (!rows || rows.length === 0) return { count: 0 };
  const sb = getClient();
  const { data, error } = await sb
    .from('world_cup_mispricings')
    .insert(rows)
    .select('id');
  if (error) throw new Error(`world_cup_mispricings insert: ${error.message}`);
  return { count: data?.length ?? 0 };
}

// Refresh world_cup_market_latest + world_cup_mispricings_latest via the
// security-definer RPC (companion migration). Sim-side matviews are owned by
// the nightly Python sim and not touched here.
export async function refreshWcMarketMatviews() {
  const sb = getClient();
  const { error } = await sb.rpc('refresh_world_cup_market_matviews');
  if (error) throw new Error(`refresh_world_cup_market_matviews: ${error.message}`);
  return { ok: true };
}

// Read top-N from world_cup_mispricings_latest, optionally filtered by tier
// and ordered by abs_edge_pp desc. PR 5 widget payload writer reads
// tier='STRONG' limit=5.
export async function fetchWcMispricingsLatest({ tier, limit = 5 } = {}) {
  const sb = getClient();
  let q = sb
    .from('world_cup_mispricings_latest')
    .select(
      'entity_id, kind, display_platform, sim_pct, market_pct, edge_pp, abs_edge_pp, tier, market_volume_24h, computed_at, metadata',
    )
    .order('abs_edge_pp', { ascending: false })
    .limit(limit);
  if (tier) q = q.eq('tier', tier);
  const { data, error } = await q;
  if (error) throw new Error(`world_cup_mispricings_latest read: ${error.message}`);
  return data || [];
}

// Generic V2 widget_payloads upsert. Same envelope across the listed variants
// (the renderer differentiates via ctx.variant). Used by the WC payload writer
// (PR 5) and any future Fly-side V2 writer.
export async function upsertWidgetPayloads(slug, envelope, variants = ['hero', 'sidebar']) {
  if (!slug) throw new Error('widget_payloads: slug required');
  if (!envelope) throw new Error('widget_payloads: envelope required');
  const sb = getClient();
  const updated_at = new Date().toISOString();
  const rows = variants.map((variant) => ({
    widget_slug: slug,
    variant,
    payload: envelope,
    updated_at,
  }));
  const { error } = await sb
    .from('widget_payloads')
    .upsert(rows, { onConflict: 'widget_slug,variant' });
  if (error) throw new Error(`widget_payloads upsert ${slug}: ${error.message}`);
  return { count: rows.length };
}

// Write feed_performance rows for backtest scoring. feed_type chosen by caller
// ('market_movers', 'commodity_edge', 'world_cup'). Errors are logged but not
// thrown — a missed performance row doesn't block the user-facing Discord
// post.
export async function recordFeedPerformance(rows) {
  if (!rows || rows.length === 0) return { count: 0 };
  const sb = getClient();
  const { error } = await sb.from('feed_performance').insert(rows);
  if (error) {
    console.error('[feed_performance] insert failed:', error.message);
    return { count: 0 };
  }
  return { count: rows.length };
}
