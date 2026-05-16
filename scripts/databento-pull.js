#!/usr/bin/env node
// Historical OPRA pull — pay-per-GB add-on with a $25 credit at 2026-05-14.
//
// Every call goes through metadata.get_cost first; refuses to run if the
// estimate exceeds the budget cap ($2/query default) unless --force is
// passed. Every invocation logs to Supabase `databento_query_log` with
// both the estimate and the post-pull actual.
//
// This script does NOT auto-run anything. It's CLI-only, manual invocation.
// Phase 1 ships the gate + the audit log; the first real pull happens
// when the operator decides what to backtest.
//
// Usage:
//   node scripts/databento-pull.js \
//     --schema ohlcv-1d \
//     --dataset OPRA.PILLAR \
//     --symbols SLV.OPT \
//     --start 2026-01-01 \
//     --end   2026-02-01 \
//     [--stype-in parent] \
//     [--encoding json|csv|dbn] \
//     [--out ./pulls/slv-ohlcv-1d-jan2026.json] \
//     [--force] \
//     [--budget-usd 2] \
//     [--notes "first backtest pull"]

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const HIST_BASE = 'https://hist.databento.com/v0';
const DEFAULT_BUDGET_USD = 2.0;

function parseArgs(argv) {
  const out = {};
  let i = 2;
  while (i < argv.length) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new Error(`unexpected positional arg: ${a}`);
    }
    const key = a.slice(2);
    if (key === 'force') {
      out.force = true;
      i += 1;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`flag --${key} expects a value`);
    }
    out[key] = val;
    i += 2;
  }
  return out;
}

function ensure(args, key) {
  if (args[key] == null || args[key] === '') {
    throw new Error(`missing required flag --${key}`);
  }
  return args[key];
}

function basicAuth() {
  const key = process.env.DATABENTO_API_KEY;
  if (!key) throw new Error('DATABENTO_API_KEY not set');
  const token = Buffer.from(`${key}:`).toString('base64');
  return `Basic ${token}`;
}

async function callMetadata(action, body) {
  const url = `${HIST_BASE}/${action}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) params.set(k, v.join(','));
    else params.set(k, String(v));
  }
  const res = await fetch(`${url}?${params.toString()}`, {
    headers: {
      Authorization: basicAuth(),
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${action} ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

async function streamTimeseries(body, outPath) {
  const url = `${HIST_BASE}/timeseries.get_range`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) params.set(k, v.join(','));
    else params.set(k, String(v));
  }
  const res = await fetch(`${url}?${params.toString()}`, {
    headers: { Authorization: basicAuth(), Accept: 'application/octet-stream' },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`timeseries.get_range ${res.status}: ${detail.slice(0, 300)}`);
  }
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  const fh = await fs.promises.open(outPath, 'w');
  const writer = fh.createWriteStream();
  let bytes = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    writer.write(value);
  }
  await new Promise((resolve, reject) => writer.end((err) => (err ? reject(err) : resolve())));
  await fh.close();
  return bytes;
}

function supabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.warn('[databento-pull] SUPABASE_URL/SUPABASE_SERVICE_KEY not set — pull logged to stdout only');
    return null;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function logQuery(supabase, row) {
  if (!supabase) {
    console.log('[databento-pull] would log:', JSON.stringify(row));
    return null;
  }
  const { data, error } = await supabase
    .from('databento_query_log')
    .insert(row)
    .select('query_id')
    .single();
  if (error) {
    console.error('[databento-pull] log insert failed:', error.message);
    return null;
  }
  return data?.query_id || null;
}

async function updateQueryLog(supabase, queryId, patch) {
  if (!supabase || !queryId) return;
  const { error } = await supabase
    .from('databento_query_log')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('query_id', queryId);
  if (error) {
    console.error('[databento-pull] log update failed:', error.message);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const schema = ensure(args, 'schema');
  const dataset = ensure(args, 'dataset');
  const symbols = ensure(args, 'symbols').split(',');
  const start = ensure(args, 'start');
  const end = ensure(args, 'end');
  const stypeIn = args['stype-in'] || 'parent';
  const encoding = args.encoding || 'json';
  const out = args.out || `./pulls/${symbols.join('-')}-${schema}-${start}.${encoding}`;
  const budgetUsd = Number(args['budget-usd'] || DEFAULT_BUDGET_USD);
  const force = !!args.force;
  const notes = args.notes || null;

  console.log(`[databento-pull] schema=${schema} dataset=${dataset} symbols=${symbols.join(',')} start=${start} end=${end}`);

  // ---- Step 1: cost estimate ----
  const costBody = {
    dataset,
    schema,
    symbols,
    stype_in: stypeIn,
    start,
    end,
  };
  // Databento returns a bare number (USD) from metadata.get_cost and a bare
  // number (bytes) from metadata.get_billable_size. The puller calls both so
  // both `cost_estimated_usd` and `gb_estimated` land in databento_query_log.
  const costJson = await callMetadata('metadata.get_cost', costBody);
  const sizeJson = await callMetadata('metadata.get_billable_size', costBody);
  const costEstimatedUsd = Number(costJson?.cost ?? costJson?.cost_usd ?? costJson) || 0;
  const sizeBytes = Number(sizeJson?.size ?? sizeJson?.bytes ?? sizeJson) || 0;
  const gbEstimated = sizeBytes > 0 ? sizeBytes / (1024 ** 3) : null;

  console.log(`[databento-pull] estimate: cost=$${costEstimatedUsd.toFixed(4)}  size=${gbEstimated ? gbEstimated.toFixed(3) + ' GB' : 'unknown'}`);

  const supabase = supabaseClient();
  const baseRow = {
    schema_name: schema,
    dataset,
    symbols,
    stype_in: stypeIn,
    start_at: new Date(start).toISOString(),
    end_at: new Date(end).toISOString(),
    gb_estimated: gbEstimated,
    cost_estimated_usd: costEstimatedUsd,
    forced: !!force,
    notes,
  };

  // ---- Step 2: budget gate ----
  if (costEstimatedUsd > budgetUsd && !force) {
    await logQuery(supabase, {
      ...baseRow,
      pull_status: 'blocked',
      error_message: `BUDGET_BLOCK: estimate $${costEstimatedUsd.toFixed(4)} > cap $${budgetUsd.toFixed(2)}. Pass --force to override.`,
    });
    console.error(
      `[databento-pull] BUDGET BLOCK: estimate $${costEstimatedUsd.toFixed(4)} > cap $${budgetUsd.toFixed(2)}.`,
    );
    console.error('  Re-run with --force if you intend to spend this.');
    process.exit(2);
  }

  // Log the submit attempt up front so a download crash still leaves a row.
  const queryId = await logQuery(supabase, { ...baseRow, pull_status: 'submitted' });
  if (queryId) console.log(`[databento-pull] logged query_id=${queryId}`);

  // ---- Step 3: pull ----
  console.log(`[databento-pull] pulling → ${out} (encoding=${encoding}) ...`);
  let bytes;
  try {
    bytes = await streamTimeseries({ ...costBody, encoding }, out);
  } catch (err) {
    await updateQueryLog(supabase, queryId, {
      pull_status: 'error',
      error_message: (err?.message || String(err)).slice(0, 500),
    });
    throw err;
  }
  const gbActual = bytes / (1024 ** 3);
  const costActualUsd =
    gbEstimated && gbEstimated > 0 ? costEstimatedUsd * (gbActual / gbEstimated) : costEstimatedUsd;

  console.log(`[databento-pull] pulled ${gbActual.toFixed(3)} GB → ~$${costActualUsd.toFixed(4)}`);

  await updateQueryLog(supabase, queryId, {
    pull_status: 'completed',
    gb_actual: gbActual,
    cost_actual_usd: costActualUsd,
  });
}

main().catch((err) => {
  console.error('[databento-pull] failed:', err?.message || err);
  process.exit(1);
});
