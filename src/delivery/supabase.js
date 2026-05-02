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

// Write feed_performance rows for backtest scoring. feed_type chosen by caller
// ('market_movers', 'commodity_edge'). Errors are logged but not thrown — a
// missed performance row doesn't block the user-facing Discord post.
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
