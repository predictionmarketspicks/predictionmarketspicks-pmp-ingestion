#!/usr/bin/env node
// Calibration backtest — replay our options-implied probability methodology
// against historical data, write the result to commodity_edge_backtest_signals.
//
// Option 3 fallback to the Phase 5 plan (per investigation 2026-05-16): Kalshi
// prunes /trades data past ~6 weeks, so there is no historical kalshi_yes to
// compute edge against. This script computes the model's implied
// P(S_T > K) at historical dates and resolves the outcome from realized
// spot. Output: "predicted 60%, resolved 58%" — model calibration over time,
// the credibility-upgrade artifact for /track-record.
//
// Inputs:
//   1. OPRA OHLCV-1d pull from Databento (one file per underlying, full date
//      range). Provided ahead of time via scripts/databento-pull.js.
//   2. Spot history per commodity — Yahoo v8 chart endpoint for the ETF
//      proxy (SLV, GLD, USO). Free, no auth, daily resolution. Pyth Hermes
//      has no historical; FRED has gold + WTI but not silver.
//
// Output: one row per (commodity, evaluation_date, strike_pct, horizon) in
// commodity_edge_backtest_signals. UPSERT on the unique constraint, so
// re-runs are idempotent.
//
// Usage:
//   node scripts/backtest-calibration.js \
//     --commodity silver \
//     --ohlcv-file ./pulls/SLV-ohlcv.json \
//     --defs-file  ./pulls/SLV-defs.json \
//     --from 2024-01-02 \
//     --to   2024-12-31 \
//     [--strikes 0.95,0.98,1.00,1.02,1.05] \
//     [--horizon-days 7] \
//     [--query-id <uuid from databento_query_log>]
//
// Smoke test (cheap, ~$0.05 total, runs on Fly via `fly ssh console`):
//   node scripts/databento-pull.js --schema definition --dataset OPRA.PILLAR \
//     --symbols SLV.OPT --stype-in parent --start 2024-05-01 --end 2024-05-08 \
//     --out /tmp/slv-defs.json --encoding json
//   node scripts/databento-pull.js --schema ohlcv-1d --dataset OPRA.PILLAR \
//     --symbols SLV.OPT --stype-in parent --start 2024-05-01 --end 2024-05-08 \
//     --out /tmp/slv-ohlcv.json --encoding json
//   node scripts/backtest-calibration.js --commodity silver \
//     --ohlcv-file /tmp/slv-ohlcv.json --defs-file /tmp/slv-defs.json \
//     --from 2024-05-01 --to 2024-05-08

import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import { createClient } from '@supabase/supabase-js';
import { impliedVol, probAboveStrike, yearFraction } from '../src/engine/options.js';

const RISK_FREE_RATE = 0.045;
const DIVIDEND_YIELD = 0.0;
const DEFAULT_STRIKES = [0.95, 0.98, 1.00, 1.02, 1.05];
const DEFAULT_HORIZON_DAYS = 7;

// Per-commodity ETF proxy used to fetch spot history. SLV.shares ~= XAG/USD
// price; GLD.shares × 10 ~= XAU/USD price; USO is a managed WTI tracker so
// it's not a great spot proxy, but it's what Kalshi KXWTI ultimately
// references via our existing engine. Backtest applies the same shape.
const COMMODITY_ETF = {
  silver: 'SLV',
  gold: 'GLD',
  oil: 'USO',
};

function parseArgs(argv) {
  const out = {};
  let i = 2;
  while (i < argv.length) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected positional: ${a}`);
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) throw new Error(`--${key} expects value`);
    out[key] = val;
    i += 2;
  }
  return out;
}

function ensure(args, key) {
  if (args[key] == null || args[key] === '') throw new Error(`missing --${key}`);
  return args[key];
}

function supabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_KEY required');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---- Yahoo daily spot history ---------------------------------------------
// Same UA quirk as src/feeds/yahoo-oil.js — bare "Mozilla/5.0" 200s, full
// Chrome UA 429s. v8 chart endpoint, daily resolution, no cookie needed.

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
  const map = new Map(); // 'YYYY-MM-DD' → close
  for (let i = 0; i < stamps.length; i++) {
    if (closes[i] == null) continue;
    const d = new Date(stamps[i] * 1000).toISOString().slice(0, 10);
    map.set(d, closes[i]);
  }
  return map;
}

// ---- Databento OHLCV-1d JSON loader ---------------------------------------
// Databento JSON encoding is newline-delimited JSON (one record per line) for
// OHLCV. Each line has: { ts_event, instrument_id, open, high, low, close,
// volume, symbol }. The instrument_id needs to map to (strike, expiry, type)
// via the definitions Databento ships in the parent payload, but since we
// passed --schema ohlcv-1d the records are pre-mapped via `symbol` (OPRA
// 21-char OCC: "SLV   240517C00026000" → strike $26.00 call exp 2024-05-17).

function parseOccSymbol(occ) {
  // OPRA OCC 21-char: "SLV   240517C00026000"
  // Position breakdown:
  //   [0-5]   root (right-padded to 6 chars)
  //   [6-11]  YYMMDD expiration
  //   [12]    C or P
  //   [13-20] strike × 1000 (8 digits zero-padded)
  if (!occ || occ.length < 21) return null;
  const root = occ.slice(0, 6).trim();
  const yy = occ.slice(6, 8);
  const mm = occ.slice(8, 10);
  const dd = occ.slice(10, 12);
  const right = occ[12];
  const strike = parseInt(occ.slice(13, 21), 10) / 1000;
  if (!root || !yy || !mm || !dd || (right !== 'C' && right !== 'P') || !Number.isFinite(strike)) return null;
  const year = parseInt(yy, 10) >= 70 ? 1900 + parseInt(yy, 10) : 2000 + parseInt(yy, 10);
  return {
    root,
    expiration: `${year}-${mm}-${dd}`,
    right: right === 'C' ? 'call' : 'put',
    strike,
  };
}

// Databento JSON encoding details:
//   - Records are NDJSON, one per line.
//   - ts_event is inside the `hd` envelope, as a string of nanos-since-epoch.
//   - Prices (close, strike_price) are fixed-point integers with 9 decimals.
//   - OHLCV-1d records do NOT carry the OPRA OCC symbol — only instrument_id.
//     Must pre-load a definition schema pull to map instrument_id → raw_symbol
//     → (strike, expiration, right) via parseOccSymbol. Sentinel "biggest int64"
//     values (9223372036854775807) mean "not applicable" for that field.
//
// Per-strike price scaling on Databento JSON: divide by 1e9.
const DBN_PRICE_SCALE = 1e9;

async function loadDefsFile(filePath) {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const byInstrumentId = new Map(); // int → { raw_symbol, strike, expiration, right }
  let nLines = 0;
  let nParsed = 0;
  for await (const line of rl) {
    nLines += 1;
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const iid = rec.hd?.instrument_id;
    if (iid == null) continue;
    // Prefer parsing the OCC OPRA symbol — it's the same shape the engine's
    // live path uses, so any future change to the smile builder benefits both
    // backtest and live without divergence.
    const meta = parseOccSymbol(rec.raw_symbol);
    if (!meta) continue;
    byInstrumentId.set(Number(iid), meta);
    nParsed += 1;
  }
  console.log(`[backtest] loaded ${nParsed}/${nLines} definitions → ${byInstrumentId.size} unique instrument_ids`);
  return byInstrumentId;
}

async function loadOhlcvFile(filePath, defsMap) {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const byDate = new Map(); // 'YYYY-MM-DD' → [{ strike, expiration, right, close, instrument_id }]
  let nLines = 0;
  let nParsed = 0;
  let nNoMeta = 0;
  for await (const line of rl) {
    nLines += 1;
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const iid = Number(rec.hd?.instrument_id);
    if (!Number.isFinite(iid)) continue;
    const meta = defsMap.get(iid);
    if (!meta) { nNoMeta += 1; continue; }
    const close = Number(rec.close) / DBN_PRICE_SCALE;
    if (!Number.isFinite(close) || close <= 0) continue;
    const tsNs = rec.hd?.ts_event;
    if (!tsNs) continue;
    const tsMs = Math.floor(Number(tsNs) / 1e6);
    if (!Number.isFinite(tsMs)) continue;
    const dateKey = new Date(tsMs).toISOString().slice(0, 10);
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push({ ...meta, close, instrument_id: iid });
    nParsed += 1;
  }
  console.log(`[backtest] loaded ${nParsed}/${nLines} OHLCV records (${nNoMeta} missing defs) across ${byDate.size} dates`);
  return byDate;
}

// ---- IV smile per date ----------------------------------------------------

function buildSmile(contracts, spot, evalDate) {
  // contracts at this date with the closest forward expiry; build (strike, iv)
  // pairs by back-solving IV from the close mid (use close as a single-quote
  // proxy — OHLCV-1d doesn't expose bid/ask). Filter OTM only and clamp to
  // a sane window so a single bad print doesn't twist the smile.
  const evalTs = new Date(evalDate).getTime() / 1000;
  const annotated = contracts
    .map((c) => {
      const expSec = new Date(`${c.expiration}T20:00:00Z`).getTime() / 1000;
      const T = (expSec - evalTs) / (365.25 * 86400);
      if (T <= 0 || T > 0.5) return null; // 6mo cap; skip expired
      const otm = c.right === 'call' ? c.strike >= spot : c.strike < spot;
      if (!otm) return null;
      const sol = impliedVol(c.close, spot, c.strike, T, RISK_FREE_RATE, DIVIDEND_YIELD, c.right);
      if (!sol.converged || sol.iv == null) return null;
      return { strike: c.strike, iv: sol.iv, T, right: c.right };
    })
    .filter(Boolean);
  if (annotated.length === 0) return null;
  // Use the nearest expiry's contracts so all points share the same T.
  // (Mixing T values flattens the smile; the engine's live path does the
  // same via fetchEvent → singular expirationDate.)
  const minT = Math.min(...annotated.map((x) => x.T));
  const sameExpiry = annotated.filter((x) => Math.abs(x.T - minT) < 1 / 365);
  if (sameExpiry.length < 3) return null;
  const clean = sameExpiry
    .filter((x) => x.iv >= 0.05 && x.iv <= 2.5)
    .sort((a, b) => a.strike - b.strike);
  if (clean.length < 3) return null;
  return {
    T: clean[0].T,
    ivAt: (targetStrike) => {
      if (targetStrike <= clean[0].strike) return clean[0].iv;
      if (targetStrike >= clean[clean.length - 1].strike) return clean[clean.length - 1].iv;
      for (let i = 1; i < clean.length; i++) {
        if (clean[i].strike >= targetStrike) {
          const [x0, y0] = [clean[i - 1].strike, clean[i - 1].iv];
          const [x1, y1] = [clean[i].strike, clean[i].iv];
          const t = (targetStrike - x0) / (x1 - x0);
          return y0 + (y1 - y0) * t;
        }
      }
      return clean[clean.length - 1].iv;
    },
  };
}

// ---- Date helpers ---------------------------------------------------------

function eachTradingDate(fromIso, toIso) {
  const out = [];
  const start = new Date(fromIso + 'T00:00:00Z');
  const end = new Date(toIso + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function addBusinessDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d.toISOString().slice(0, 10);
}

// ---- main -----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const commodity = ensure(args, 'commodity');
  const ohlcvFile = ensure(args, 'ohlcv-file');
  const defsFile = ensure(args, 'defs-file');
  const fromIso = ensure(args, 'from');
  const toIso = ensure(args, 'to');
  const strikes = (args.strikes || DEFAULT_STRIKES.join(','))
    .split(',')
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);
  const horizonDays = Number(args['horizon-days'] || DEFAULT_HORIZON_DAYS);
  const queryId = args['query-id'] || null;

  const etf = COMMODITY_ETF[commodity];
  if (!etf) throw new Error(`unknown commodity: ${commodity}`);

  console.log(`[backtest] commodity=${commodity} etf=${etf} from=${fromIso} to=${toIso} strikes=${strikes.join(',')} horizon=${horizonDays}d`);

  // Pull spot history out to horizon end so we can resolve outcomes for every
  // evaluation date in [from, to].
  const spotHorizonEnd = addBusinessDays(toIso, horizonDays + 5);
  const spotMap = await fetchYahooDaily(etf, fromIso, spotHorizonEnd);
  console.log(`[backtest] yahoo ${etf} returned ${spotMap.size} daily closes`);

  const defsMap = await loadDefsFile(defsFile);
  const byDate = await loadOhlcvFile(ohlcvFile, defsMap);

  const supabase = supabaseClient();
  const evalDates = eachTradingDate(fromIso, toIso);

  let written = 0;
  let skipped = 0;

  for (const evalDate of evalDates) {
    const spot = spotMap.get(evalDate);
    if (!spot) {
      skipped += 1;
      continue;
    }
    const dayContracts = byDate.get(evalDate);
    if (!dayContracts || dayContracts.length === 0) {
      skipped += 1;
      continue;
    }
    const smile = buildSmile(dayContracts, spot, evalDate);
    if (!smile) {
      skipped += 1;
      continue;
    }

    const horizonDate = addBusinessDays(evalDate, horizonDays);
    const realizedSpot = spotMap.get(horizonDate);

    const rows = [];
    for (const strikePct of strikes) {
      const strike = spot * strikePct;
      const iv = smile.ivAt(strike);
      if (!Number.isFinite(iv) || iv <= 0) continue;
      const T = horizonDays / 365.25;
      const prob = probAboveStrike(spot, strike, T, RISK_FREE_RATE, DIVIDEND_YIELD, iv);
      if (!Number.isFinite(prob)) continue;
      const evaluatedAt = `${evalDate}T15:00:00Z`; // 10am ET ~= 15:00 UTC (EDT) / 14:00 (EST). Close enough for daily.
      const horizonAt = `${horizonDate}T20:00:00Z`;
      let outcome = null;
      if (realizedSpot != null) {
        outcome = realizedSpot > strike ? 'YES_HIT' : 'NO_HIT';
      }
      rows.push({
        evaluated_at: evaluatedAt,
        commodity,
        strike: Number(strike.toFixed(4)),
        strike_pct: Number(strikePct.toFixed(4)),
        horizon_days: horizonDays,
        horizon_at: horizonAt,
        spot_price: Number(spot.toFixed(4)),
        spot_source: `yahoo_${etf.toLowerCase()}_daily`,
        underlying_etf: etf,
        underlying_price: Number(spot.toFixed(4)),
        options_iv: Number(iv.toFixed(4)),
        options_iv_speculative: false,
        options_prob: Number(prob.toFixed(4)),
        realized_spot: realizedSpot != null ? Number(realizedSpot.toFixed(4)) : null,
        outcome,
        settled_at: realizedSpot != null ? horizonAt : null,
        databento_query_id: queryId,
        is_backtest: true,
      });
    }
    if (rows.length === 0) {
      skipped += 1;
      continue;
    }
    const { error } = await supabase
      .from('commodity_edge_backtest_signals')
      .upsert(rows, { onConflict: 'commodity,evaluated_date,strike,horizon_days' });
    if (error) {
      console.error(`[backtest] ${evalDate} upsert failed: ${error.message}`);
      skipped += 1;
      continue;
    }
    written += rows.length;
    console.log(`[backtest] ${evalDate} spot=${spot.toFixed(2)} → ${rows.length} rows (T=${horizonDays}d ${realizedSpot != null ? 'resolved' : 'pending'})`);
  }

  console.log(`[backtest] done. written=${written} skipped=${skipped} dates=${evalDates.length}`);
}

main().catch((err) => {
  console.error('[backtest] failed:', err?.stack || err?.message || err);
  process.exit(1);
});
