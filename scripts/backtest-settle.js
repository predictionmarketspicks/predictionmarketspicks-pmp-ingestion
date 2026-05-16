#!/usr/bin/env node
// Settle pass — resolve PENDING rows in commodity_edge_backtest_signals by
// fetching realized spot at horizon_at. Idempotent: re-running is safe.
// Typical run after a fresh replay (rows near today's date have
// horizon_at > now() at replay time, so outcome stays NULL until horizon spot
// actually exists).
//
// Usage:
//   node scripts/backtest-settle.js [--commodity silver,gold,oil] [--dry-run]
//
// Default: settles every commodity with PENDING rows whose horizon_at <= now().

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const COMMODITY_ETF = { silver: 'SLV', gold: 'GLD', oil: 'USO' };

function parseArgs(argv) {
  const out = {};
  let i = 2;
  while (i < argv.length) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected positional: ${a}`);
    const key = a.slice(2);
    if (key === 'dry-run') { out['dry-run'] = true; i += 1; continue; }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) throw new Error(`--${key} expects value`);
    out[key] = val;
    i += 2;
  }
  return out;
}

function supabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_KEY required');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchYahooDaily(symbol, fromIso, toIso) {
  const p1 = Math.floor(new Date(fromIso).getTime() / 1000);
  const p2 = Math.floor(new Date(toIso).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${p1}&period2=${p2}&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`yahoo ${symbol} HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`yahoo ${symbol} empty result`);
  const stamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const map = new Map();
  for (let i = 0; i < stamps.length; i++) {
    if (closes[i] == null) continue;
    const d = new Date(stamps[i] * 1000).toISOString().slice(0, 10);
    map.set(d, closes[i]);
  }
  return map;
}

async function settleCommodity(supabase, commodity, dryRun) {
  const etf = COMMODITY_ETF[commodity];
  if (!etf) throw new Error(`unknown commodity: ${commodity}`);

  // Pull rows that are settle-able now.
  const { data: pending, error } = await supabase
    .from('commodity_edge_backtest_signals')
    .select('id, evaluated_date, strike, horizon_at, horizon_days')
    .eq('commodity', commodity)
    .is('outcome', null)
    .lte('horizon_at', new Date().toISOString())
    .order('horizon_at');
  if (error) throw error;
  if (pending.length === 0) {
    console.log(`[settle] ${commodity}: 0 settle-able rows`);
    return { commodity, attempted: 0, settled: 0 };
  }

  const horizonDates = pending.map((r) => r.horizon_at.slice(0, 10));
  const minDate = horizonDates.reduce((a, b) => (a < b ? a : b));
  const maxDate = horizonDates.reduce((a, b) => (a > b ? a : b));
  // Pad +5 business days so Yahoo's daily history covers boundary cases.
  const padEnd = new Date(maxDate);
  padEnd.setUTCDate(padEnd.getUTCDate() + 7);
  const spotMap = await fetchYahooDaily(etf, minDate, padEnd.toISOString().slice(0, 10));
  console.log(`[settle] ${commodity}: ${pending.length} pending, yahoo returned ${spotMap.size} daily closes (${minDate} → ${padEnd.toISOString().slice(0, 10)})`);

  const updates = [];
  let skipped = 0;
  for (const r of pending) {
    const horizonDate = r.horizon_at.slice(0, 10);
    const realized = spotMap.get(horizonDate);
    if (realized == null) { skipped += 1; continue; }
    const outcome = realized > Number(r.strike) ? 'YES_HIT' : 'NO_HIT';
    updates.push({
      id: r.id,
      realized_spot: Number(realized.toFixed(4)),
      outcome,
      settled_at: r.horizon_at,
    });
  }

  if (dryRun) {
    console.log(`[settle] ${commodity}: dry-run — would update ${updates.length} rows (${skipped} skipped)`);
    return { commodity, attempted: pending.length, settled: 0, skipped };
  }

  // Supabase doesn't support multi-row UPDATE with different values per row in
  // a single call. Loop in batches of 50, parallelize with Promise.all.
  let settled = 0;
  const BATCH = 50;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((u) =>
      supabase
        .from('commodity_edge_backtest_signals')
        .update({ realized_spot: u.realized_spot, outcome: u.outcome, settled_at: u.settled_at })
        .eq('id', u.id),
    ));
    for (const { error: uerr } of results) {
      if (uerr) console.error(`[settle] update failed: ${uerr.message}`);
      else settled += 1;
    }
  }
  console.log(`[settle] ${commodity}: settled ${settled}/${updates.length} (${skipped} skipped — horizon date not in Yahoo response)`);
  return { commodity, attempted: pending.length, settled, skipped };
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = !!args['dry-run'];
  const commodities = args.commodity
    ? args.commodity.split(',').map((c) => c.trim())
    : Object.keys(COMMODITY_ETF);

  const supabase = supabaseClient();
  const summary = [];
  for (const c of commodities) {
    summary.push(await settleCommodity(supabase, c, dryRun));
  }
  console.log('[settle] done.');
  for (const s of summary) {
    console.log(`  ${s.commodity}: attempted=${s.attempted} settled=${s.settled} skipped=${s.skipped ?? 0}`);
  }
}

main().catch((err) => {
  console.error('[settle] failed:', err?.stack || err?.message || err);
  process.exit(1);
});
