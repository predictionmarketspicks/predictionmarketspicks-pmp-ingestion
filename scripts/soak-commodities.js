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

/**
 * Minimum distinct `snapshot_at` per UTC day, PER COMMODITY.
 *
 * ⛔ THIS USED TO BE A FLAT 4 AND IT WAS UNMEETABLE. It was fitted to bitcoin's
 * intraday cadence and then applied to all four engines. Measured over 90 days
 * of `commodity_edge_signals` (2026-09-10, 61-62 days each):
 *
 *     commodity  min  mean  max      what the engine actually does
 *     bitcoin     14  28.8   61      intraday, hourly settles
 *     oil          1   2.0    3      twice daily (1 on 2 of 90 days)
 *     gold         1   1.0    1      once, near the 20:00 UTC close
 *     silver       1   1.0    1      once, near the 20:00 UTC close
 *
 * Gold and silver have NEVER written more than once in a day. A floor of 4 meant
 * they could not pass, ever — which is most of why this workflow failed 84 of 85
 * scheduled runs.
 *
 * ⚠️ OIL IS 1, NOT 2. The handoff proposing this fix suggested 2, from a 7-date
 * sample. Over 90 days oil writes once on 2 days, so a floor of 2 would keep
 * failing intermittently — the exact failure mode being removed.
 *
 * ⛔ THIS CRITERION ANSWERS "DID THE ENGINE STOP WRITING", WHICH MEANS ZERO. It
 * deliberately does NOT try to catch a cadence DROP (oil going 2 → 1, bitcoin
 * 28 → 14). That is a real question and a different one; conflating them is what
 * produced a threshold nobody could meet. bitcoin's 8 sits well under its
 * observed floor of 14 for the same reason.
 */
const MIN_SNAPSHOTS_PER_DAY_DEFAULT = 1;
const MIN_SNAPSHOTS_PER_DAY = {
  bitcoin: 8,
  oil: 1,
  gold: 1,
  silver: 1,
};

export function minSnapshotsPerDay(commodity) {
  return MIN_SNAPSHOTS_PER_DAY[commodity] ?? MIN_SNAPSHOTS_PER_DAY_DEFAULT;
}
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
/**
 * ⛔ A HARD-SUPPRESSED FLAG IS THE ENGINE WORKING, NOT FAILING.
 *
 * `edge_implausible` and `near_expiry` are in the engine's HARD_SUPPRESS_FLAGS:
 * the row is forced non-actionable ON PURPOSE and never reaches a public
 * surface. Soak was reading both as failures because they were in neither set
 * here, which defaults to ceiling 0. That cost 84 of 85 scheduled runs.
 *
 * `near_expiry` additionally has its own dedicated guard in the PMP repo
 * (.github/workflows/bitcoin-near-expiry-guard.yml), which asserts the far
 * sharper invariant that such a row must never be WRITTEN. Failing soak on it
 * too is double-alarming on something already watched better elsewhere.
 */
const EXPECTED_FLAGS = new Set([
  'cold_buffer',
  'twap_settle_window',
  'edge_implausible',
  'near_expiry',
]);

/**
 * Per-flag daily ceilings, PER COMMODITY where the engines genuinely differ.
 *
 * ⛔ ONE GLOBAL CEILING COULD NOT SERVE BOTH FAMILIES, and that is why 50 was
 * wrong in two directions at once. Measured over 90 days (2026-09-10):
 *
 *     kalshi_no_book/day   mean   p95   max
 *     bitcoin               201   254   281      <- 50 failed on ~every day
 *     silver                 10    15    19      <- 50 = a 2.6x rise before it fires
 *     gold                    7    16    17
 *     oil                     4    12    15
 *
 * bitcoin quotes far-out strikes on an intraday cadence and a few hundred
 * no-book rows a day is its normal shape; the daily metals quote a handful.
 *
 * ⚠️ FITTED ON 90 DAYS, DELIBERATELY NOT ON THE RECENT WINDOW. Oil's
 * `edge_implausible` hit 21 on 2026-09-10 against a trailing baseline of 0-1 —
 * that is the Iran war moving the tape, i.e. the guard doing its job in a
 * violent regime, not evidence it is miscalibrated. Tuning to a fortnight that
 * contains a war bakes the war into the threshold.
 *
 * Ceilings sit above the 90-day MAX rather than at p95: this criterion is meant
 * to catch a sustained break, and a check that fires on the worst ordinary day
 * in a quarter is the thing being fixed, not the fix.
 */
const UNEXPECTED_FLAG_CEILINGS = {
  kalshi_no_book:              40,
  kalshi_stale:                25,
  kalshi_stale_divergence:     25,
  kalshi_thin_book_large_edge: 25,
  smile_kalshi_diverged:       10,
};
const CEILING_OVERRIDES = {
  bitcoin: { kalshi_no_book: 300 },
};

// Exported for the vocabulary test — it must read the SAME objects the checker
// uses, not a copy, or the test drifts from the thing it is guarding.
export const EXPECTED_FLAGS_FOR_TEST = EXPECTED_FLAGS;
export const CEILINGS_FOR_TEST = UNEXPECTED_FLAG_CEILINGS;

export function ceilingsFor(commodity) {
  return { ...UNEXPECTED_FLAG_CEILINGS, ...(CEILING_OVERRIDES[commodity] ?? {}) };
}

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
  const minSnaps = minSnapshotsPerDay(commodity);
  if (seenSnaps.size < minSnaps) {
    failures.push(`snapshots=${seenSnaps.size} < ${minSnaps}`);
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
    for (const v of classifyFlagCounts(flagCounts, { ceilings: ceilingsFor(commodity) })) {
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
