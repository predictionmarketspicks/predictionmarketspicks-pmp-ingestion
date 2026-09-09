#!/usr/bin/env node
/**
 * CF Benchmarks entitlement probe. RUN THIS BEFORE WRITING ANYTHING ELSE.
 *
 * Kalshi's 2026-09-08 email says the CF Benchmarks crypto feed is free for every
 * API trader; Kalshi's own docs say "contact Kalshi if access denied" on the
 * history endpoint. Those cannot both be assumed. This script is the test, and
 * it is deliberately the first item in the ship order
 * (handoffs/BRTI_CF_BENCHMARKS_FEED_2026-09-08.md E1.6) — every downstream
 * workstream prices on a feed that may not be entitled on this key.
 *
 * Pattern lifted from scripts/verify-pythnet.mjs: prove the wire format with the
 * real key, print what came back, assert the two things the engines depend on.
 *
 * What it checks:
 *   1. WS `cfbenchmarks_value` accepts our RSA-PSS handshake and delivers BRTI.
 *   2. `msg.data` really is a STRING carrying the raw CF frame (8-dp strings).
 *   3. `avg_60s_data.window_size` reaches >= 50 AFTER a ~70s warm-up — the
 *      trailing 60-print average is the product, and it starts at 1 and fills as
 *      the subscription buffers prints, so it must not be asserted on frame 3.
 *   4. REST `/cfbenchmarks/values` responds, on `KALSHI_API_BASE` first and
 *      `external-api.kalshi.com` as the documented fallback (the docs name a
 *      different host than the one our other calls use; this settles which).
 *   5. `/cfbenchmarks/history/values` — the entitlement that is explicitly NOT
 *      promised. A 401/403 here is a finding, not a crash.
 *
 * Run:
 *   cd ~/pmp-ingestion && node --env-file=.env scripts/verify-cfbenchmarks.mjs
 *
 * Exit 0 = the WS channel is entitled and the averages are usable. Exit 1 = do
 * not build E1; report what came back.
 */
import WebSocket from 'ws';

import { authHeaders, KALSHI_API_BASE, KALSHI_WS_URL, KALSHI_WS_PATH } from '../src/feeds/kalshi-auth.js';

const INDEX_ID = process.env.CF_PROBE_INDEX || 'BRTI';
// ⛔ THE TRAILING AVERAGE WARMS UP. Measured live 2026-09-09T00:03Z: window_size
// was 1 on the first frame and 2 on the third — Kalshi computes the [t−60s, t)
// average over the prints it has buffered FOR THIS SUBSCRIPTION, so it needs a
// full minute before it means anything. Asserting >= 50 on frame 3 fails a
// perfectly healthy feed, which is exactly what the first run of this probe did.
const WARMUP_MS = 70_000;
const WS_TIMEOUT_MS = WARMUP_MS + 20_000;
const WANT_FRAMES = 75;

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

/** The REST passthrough host is unsettled in the docs — try ours, then theirs. */
const REST_BASES = [KALSHI_API_BASE, 'https://external-api.kalshi.com/trade-api/v2'];

async function signedGet(base, pathWithQuery) {
  // ⛔ Sign the path WITHOUT the query string. A signature over "?id=BRTI" is rejected.
  const [path] = pathWithQuery.split('?');
  const url = new URL(base);
  const fullPath = `${url.pathname}${path}`.replace(/\/{2,}/g, '/');
  const headers = { ...authHeaders('GET', fullPath), Accept: 'application/json' };
  const res = await fetch(`${base}${pathWithQuery}`, { headers, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null — the status and body prefix are the finding */
  }
  return { status: res.status, json, body: text.slice(0, 300) };
}

function probeWebSocket() {
  return new Promise((resolve) => {
    const headers = authHeaders('GET', KALSHI_WS_PATH);
    const ws = new WebSocket(KALSHI_WS_URL, { headers });
    const frames = [];
    let subscribed = false;
    let lastSeq = null;
    let seqGaps = 0;
    let closed = false;

    const done = (result) => {
      if (closed) return;
      closed = true;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    // Stop on EITHER enough frames or the warm-up elapsing — a feed that is
    // slower than 1 Hz still passes on the second condition rather than being
    // reported as absent.
    const warmup = setTimeout(() => done({ ok: frames.length > 0, frames, subscribed, seqGaps }), WARMUP_MS);
    const timer = setTimeout(
      () => done({ ok: false, reason: `no cfbenchmarks_value frame within ${WS_TIMEOUT_MS}ms`, frames, subscribed }),
      WS_TIMEOUT_MS,
    );
    const clearAll = () => {
      clearTimeout(warmup);
      clearTimeout(timer);
    };

    ws.on('open', () => {
      ok(`WS open → ${KALSHI_WS_URL}`);
      ws.send(
        JSON.stringify({
          id: 2,
          cmd: 'subscribe',
          // ⛔ index_ids, NOT market_tickers — this channel rejects market_tickers.
          params: { channels: ['cfbenchmarks_value'], index_ids: [INDEX_ID] },
        }),
      );
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'subscribed' || msg.type === 'ok') {
        subscribed = true;
        ok(`subscribe acknowledged: ${JSON.stringify(msg).slice(0, 200)}`);
        return;
      }
      if (msg.type === 'error') {
        clearAll();
        done({ ok: false, reason: `server error: ${JSON.stringify(msg)}`, frames, subscribed });
        return;
      }
      if (msg.type !== 'cfbenchmarks_value') return;

      // `seq` is on the ENVELOPE; index_id / data / avg_60s_data are under `msg`.
      if (typeof msg.seq === 'number') {
        if (lastSeq != null && msg.seq !== lastSeq + 1) seqGaps++;
        lastSeq = msg.seq;
      }
      frames.push(msg.msg ?? msg);
      if (frames.length >= WANT_FRAMES) {
        clearAll();
        done({ ok: true, frames, subscribed, seqGaps });
      }
    });

    ws.on('error', (err) => {
      clearAll();
      done({ ok: false, reason: `socket error: ${err.message}`, frames, subscribed });
    });
    ws.on('close', (code) => {
      clearAll();
      done({ ok: frames.length >= 1, reason: `socket closed early (code ${code})`, frames, subscribed, seqGaps });
    });
  });
}

function lastFullHourIso() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() - 1);
  return d.toISOString();
}

async function main() {
  console.log(`CF Benchmarks entitlement probe — index ${INDEX_ID}`);
  console.log(`  key id: ${process.env.KALSHI_API_KEY_ID ? `${process.env.KALSHI_API_KEY_ID.slice(0, 8)}…` : 'MISSING'}`);
  if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_PRIVATE_KEY) {
    bad('KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not set — pass --env-file=.env');
    process.exit(1);
  }

  console.log('\n[1] WebSocket channel cfbenchmarks_value');
  const wsResult = await probeWebSocket();
  if (!wsResult.ok) {
    bad(wsResult.reason);
    if (wsResult.frames?.length) console.log(JSON.stringify(wsResult.frames[0], null, 2));
    console.log('\nNOT ENTITLED (or wire format changed) — do not build E1. Report this output.');
    process.exit(1);
  }

  console.log(`  received ${wsResult.frames.length} frames over ~${Math.round(WARMUP_MS / 1000)}s, seq gaps: ${wsResult.seqGaps ?? 0}`);
  for (const i of [0, wsResult.frames.length - 1]) {
    const f = wsResult.frames[i];
    if (!f) continue;
    console.log(`\n  --- frame ${i + 1} of ${wsResult.frames.length} ---`);
    console.log(JSON.stringify(f, null, 2).slice(0, 900));
  }
  const sizes = wsResult.frames.map((f) => Number(f?.avg_60s_data?.window_size)).filter(Number.isFinite);
  if (sizes.length) console.log(`\n  avg_60s window_size curve: ${sizes[0]} → ${sizes[sizes.length - 1]} (max ${Math.max(...sizes)})`);

  const probe = wsResult.frames[wsResult.frames.length - 1];
  let hardFail = false;

  // (2) msg.data is a STRING carrying the raw CF frame.
  if (typeof probe.data === 'string') {
    ok('msg.data is a string (raw CF frame, needs JSON.parse)');
    try {
      const frame = JSON.parse(probe.data);
      const price = Number(frame.value);
      if (Number.isFinite(price) && price > 0) ok(`parsed value = ${price} (id ${frame.id}, time ${frame.time})`);
      else {
        bad(`frame.value did not parse to a positive number: ${JSON.stringify(frame.value)}`);
        hardFail = true;
      }
    } catch (err) {
      bad(`msg.data is not JSON: ${err.message}`);
      hardFail = true;
    }
  } else {
    bad(`msg.data is ${typeof probe.data}, expected string — the adapter's parser assumes a string`);
    hardFail = true;
  }

  // (3) the trailing 60-print average — THE product.
  const avg = probe.avg_60s_data;
  if (avg) {
    const size = Number(avg.window_size);
    console.log(`  avg_60s_data: value=${avg.value} window_size=${size} start=${avg.window_start_ts_ms} end=${avg.window_end_ts_exclusive}`);
    if (size >= 50) ok(`window_size ${size} >= 50 after warm-up — dense enough to price on`);
    else {
      bad(`window_size ${size} < 50 after ~${Math.round(WARMUP_MS / 1000)}s — CF is publishing sparsely; the settlement averages would be suspect`);
      hardFail = true;
    }
  } else {
    bad('no avg_60s_data on the frame — the 60-print average is the whole reason for the 1 Hz channel');
    hardFail = true;
  }

  if (probe.last_60s_windowed_average_15min) {
    ok('last_60s_windowed_average_15min present (final minute before a quarter-hour close)');
  } else {
    console.log('  · last_60s_windowed_average_15min absent — expected outside the final minute before :00/:15/:30/:45');
  }

  // (4)+(5) REST passthrough + history entitlement.
  console.log('\n[2] REST passthrough /cfbenchmarks/values');
  let restBase = null;
  for (const base of REST_BASES) {
    const r = await signedGet(base, `/cfbenchmarks/values?id=${INDEX_ID}`).catch((e) => ({ status: 0, body: e.message }));
    console.log(`  ${base} → ${r.status}`);
    if (r.status === 200) {
      restBase = base;
      ok(`REST host settled: ${base}`);
      console.log(`  keys: ${r.json ? Object.keys(r.json).join(', ') : '(unparsed)'} · body ${r.body.slice(0, 200)}`);
      break;
    }
    console.log(`  body: ${r.body.slice(0, 200)}`);
  }
  if (!restBase) bad('neither REST host returned 200 — the WS feed still works; E3 (history) is what needs this');

  console.log('\n[3] History entitlement /cfbenchmarks/history/values (STREAM_HISTORICAL_VALUES)');
  if (restBase) {
    const ts = lastFullHourIso();
    const h = await signedGet(restBase, `/cfbenchmarks/history/values?id=${INDEX_ID}&timespan=HOUR&timestamp=${ts}`).catch(
      (e) => ({ status: 0, body: e.message }),
    );
    console.log(`  timestamp=${ts} → ${h.status}`);
    if (h.status === 200) {
      ok('history entitled — E3 (calibration backfill) can run');
      console.log(`  keys: ${h.json ? Object.keys(h.json).join(', ') : '(unparsed)'} · body ${h.body.slice(0, 240)}`);
    } else {
      bad(`history NOT entitled (${h.status}) — E3 is blocked; Benny must ask Kalshi. body: ${h.body.slice(0, 200)}`);
    }
  } else {
    bad('skipped — no working REST host');
  }

  console.log('');
  if (hardFail) {
    console.log('FAIL — the live channel does not match the contract E1 was specced against. Do not build on it.');
    process.exit(1);
  }
  console.log('PASS — cfbenchmarks_value is entitled and the 60-print average is usable. E1 may proceed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('verify-cfbenchmarks crashed:', err);
  process.exit(1);
});
