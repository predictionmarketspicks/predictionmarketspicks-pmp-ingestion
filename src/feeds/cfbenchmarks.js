// CF Benchmarks BRTI — the index Kalshi actually settles bitcoin on.
//
// WHY THIS EXISTS. Every Kalshi bitcoin contract we price settles on the CF
// Benchmarks Bitcoin Real-Time Index, and not on a spot print: the settled value
// is the simple average of the 60 one-second index values immediately before the
// cut-off (Kalshi's own contract text). We approximated that with a median of
// four constituent exchanges because "BRTI has no public tick". Kalshi now streams
// the index itself to API traders for $0 AND computes the trailing 60-second
// average on every message — so the settlement number is observable IN FLIGHT,
// before the market has it. handoffs/BRTI_CF_BENCHMARKS_FEED_2026-09-08.md E1.
//
// ⛔ ITS OWN SOCKET, NOT kalshi.js's. That socket is closed and reopened every
// hour at HH:00:30 UTC for the KXBTCD resubscribe (kalshi.js) — i.e. thirty
// seconds after every hourly settlement print, which is exactly the moment this
// feed must not be down. Two sockets, one shared signer (kalshi-auth.js).
//
// ⛔ RAW INDEX VALUES ARE OPRA-CLASS. Kalshi's Data Terms of Use prohibit publicly
// displaying licensed content and CF Benchmarks is a regulated benchmark
// administrator, so BRTI values and the running average are INTERNAL CALCULATION
// ONLY: they price the model and they never reach a payload, a page, an article, a
// widget or a Discord embed. The PUBLIC spot stays the free exchange basket
// (brti-spot.js). `BTC_PUBLIC_SPOT=ref` flips that the day Kalshi says display is
// fine, and nothing else has to change. Enforced site-side by
// `npm run lint:source-mask`.
//
// ⛔ DISARMED BY DEFAULT. `CF_INDEX_IDS` is unset until the entitlement probe
// (scripts/verify-cfbenchmarks.mjs) has been run ON THE MACHINE with the real key
// — Kalshi's email says the feed is free for API traders, Kalshi's docs say
// "contact Kalshi if access denied", and those cannot both be assumed. With it
// unset (or 'off') this module is a no-op and getBtcSpot() degrades to exactly
// today's behaviour. Arm with `fly secrets set CF_INDEX_IDS=BRTI -a pmp-ingestion`
// only after the probe passes.
import WebSocket from 'ws';

import { setFeedStatus, recordTick } from '../observability/health.js';
import { recordTick as recordPriceTick } from '../engine/short-horizon-vol.js';
import { recordSettlementSpotCapture } from '../delivery/supabase.js';
import { authHeaders, KALSHI_WS_URL, KALSHI_WS_PATH } from './kalshi-auth.js';

export const CF_SOURCE_TAG = 'cf_brti';
export const CF_SPOT_SOURCE = 'cf_benchmarks_brti';

/**
 * Which indices to subscribe. Unset or 'off' = disarmed (see the header).
 * 'BRTI,ETHUSD_RTI' adds ethereum once KXETH15M is wanted.
 */
const RAW_INDEX_IDS = (process.env.CF_INDEX_IDS || '').trim();
const INDEX_IDS =
  RAW_INDEX_IDS === '' || RAW_INDEX_IDS.toLowerCase() === 'off'
    ? []
    : RAW_INDEX_IDS.split(',').map((s) => s.trim()).filter(Boolean);

/** A print older than this is not a live index read. Callers gate; this never does. */
export const CF_MAX_AGE_MS = 15_000;

/**
 * ⛔ THROTTLE TO ONE VOL TICK PER 10 s. short-horizon-vol.js sizes its 600-slot
 * ring for a 10 s cadence and its σ constants were FIT on that cadence. Feeding
 * it 1 Hz would truncate the 15-minute lookback to 10 minutes and silently change
 * the σ regime every published calibration number was measured on. Raising the
 * capacity and measuring 1 s realised vol is a later, separately gated experiment.
 */
const VOL_TICK_INTERVAL_MS = 10_000;

/** 3 minutes of 1 Hz prints — enough for the running settlement average (E5). */
const RAW_RING = 180;

/** index_id → latest observation. */
const latest = new Map();
/** index_id → { prints: [{price, t}], lastVolTickMs, lastSeq } */
const state = new Map();

let ws = null;
let stopRequested = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
const health = { seqGaps: 0, capturesWritten: 0, lastAvgWindowSize: null, lastError: null };

function stateFor(id) {
  let st = state.get(id);
  if (!st) {
    st = { prints: [], lastVolTickMs: 0, lastSeq: null };
    state.set(id, st);
  }
  return st;
}

/** Which commodity key each index feeds in the vol buffer and the capture tables. */
const INDEX_META = {
  BRTI: { volKey: 'bitcoin', quarterHour: { commodity: 'btc', series: 'KXBTC15M' }, hourly: { commodity: 'bitcoin', series: 'KXBTCD' } },
  ETHUSD_RTI: { volKey: 'ethereum', quarterHour: { commodity: 'eth', series: 'KXETH15M' }, hourly: null },
};

/**
 * Quarter-hour and hour boundaries crossed between two instants.
 *
 * The settlement window is `[T − 60s, T)`, so the print that matters is the LAST
 * message whose source time is strictly before T. Detecting the boundary by
 * comparing consecutive prints means the first print at-or-after T tells us the
 * previous one was the last before it — which is exactly the row to store.
 */
function boundariesCrossed(prevMs, nowMs) {
  const out = [];
  if (prevMs == null) return out;
  const q = 900_000;
  const h = 3_600_000;
  const prevQ = Math.floor(prevMs / q);
  const nowQ = Math.floor(nowMs / q);
  if (nowQ > prevQ) out.push({ kind: 'quarter', at: nowQ * q });
  const prevH = Math.floor(prevMs / h);
  const nowH = Math.floor(nowMs / h);
  if (nowH > prevH) out.push({ kind: 'hour', at: nowH * h });
  return out;
}

async function writeCapture(target, boundaryMs, last) {
  if (!target) return;
  // Prefer Kalshi's OWN quarter-hour average when it is on the frame — in the
  // final minute before :00/:15/:30/:45 it publishes
  // `last_60s_windowed_average_15min`, which is the settlement number itself.
  // Otherwise the trailing per-tick average, whose window is [t−60s, t) and is
  // therefore within one print of the settlement window.
  const avg = last.avg15m ?? last.avg60s ?? null;
  try {
    await recordSettlementSpotCapture({
      commodity: target.commodity,
      series: target.series,
      windowCloseAt: new Date(boundaryMs).toISOString(),
      ourSpot: last.price,
      // How far before the settling instant our last print was taken. Sub-second
      // at 1 Hz, versus ~5 s on the metals tick loop.
      leadS: Number(((boundaryMs - last.publishTimeMs) / 1000).toFixed(3)),
      spotAgeS: Number(((Date.now() - last.publishTimeMs) / 1000).toFixed(3)),
      avg60s: avg?.value != null ? Number(avg.value) : null,
      avgWindowSize: avg?.window_size != null ? Number(avg.window_size) : null,
      source: 'cf_ws',
    });
    health.capturesWritten++;
    if (avg?.window_size != null) health.lastAvgWindowSize = Number(avg.window_size);
  } catch (err) {
    // A capture failure must never take the price feed down — the feed is what
    // the engines price on; the capture only feeds a scorecard.
    health.lastError = `capture: ${err.message}`;
    console.warn(`[cf] capture ${target.series} @ ${new Date(boundaryMs).toISOString()} failed: ${err.message}`);
  }
}

/**
 * Handle one cfbenchmarks_value envelope.
 *
 * ⛔ THE PAYLOAD IS NESTED UNDER `msg`, and `seq` is NOT. Measured live on the
 * Fly machine 2026-09-09T00:03Z (scripts/verify-cfbenchmarks.mjs):
 *
 *   { type: 'cfbenchmarks_value', sid: 1, seq: 3,
 *     msg: { index_id: 'BRTI', received_at: 1788912185073,
 *            data: '{"type":"value","time":...,"id":"BRTI","value":"78527.36"}',
 *            avg_60s_data: { value: '78527.45000000', window_size: 2, ... } } }
 *
 * The spec wrote these as `msg.index_id` / `msg.data` / `msg.avg_60s_data`
 * meaning "fields of the message", which reads identically to top-level fields
 * and is how this was first built. Reading them off the envelope yields
 * `undefined` and drops EVERY tick — silently, because a dropped tick looks
 * exactly like a quiet feed. This is what the entitlement probe caught.
 *
 * @param {object} envelope the full parsed WS frame
 */
function onValue(envelope) {
  const msg = envelope?.msg ?? envelope;
  const id = msg?.index_id;
  if (!id) return;
  let frame;
  try {
    frame = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
  } catch {
    return;
  }
  const price = Number(frame?.value);
  const t = Number(frame?.time);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(t)) return;

  const st = stateFor(id);

  // A seq gap means we missed prints. Counted rather than repaired: the running
  // average is only meaningful when the window is dense, and `avg_window_size`
  // is what records that per capture.
  // `seq` is on the ENVELOPE (measured live), unlike everything else here.
  const seq = typeof envelope?.seq === 'number' ? envelope.seq : null;
  if (seq != null) {
    if (st.lastSeq != null && seq !== st.lastSeq + 1) {
      health.seqGaps++;
      console.warn(`[cf] seq gap on ${id}: ${st.lastSeq} → ${seq}`);
    }
    st.lastSeq = seq;
  }

  const prev = latest.get(id) ?? null;
  const obs = {
    symbol: id,
    price,
    publishTimeMs: t,
    receivedAt: Date.now(),
    source: CF_SPOT_SOURCE,
    avg60s: msg.avg_60s_data ?? null,
    avg15m: msg.last_60s_windowed_average_15min ?? null,
    seq,
  };

  // Boundary capture BEFORE overwriting `latest`: the row we want is the previous
  // print, the last one strictly before T.
  const meta = INDEX_META[id];
  if (prev && meta) {
    for (const b of boundariesCrossed(prev.publishTimeMs, t)) {
      void writeCapture(b.kind === 'quarter' ? meta.quarterHour : meta.hourly, b.at, prev);
    }
  }

  latest.set(id, obs);
  st.prints.push({ price, t });
  if (st.prints.length > RAW_RING) st.prints.splice(0, st.prints.length - RAW_RING);

  recordTick(CF_SOURCE_TAG);
  setFeedStatus(CF_SOURCE_TAG, { connected: true, lastError: null });

  if (meta && t - st.lastVolTickMs >= VOL_TICK_INTERVAL_MS) {
    st.lastVolTickMs = t;
    recordPriceTick(meta.volKey, price, t);
  }
}

function connect() {
  if (stopRequested || INDEX_IDS.length === 0) return;
  const headers = authHeaders('GET', KALSHI_WS_PATH);
  ws = new WebSocket(KALSHI_WS_URL, { headers });

  ws.on('open', () => {
    reconnectAttempts = 0;
    setFeedStatus(CF_SOURCE_TAG, { connected: true, lastError: null });
    ws.send(
      JSON.stringify({
        id: 2,
        cmd: 'subscribe',
        // ⛔ index_ids, NOT market_tickers — this channel rejects market_tickers.
        params: { channels: ['cfbenchmarks_value'], index_ids: INDEX_IDS },
      }),
    );
    console.log(`[cf] subscribed cfbenchmarks_value → ${INDEX_IDS.join(', ')}`);
  });

  ws.on('message', (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (parsed.type === 'cfbenchmarks_value') onValue(parsed);
    else if (parsed.type === 'error') {
      health.lastError = JSON.stringify(parsed).slice(0, 200);
      console.warn(`[cf] server error: ${health.lastError}`);
    }
  });

  ws.on('error', (err) => {
    health.lastError = err.message;
    setFeedStatus(CF_SOURCE_TAG, { connected: false, lastError: err.message });
  });

  ws.on('close', () => {
    setFeedStatus(CF_SOURCE_TAG, { connected: false, lastError: health.lastError ?? 'closed' });
    if (stopRequested) return;
    // Capped exponential backoff. The basket keeps every engine priced while this
    // is down, which is the whole reason the basket stays running.
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempts++, 5));
    reconnectTimer = setTimeout(connect, delay);
  });
}

export function startCfBenchmarks() {
  stopRequested = false;
  if (INDEX_IDS.length === 0) {
    console.log('[cf] CF_INDEX_IDS unset or off — CF Benchmarks feed disarmed, basket remains the only spot');
    setFeedStatus(CF_SOURCE_TAG, { connected: false, lastError: 'disarmed' });
    return;
  }
  setFeedStatus(CF_SOURCE_TAG, { connected: false, lastError: 'starting' });
  connect();
}

export function stopCfBenchmarks() {
  stopRequested = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    ws?.close();
  } catch {
    /* already gone */
  }
  ws = null;
}

/** True when the feed is armed at all. */
export function isCfArmed() {
  return INDEX_IDS.length > 0;
}

/**
 * Latest index observation, or null.
 *
 * ⛔ NEVER age-gates — callers do, exactly like getPrice() and getBrtiSpot().
 * Freshness is a property of the timestamp, and a reader that cannot see a stale
 * value cannot tell "stale" from "absent".
 */
export function getCfIndex(id = 'BRTI') {
  return latest.get(id) ?? null;
}

/** Mean of the raw prints at or after `sinceMs` — the running settlement average (E5). */
export function getRunningAvg(id, sinceMs) {
  const st = state.get(id);
  if (!st) return { avg: null, n: 0 };
  let sum = 0;
  let n = 0;
  for (const p of st.prints) {
    if (p.t >= sinceMs) {
      sum += p.price;
      n++;
    }
  }
  return { avg: n > 0 ? sum / n : null, n };
}

export function cfHealth() {
  const brti = latest.get('BRTI');
  return {
    armed: INDEX_IDS.length > 0,
    indexIds: INDEX_IDS,
    connected: ws?.readyState === WebSocket.OPEN,
    lastTickAt: brti ? new Date(brti.publishTimeMs).toISOString() : null,
    seqGaps: health.seqGaps,
    avg60sWindowSizeLast: health.lastAvgWindowSize,
    capturesWritten: health.capturesWritten,
    lastError: health.lastError,
  };
}

export const __test__ = { boundariesCrossed, onValue, latest, state, health };
