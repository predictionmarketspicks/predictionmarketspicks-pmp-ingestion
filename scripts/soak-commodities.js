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
//   4. Latest snapshot's smile has stddev_pop(options_iv) ≥ 0.05 (proves a
//      real smile, not a flat ceiling).
//   5. No NON-NULL quality_flag values landed today.
//
// Exit code: 0 if all commodities pass, 1 if any fail. Posts a #bot-logs
// summary either way (DISCORD_BOT_TOKEN must be set).

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const COMMODITIES_TO_CHECK = (process.env.SOAK_COMMODITIES || 'silver,gold,oil')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const IV_HARD_CAP = 3.0;
const MIN_SNAPSHOTS_PER_DAY = 4;
const MIN_SMILE_STDDEV = 0.05;
const BOT_LOGS_CHANNEL_ID = '1487857846111567952';

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

  const { count: flaggedCount, error: flagErr } = await client
    .from('commodity_edge_signals')
    .select('*', { count: 'exact', head: true })
    .eq('commodity', commodity)
    .eq('snapshot_date', snapshotDate)
    .not('quality_flag', 'is', null);
  if (flagErr) failures.push(`flag_query: ${flagErr.message}`);
  else if ((flaggedCount || 0) > 0) failures.push(`quality_flagged_rows=${flaggedCount}`);

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
    } else if (latestRows && latestRows.length >= 3) {
      const ivs = latestRows.map((r) => Number(r.options_iv)).filter((v) => Number.isFinite(v));
      const mean = ivs.reduce((a, b) => a + b, 0) / ivs.length;
      const variance = ivs.reduce((a, b) => a + (b - mean) ** 2, 0) / ivs.length;
      const stddev = Math.sqrt(variance);
      if (stddev < MIN_SMILE_STDDEV) {
        failures.push(`smile_stddev=${stddev.toFixed(4)} < ${MIN_SMILE_STDDEV}`);
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

main().catch((err) => {
  console.error('[soak] fatal:', err?.message || err);
  process.exit(1);
});
