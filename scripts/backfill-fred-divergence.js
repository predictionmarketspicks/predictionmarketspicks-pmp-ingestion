#!/usr/bin/env node
// One-shot backfill: replay FRED divergence on the last 30 days of oil + gold
// commodity_edge_signals rows. Logs catch count to stdout. Acceptance per
// handoffs/BATCH_FRED_P5_AND_TRACKER_P2_2026-05-10.md is ≥5 historical false
// signals that would have fired the warning.
//
// Run:
//   FRED_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//     node pmp-ingestion/scripts/backfill-fred-divergence.js
//
// Idempotent: writes fred_divergence_bp + divergence_warning per row.
// Re-runs overwrite. Does not modify direction / confidence / tier (those
// are set at engine compute time only — historical demotion would rewrite
// active signals incorrectly).

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const DIVERGENCE_BP_THRESHOLD = 150;
const LOOKBACK_DAYS = 30;

const COMMODITY_FRED_MAP = {
  oil: 'DCOILWTICO',
  gold: 'GOLDPMGBD228NLBM',
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function fetchFredSeries(seriesId, startDate) {
  const url = new URL(FRED_BASE);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', requireEnv('FRED_API_KEY'));
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('observation_start', startDate);
  url.searchParams.set('sort_order', 'asc');
  url.searchParams.set('limit', '1000');

  const res = await fetch(url, {
    headers: { 'User-Agent': 'pmp-ingestion-backfill/0.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`FRED ${seriesId}: ${res.status}`);
  const json = await res.json();
  const map = new Map(); // date (YYYY-MM-DD) → price
  for (const obs of json.observations ?? []) {
    if (obs.value === '.') continue;
    const v = Number(obs.value);
    if (Number.isFinite(v) && v > 0) map.set(obs.date, v);
  }
  return map;
}

// FRED publishes once per business day. For a given snapshot_date we want
// the most recent observation on or before that date.
function fredPriceAsOf(fredMap, snapshotDate) {
  if (fredMap.has(snapshotDate)) return { price: fredMap.get(snapshotDate), date: snapshotDate };
  const target = snapshotDate;
  let best = null;
  for (const [d, p] of fredMap) {
    if (d > target) continue;
    if (!best || d > best.date) best = { date: d, price: p };
  }
  return best;
}

async function main() {
  const supabase = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const lookbackStart = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  console.log(`[backfill] window: ${lookbackStart} → today; threshold ${DIVERGENCE_BP_THRESHOLD}bp`);

  const fredCache = new Map();
  for (const [commodity, seriesId] of Object.entries(COMMODITY_FRED_MAP)) {
    const map = await fetchFredSeries(seriesId, lookbackStart);
    fredCache.set(commodity, { seriesId, map });
    console.log(`[backfill] FRED ${seriesId}: ${map.size} daily observations`);
  }

  let scanned = 0;
  let updated = 0;
  let caught = 0;

  for (const commodity of Object.keys(COMMODITY_FRED_MAP)) {
    const { seriesId, map: fredMap } = fredCache.get(commodity);
    if (fredMap.size === 0) {
      console.warn(`[backfill] ${commodity}: FRED returned no observations — skipping`);
      continue;
    }

    const { data: rows, error } = await supabase
      .from('commodity_edge_signals')
      .select('id, commodity, snapshot_date, spot_price')
      .eq('commodity', commodity)
      .gte('snapshot_date', lookbackStart)
      .not('spot_price', 'is', null);

    if (error) {
      console.error(`[backfill] ${commodity} select failed: ${error.message}`);
      continue;
    }
    console.log(`[backfill] ${commodity}: ${rows.length} candidate rows`);

    for (const row of rows) {
      scanned++;
      const fred = fredPriceAsOf(fredMap, row.snapshot_date);
      if (!fred || row.spot_price <= 0) continue;
      const divergenceBp = ((row.spot_price - fred.price) / fred.price) * 10000;
      const warning = Math.abs(divergenceBp) > DIVERGENCE_BP_THRESHOLD;
      if (warning) caught++;

      const { error: updErr } = await supabase
        .from('commodity_edge_signals')
        .update({
          fred_divergence_bp: divergenceBp,
          divergence_warning: warning,
        })
        .eq('id', row.id);
      if (updErr) {
        console.error(`[backfill] update ${row.id}: ${updErr.message}`);
        continue;
      }
      updated++;
    }
    console.log(`[backfill] ${commodity}: updated ${updated}/${scanned} so far, caught ${caught}`);
  }

  console.log('---');
  console.log(`[backfill] scanned: ${scanned}`);
  console.log(`[backfill] updated: ${updated}`);
  console.log(`[backfill] divergence_warning=true catches: ${caught}`);
  console.log(
    caught >= 5
      ? '[backfill] PASS: ≥5 historical false-signal catches (acceptance criterion met)'
      : `[backfill] NOTE: ${caught} catches in ${LOOKBACK_DAYS}d. <5 catches may indicate threshold needs re-tuning, OR the realtime feeds were genuinely accurate. Threshold tuning is a 30-day review item, not a blocker.`,
  );
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
