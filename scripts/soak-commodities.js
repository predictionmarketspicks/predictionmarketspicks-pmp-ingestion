#!/usr/bin/env node
// Soak validator for commodity_edge_signals after the 2026-05-15 Databento
// cutover (handoff: SILVER_EDGE_GUARDS_2026-05-15). Runs at 21:00 UTC weekdays
// via .github/workflows/commodity-soak.yml, after options market close, against
// the day's writes for every commodity in COMMODITIES_TO_CHECK.
//
// Pass criteria per commodity for the current UTC date:
//   1. No rows with options_iv > 3.0 AND quality_flag IS NULL.
//   2. No rows with spot_source = 'prev_close_bridge' written before the day's
//      first parity-sourced row landed (cold-start guard worked).
//   3. ≥ 4 distinct snapshot_at timestamps written.
//   4. Latest snapshot's smile is non-degenerate — STDDEV_POP(options_iv) /
//      AVG(options_iv) > MIN_SMILE_RATIO. Relative spread is self-calibrating
//      across vol regimes (gold ~7% IV vs silver ~30% IV vs oil ~70%); the
//      old absolute floor of 0.05 stddev caught 88–97% of healthy snapshots
//      as false positives because low-vol commodities have naturally tight
//      smiles. See memory: project_commodity_soak_threshold.md.
//   5. No problematic quality_flag values above their daily ceiling. Expected
//      audit tags (cold_buffer, twap_settle_window) are ignored at any volume;
//      kalshi_* / smile_kalshi_diverged fail only past per-flag ceilings, and
//      any unknown flag fails on first sighting. See classifyFlagCounts.
//
// Exit code: 0 if all commodities pass, 1 if any fail. Posts a #bot-logs
// summary either way (DISCORD_BOT_TOKEN must be set).

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const COMMODITIES_TO_CHECK = (process.env.SOAK_COMMODITIES || 'silver,gold,oil,bitcoin')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const IV_HARD_CAP = 3.0;
const MIN_SNAPSHOTS_PER_DAY = 4;
// Smile must show ≥ 0.5% relative spread (STDDEV_POP(iv) / AVG(iv) > 0.005).
// 14-day data (2026-05-15) showed every commodity's p50 ratio comfortably
// above this — gold 0.0154, oil 0.0182, silver 0.0345 — while every
// stddev=0 degenerate-chain case correctly fails. Per-commodity override
// map below is reserved for future tuning; leave empty unless one commodity
// drifts.
const MIN_SMILE_RATIO_DEFAULT = 0.005;
const MIN_SMILE_RATIO_OVERRIDES = {};
const BOT_LOGS_CHANNEL_ID = '1487857846111567952';

// quality_flag classification. EXPECTED_FLAGS fire under normal operation by
// design — cold_buffer after Fly redeploys, twap_settle_window in the last 15
// min before bitcoin's hourly settles. Site readers + Discord routing filter
// `quality_flag IS NULL` so these never reach a public surface. Soak ignores
// them.
//
// UNEXPECTED_FLAG_CEILINGS sets per-flag daily ceilings for the genuinely
// problematic flags. Small daily counts (transient hiccups) are fine; anything
// sustained means kalshi or the chain is broken — those should fail soak.
// Anything not in either set falls through to ceiling=0 (any sighting fails);
// new flag names added to the engine should be added here explicitly.
const EXPECTED_FLAGS = new Set(['cold_buffer', 'twap_settle_window']);
const UNEXPECTED_FLAG_CEILINGS = {
  kalshi_no_book:              50,
  kalshi_stale_divergence:     25,
  kalshi_thin_book_large_edge: 25,
  smile_kalshi_diverged:       10,
};

export function minSmileRatio(commodity) {
  return MIN_SMILE_RATIO_OVERRIDES[commodity] ?? MIN_SMILE_RATIO_DEFAULT;
}

// Pure-function smile check — exported for testability.
//   ivs: array of options_iv values from the latest snapshot.
//   minRatio: floor for stddev / mean.
// Returns { ok, reason, strikes, mean, stddev, ratio }. ok=true when there
// are < 3 strikes (skipped by upstream policy) or when ratio > minRatio.
export function evaluateSmile(ivs, { minRatio = MIN_SMILE_RATIO_DEFAULT } = {}) {
  const finite = (Array.isArray(ivs) ? ivs : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (finite.length < 3) {
    return { ok: true, reason: 'too_few_strikes', strikes: finite.length };
  }
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const variance = finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length;
  const stddev = Math.sqrt(variance);
  // Defensive — a chain that somehow logged mean <= 0 is itself degenerate.
  if (!(mean > 0)) {
    return { ok: false, reason: 'non_positive_mean', strikes: finite.length, mean, stddev, ratio: null };
  }
  const ratio = stddev / mean;
  return {
    ok: ratio > minRatio,
    reason: ratio > minRatio ? 'ok' : 'smile_too_flat',
    strikes: finite.length,
    mean,
    stddev,
    ratio,
  };
}

// Pure-function quality_flag classifier — exported for testability, mirroring
// evaluateSmile. Takes a {flag: count} map and returns the list of violations
// (flags whose count exceeds their ceiling). EXPECTED_FLAGS are ignored at any
// volume; unknown flags default to ceiling 0 (any sighting is a violation).
export function classifyFlagCounts(flagCounts, {
  expected = EXPECTED_FLAGS,
  ceilings = UNEXPECTED_FLAG_CEILINGS,
} = {}) {
  const violations = [];
  for (const [flag, count] of Object.entries(flagCounts || {})) {
    if (expected.has(flag)) continue;
    const ceiling = ceilings[flag] ?? 0;
    if (count > ceiling) violations.push({ flag, count, ceiling });
  }
  return violations;
}

function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function todayUtcISO() {
  return new Date().toISOString().slice(0, 10);
}

async function checkCommodity(client, commodity, snapshotDate) {
  const failures = [];

  const { count: ivBreach, error: ivErr } = await client
    .from('commodity_edge_signals')
    .select('*', { count: 'exact', head: true })
    .eq('commodity', commodity)
    .eq('snapshot_date', snapshotDate)
    .is('quality_flag', null)
    .gt('options_iv', IV_HARD_CAP);
  if (ivErr) failures.push(`iv_cap_query: ${ivErr.message}`);
  else if ((ivBreach || 0) > 0) failures.push(`iv_over_${IV_HARD_CAP}_rows=${ivBreach}`);

  const { data: distinct, error: snapsErr } = await client
    .from('commodity_edge_signals')
    .select('snapshot_at, spot_source')
    .eq('commodity', commodity)
    .eq('snapshot_date', snapshotDate)
    .is('quality_flag', null)
    .order('snapshot_at', { ascending: true });
  if (snapsErr) {
    failures.push(`snapshots_query: ${snapsErr.message}`);
    return { commodity, ok: false, failures };
  }

  const seenSnaps = new Set();
  let firstSnapAt = null;
  let firstSpotSource = null;
  for (const r of distinct || []) {
    if (!seenSnaps.has(r.snapshot_at)) {
      seenSnaps.add(r.snapshot_at);
      if (firstSnapAt == null) {
        firstSnapAt = r.snapshot_at;
        firstSpotSource = r.spot_source;
      }
    }
  }
  if (seenSnaps.size < MIN_SNAPSHOTS_PER_DAY) {
    failures.push(`snapshots=${seenSnaps.size} < ${MIN_SNAPSHOTS_PER_DAY}`);
  }
  if (firstSpotSource === 'prev_close_bridge') {
    failures.push(`first_snapshot_used_prev_close_bridge at ${firstSnapAt}`);
  }

  // Criterion #5: per-flag classification (replaces the blanket
  // flaggedCount > 0 check). EXPECTED_FLAGS are by-design audit tags; only
  // genuinely problematic flags above their daily ceiling fail soak.
  const { data: flagRows, error: flagErr } = await client
    .from('commodity_edge_signals')
    .select('quality_flag')
    .eq('commodity', commodity)
    .eq('snapshot_date', snapshotDate)
    .not('quality_flag', 'is', null);
  if (flagErr) {
    failures.push(`flag_query: ${flagErr.message}`);
  } else {
    const flagCounts = {};
    for (const r of flagRows || []) {
      flagCounts[r.quality_flag] = (flagCounts[r.quality_flag] || 0) + 1;
    }
    for (const v of classifyFlagCounts(flagCounts)) {
      failures.push(`${v.flag}=${v.count} > ${v.ceiling}`);
    }
  }

  if (distinct && distinct.length > 0) {
    const latestSnapAt = [...seenSnaps].sort().pop();
    const { data: latestRows, error: latestErr } = await client
      .from('commodity_edge_signals')
      .select('options_iv')
      .eq('commodity', commodity)
      .eq('snapshot_at', latestSnapAt)
      .is('quality_flag', null)
      .not('options_iv', 'is', null);
    if (latestErr) {
      failures.push(`latest_smile_query: ${latestErr.message}`);
    } else {
      const ivs = (latestRows || []).map((r) => Number(r.options_iv));
      const verdict = evaluateSmile(ivs, { minRatio: minSmileRatio(commodity) });
      if (!verdict.ok) {
        const detail = verdict.ratio == null
          ? `${verdict.reason} (strikes=${verdict.strikes})`
          : `smile_ratio=${verdict.ratio.toFixed(4)} (stddev=${verdict.stddev.toFixed(4)}, mean=${verdict.mean.toFixed(4)}) < ${minSmileRatio(commodity)}`;
        failures.push(detail);
      }
    }
  }

  return { commodity, ok: failures.length === 0, failures, snapshotCount: seenSnaps.size };
}

async function postBotLog(content) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[soak] DISCORD_BOT_TOKEN not set — skipping Discord notification');
    return;
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${BOT_LOGS_CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn(`[soak] discord ${res.status}`);
  } catch (err) {
    console.warn(`[soak] discord post failed: ${err?.message || err}`);
  }
}

async function main() {
  const client = sb();
  const snapshotDate = process.env.SOAK_DATE || todayUtcISO();
  console.log(`[soak] checking ${COMMODITIES_TO_CHECK.join(', ')} for ${snapshotDate}`);

  const results = [];
  for (const commodity of COMMODITIES_TO_CHECK) {
    results.push(await checkCommodity(client, commodity, snapshotDate));
  }

  const allOk = results.every((r) => r.ok);
  const lines = [`Commodity engine soak — ${snapshotDate} — ${allOk ? 'PASS' : 'FAIL'}`];
  for (const r of results) {
    if (r.ok) {
      lines.push(`  ${r.commodity}: PASS (${r.snapshotCount} snapshots)`);
    } else {
      lines.push(`  ${r.commodity}: FAIL — ${r.failures.join('; ')}`);
    }
  }
  const summary = lines.join('\n');
  console.log(summary);
  await postBotLog(summary);

  process.exit(allOk ? 0 : 1);
}

// Guard main() so importing this file from a test file does not invoke the
// network round-trip or call process.exit. Standard Node ESM is-main check.
const isMainModule = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error('[soak] fatal:', err?.message || err);
    process.exit(1);
  });
}
