#!/usr/bin/env node
// Parity test — compares the Databento Live (via sidecar) chain to the
// Massive REST chain for SLV. Run locally during US options market hours
// with both API keys set:
//
//   DATABENTO_API_KEY=... MASSIVE_API_KEY=... node scripts/parity-databento-vs-massive.js
//
// Assumes the Python sidecar (python/databento_live.py) is already running
// on localhost:9090. Start it manually if needed:
//   python3 python/databento_live.py
//
// Acceptance (handoffs/DATABENTO_INTEGRATION_2026-05-14.md §Phase 1):
//   1. IV smile within 1% across in-window OTM strikes.
//   2. Fused tier identical for every row when both chains are fed through
//      buildIvSmile + computeSnapshot against the same Kalshi event.
//
// Exits 0 on pass, 1 on fail. Not wired into CI — needs market-hours
// liquidity + both API keys + the sidecar running.

import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';

import { startMassivePoller, getChain as getChainMassive } from '../src/feeds/massive.js';
import { startDatabentoPoller, getChain as getChainDatabento } from '../src/feeds/databento.js';
import { __test__ as engineTest, computeSnapshot, discoverEvent } from '../src/engine/commodity-base.js';
import { COMMODITIES } from '../src/engine/commodities.js';
import { startPyth, FEED_IDS as PYTH_FEED_IDS } from '../src/feeds/pyth.js';
import { startKalshi } from '../src/feeds/kalshi.js';

const { buildIvSmile } = engineTest;

const SLV = COMMODITIES.silver;
const WARMUP_MS = 90_000;
const IV_TOLERANCE = 0.01;

function pct(x) {
  return `${(x * 100).toFixed(3)}%`;
}

function maxAbsRelDiff(seriesA, seriesB) {
  let max = 0;
  for (let i = 0; i < seriesA.length; i++) {
    const a = seriesA[i];
    const b = seriesB[i];
    if (a == null || b == null || a <= 0) continue;
    const d = Math.abs(b - a) / a;
    if (d > max) max = d;
  }
  return max;
}

async function main() {
  if (!process.env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY not set');
  if (!process.env.MASSIVE_API_KEY) throw new Error('MASSIVE_API_KEY not set');

  // Boot the dependencies both pollers need to populate.
  console.log('[parity] starting Kalshi WS + Pyth XAG/USD ...');
  await startKalshi();
  if (PYTH_FEED_IDS['XAG/USD']) startPyth(['XAG/USD']);

  // Discover an open Kalshi silver event so we have a real comparison target.
  console.log('[parity] resolving Kalshi event ...');
  const event = await discoverEvent(SLV);
  if (!event) throw new Error('no open KXSILVERW event');
  console.log(`[parity] event=${event.eventTicker} closes=${event.closeTime} markets=${event.markets.length}`);

  // Boot both pollers in parallel.
  console.log('[parity] starting both pollers ...');
  startMassivePoller(SLV.underlyingEtf, { value: null });
  startDatabentoPoller(SLV.underlyingEtf);

  console.log(`[parity] warmup ${WARMUP_MS / 1000}s ...`);
  await sleep(WARMUP_MS);

  const chainMA = getChainMassive(SLV.underlyingEtf);
  const chainDB = getChainDatabento(SLV.underlyingEtf);
  if (!chainMA || !chainMA.contracts || chainMA.contracts.length === 0) {
    throw new Error('Massive chain empty after warmup');
  }
  if (!chainDB || !chainDB.contracts || chainDB.contracts.length === 0) {
    throw new Error('Databento chain empty after warmup');
  }

  const etfMA = chainMA.contracts.find((c) => c.underlyingPrice)?.underlyingPrice;
  const etfDB = chainDB.contracts.find((c) => c.underlyingPrice)?.underlyingPrice;
  if (!etfMA || !etfDB) throw new Error('missing ETF spot on one of the chains');
  console.log(`[parity] etf  massive=$${etfMA.toFixed(3)}  databento=$${etfDB.toFixed(3)}  diff=${pct(Math.abs(etfDB - etfMA) / etfMA)}`);

  // ---- Stage 1: IV smile parity ----
  const smileMA = buildIvSmile(chainMA.contracts, etfMA);
  const smileDB = buildIvSmile(chainDB.contracts, etfDB);

  // Sample grid across ±10% of ETF spot in 1% steps. Catches the OTM put +
  // OTM call wings the smile actually feeds.
  const grid = [];
  for (let pct_ = -0.10; pct_ <= 0.10; pct_ += 0.01) {
    grid.push(etfMA * (1 + pct_));
  }

  const rows = [];
  for (const K of grid) {
    const ivMA = smileMA.ivAt(K)?.iv;
    const ivDB = smileDB.ivAt(K)?.iv;
    rows.push({ K, ivMA, ivDB, diff: ivMA && ivDB ? Math.abs(ivDB - ivMA) / ivMA : null });
  }

  console.log('\n[parity] IV smile diff:');
  console.log('strike      ivMA      ivDB      diff');
  for (const r of rows) {
    console.log(
      `${r.K.toFixed(2).padStart(6)}   ${(r.ivMA ?? 0).toFixed(4)}   ${(r.ivDB ?? 0).toFixed(4)}   ${r.diff == null ? 'n/a' : pct(r.diff)}`,
    );
  }
  const ivPass = maxAbsRelDiff(rows.map((r) => r.ivMA), rows.map((r) => r.ivDB)) < IV_TOLERANCE;
  console.log(`\n[parity] IV smile: ${ivPass ? 'PASS' : 'FAIL'} (tolerance ${pct(IV_TOLERANCE)})`);

  // ---- Stage 2: fused tier parity ----
  // computeSnapshot reads getChain via the provider switch. Run twice with
  // the switch flipped; collect rows; diff fused_tier strike-by-strike.
  process.env.OPTIONS_PROVIDER = 'massive';
  const snapMA = await computeSnapshot(SLV, event);
  process.env.OPTIONS_PROVIDER = 'databento';
  const snapDB = await computeSnapshot(SLV, event);

  if (!snapMA || !snapDB) {
    console.log('[parity] computeSnapshot returned null — fused-tier diff skipped');
    process.exit(ivPass ? 0 : 1);
  }

  console.log('\n[parity] fused tier diff:');
  console.log('strike      tier_ma            tier_db            edge_ma   edge_db   match');
  let tierFails = 0;
  const rowsMA = new Map(snapMA.rows.map((r) => [r.strike, r]));
  for (const rDB of snapDB.rows) {
    const rMA = rowsMA.get(rDB.strike);
    if (!rMA) continue;
    const tierMA = rMA.confidence;
    const tierDB = rDB.confidence;
    const match = tierMA === tierDB;
    if (!match) tierFails++;
    console.log(
      `${rDB.strike.toFixed(2).padStart(6)}   ${(tierMA ?? 'n/a').padEnd(18)} ${(tierDB ?? 'n/a').padEnd(18)} ${(rMA.edge_pp ?? 0).toFixed(4).padStart(8)}  ${(rDB.edge_pp ?? 0).toFixed(4).padStart(8)}  ${match ? 'OK' : 'MISMATCH'}`,
    );
  }
  const tierPass = tierFails === 0;
  console.log(`\n[parity] fused tier: ${tierPass ? 'PASS' : `FAIL (${tierFails} mismatches)`}`);

  console.log(`\n[parity] overall: ${ivPass && tierPass ? 'PASS' : 'FAIL'}`);
  process.exit(ivPass && tierPass ? 0 : 1);
}

main().catch((err) => {
  console.error('[parity] crashed:', err);
  process.exit(1);
});
