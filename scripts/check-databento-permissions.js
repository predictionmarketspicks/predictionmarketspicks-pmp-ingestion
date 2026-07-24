#!/usr/bin/env node
/**
 * Databento subscription audit — one-shot, ~5 seconds.
 *
 * Hits the metadata endpoints to tell us exactly which datasets the
 * DATABENTO_API_KEY in env has permissions for. We care specifically
 * about whether GLBX.MDP3 (CME futures + futures options) is available
 * in addition to OPRA.PILLAR (US equity/ETF options).
 *
 * Usage:
 *   cd pmp-ingestion
 *   node scripts/check-databento-permissions.js
 *
 * No writes, no Supabase calls, no cost — purely metadata reads.
 */
import 'dotenv/config';

const KEY = process.env.DATABENTO_API_KEY;
if (!KEY) {
  console.error('ERROR: DATABENTO_API_KEY not set in environment.');
  process.exit(1);
}

const HIST_BASE = 'https://hist.databento.com/v0';
const auth = 'Basic ' + Buffer.from(`${KEY}:`).toString('base64');

async function get(path, params = {}) {
  const url = new URL(`${HIST_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function main() {
  console.log('1. Listing all datasets your account can see...\n');
  const list = await get('metadata.list_datasets');
  if (list.status !== 200) {
    console.error(`  ERROR ${list.status}:`, list.body);
    process.exit(1);
  }
  const datasets = list.body;
  console.log('   Datasets:', datasets.length, 'total');
  for (const d of datasets) console.log('     -', d);
  console.log();

  const hasOpra = datasets.includes('OPRA.PILLAR');
  const hasGlbx = datasets.includes('GLBX.MDP3');

  console.log('2. Confirmed presence:');
  console.log(`   OPRA.PILLAR  (ETF/equity options): ${hasOpra ? 'YES' : 'NO'}`);
  console.log(`   GLBX.MDP3    (CME futures + options): ${hasGlbx ? 'YES' : 'NO'}`);
  console.log();

  // For each commodity-relevant dataset, probe a cheap historical cost
  // estimate. This tells us we don't just see the dataset name, we can
  // actually pull it (subscription tier, not just discoverability).
  const probes = [
    {
      label: 'OPRA.PILLAR / SLV.OPT / ohlcv-1d / 2026-05-12..13',
      params: {
        dataset: 'OPRA.PILLAR',
        start: '2026-05-12T00:00:00Z',
        end: '2026-05-13T00:00:00Z',
        schema: 'ohlcv-1d',
        symbols: 'SLV.OPT',
        stype_in: 'parent',
      },
    },
    {
      label: 'GLBX.MDP3 / SI.FUT / ohlcv-1d / 2026-05-12..13  (silver futures)',
      params: {
        dataset: 'GLBX.MDP3',
        start: '2026-05-12T00:00:00Z',
        end: '2026-05-13T00:00:00Z',
        schema: 'ohlcv-1d',
        symbols: 'SI.FUT',
        stype_in: 'parent',
      },
    },
    {
      label: 'GLBX.MDP3 / SI.OPT / ohlcv-1d / 2026-05-12..13  (silver futures OPTIONS)',
      params: {
        dataset: 'GLBX.MDP3',
        start: '2026-05-12T00:00:00Z',
        end: '2026-05-13T00:00:00Z',
        schema: 'ohlcv-1d',
        symbols: 'SI.OPT',
        stype_in: 'parent',
      },
    },
    {
      label: 'GLBX.MDP3 / GC.OPT / ohlcv-1d / 2026-05-12..13  (gold futures OPTIONS)',
      params: {
        dataset: 'GLBX.MDP3',
        start: '2026-05-12T00:00:00Z',
        end: '2026-05-13T00:00:00Z',
        schema: 'ohlcv-1d',
        symbols: 'GC.OPT',
        stype_in: 'parent',
      },
    },
    {
      label: 'GLBX.MDP3 / LO.OPT / ohlcv-1d / 2026-05-12..13  (crude oil futures OPTIONS, LO=weekly)',
      params: {
        dataset: 'GLBX.MDP3',
        start: '2026-05-12T00:00:00Z',
        end: '2026-05-13T00:00:00Z',
        schema: 'ohlcv-1d',
        symbols: 'LO.OPT',
        stype_in: 'parent',
      },
    },
  ];

  console.log('3. Probing cost estimates per dataset (does NOT pull data):\n');
  for (const p of probes) {
    process.stdout.write(`   ${p.label}\n      → `);
    const r = await get('metadata.get_cost', p.params);
    if (r.status === 200) {
      console.log(`OK  cost=$${Number(r.body).toFixed(4)}`);
    } else {
      const msg = typeof r.body === 'object' ? JSON.stringify(r.body) : String(r.body).slice(0, 200);
      console.log(`HTTP ${r.status}  ${msg}`);
    }
  }

  console.log('\n4. Summary for the engine rebuild:');
  if (hasGlbx) {
    console.log('   ✓ GLBX.MDP3 access — we can use CME futures + futures-options IV.');
    console.log('     This is the right vol source for Kalshi KXWTI / KXSILVERW / KXGOLDW.');
    console.log('     If the cost-probes for SI.OPT / GC.OPT / LO.OPT returned OK above, we are set.');
  } else {
    console.log('   ✗ No GLBX.MDP3 access — falling back to ETF IV + realized vol blend.');
    console.log('     Still a big improvement over current model, but ETF IV carries ~8pp');
    console.log('     bias for gold (per our backtest). Worth pricing the upgrade.');
  }
}

main().catch((e) => {
  console.error('FATAL:', e?.message || e);
  process.exit(1);
});
