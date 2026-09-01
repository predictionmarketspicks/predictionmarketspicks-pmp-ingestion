// Unusual options activity / 0DTE flow detector.
//
// Polls the sidecar's /trades/recent endpoint every FLOW_INTERVAL_MS during
// US options market hours, aggregates by instrument, and flags:
//
//   - BLOCK     — single print ≥ BLOCK_SIZE_THRESHOLD contracts
//   - 0DTE_BURST — any 0DTE strike with ≥ ZERO_DTE_BURST_SIZE in the window
//   - VOL_SPIKE — instrument's window volume ≥ VOL_SPIKE_MULTIPLIER × the
//                  prior-window volume for the same instrument
//
// Posts an embed per alert to #bot-logs (Discord). Dedup via posted_alerts
// 30min cooldown keyed by (commodity, alert_type, instrument_id).
//
// Architecturally a peer of src/engine/silver|gold|oil — it's the same kind
// of "watch the live wire, decide if something is alert-worthy" engine, just
// reading trade prints instead of solving an IV smile.
//
// Differentiated because we hit OPRA sub-second — no other prediction-markets
// surface is alerting on commodity-ETF options flow at this latency.

import { setFeedStatus, recordTick, registerFeed } from '../observability/health.js';
import { filterAlreadyPostedKeys, recordPostedAlerts } from '../delivery/supabase.js';
// postBotLogEmbed import REMOVED with the per-event posts (§4.1). buildEmbed is
// kept and still exported — the heartbeat rollup and the tests use the shape,
// and deleting it would make restoring per-event posts a rewrite rather than a
// revert.
import { isOptionsMarketOpen } from '../feeds/massive.js';

const SIDECAR_HOST = process.env.DATABENTO_SIDECAR_HOST || '127.0.0.1';
const SIDECAR_PORT = process.env.DATABENTO_SIDECAR_PORT || '9090';

// Tunables — calibrate after first soak. Defaults are deliberately
// conservative so we don't flood #bot-logs on day 1.
const FLOW_INTERVAL_MS = Number(process.env.FLOW_INTERVAL_MS || 5 * 60 * 1000);
const FLOW_WINDOW_MS = Number(process.env.FLOW_WINDOW_MS || 5 * 60 * 1000);
const BLOCK_SIZE_THRESHOLD = Number(process.env.FLOW_BLOCK_SIZE || 100);
const ZERO_DTE_BURST_SIZE = Number(process.env.FLOW_0DTE_SIZE || 50);
const VOL_SPIKE_MULTIPLIER = Number(process.env.FLOW_SPIKE_MULT || 5);
const COOLDOWN_MS = 30 * 60 * 1000;
const UNDERLYINGS = ['SLV', 'GLD', 'USO', 'IBIT'];

const FEED_NAME = 'flow_alerts_engine';

let timer = null;
let stopRequested = false;
const lastWindowVolume = new Map(); // `${commodity}:${instrument_id}` → prior-window total

function commodityFor(underlying) {
  return { SLV: 'silver', GLD: 'gold', USO: 'oil', IBIT: 'bitcoin' }[underlying] ?? underlying.toLowerCase();
}

function daysToExpiry(expirationIso, nowMs = Date.now()) {
  if (!expirationIso) return null;
  const eMs = new Date(expirationIso + 'T20:00:00Z').getTime();
  if (!Number.isFinite(eMs)) return null;
  return Math.round((eMs - nowMs) / 86_400_000);
}

async function fetchTrades(underlying, sinceMs) {
  const url = `http://${SIDECAR_HOST}:${SIDECAR_PORT}/trades/recent/${underlying}?since_ms=${sinceMs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
  return res.json();
}

function aggregateByInstrument(trades) {
  const map = new Map();
  for (const t of trades) {
    const key = t.instrument_id;
    const entry = map.get(key) || {
      instrument_id: key,
      raw_symbol: t.raw_symbol,
      contract_type: t.contract_type,
      strike: t.strike,
      expiration: t.expiration,
      total_size: 0,
      max_print: 0,
      max_price: 0,
      print_count: 0,
    };
    entry.total_size += Number(t.size) || 0;
    entry.print_count += 1;
    if ((Number(t.size) || 0) > entry.max_print) {
      entry.max_print = Number(t.size);
      entry.max_price = Number(t.price) || 0;
    }
    map.set(key, entry);
  }
  return [...map.values()];
}

function classifyAlerts(commodity, aggregates) {
  const out = [];
  for (const a of aggregates) {
    const dte = daysToExpiry(a.expiration);
    const prevKey = `${commodity}:${a.instrument_id}`;
    const prevVol = lastWindowVolume.get(prevKey) || 0;
    lastWindowVolume.set(prevKey, a.total_size);

    // Tier 1 — block trade. One single fill at or above the threshold.
    if (a.max_print >= BLOCK_SIZE_THRESHOLD) {
      out.push({
        type: 'BLOCK',
        commodity,
        instrument_id: a.instrument_id,
        raw_symbol: a.raw_symbol,
        strike: a.strike,
        expiration: a.expiration,
        contract_type: a.contract_type,
        dte,
        size: a.max_print,
        price: a.max_price,
        total_window: a.total_size,
      });
      continue; // don't double-fire on the same instrument this tick
    }

    // Tier 2 — 0DTE burst. Same-day expiry getting a meaningful clip.
    if (dte != null && dte <= 0 && a.total_size >= ZERO_DTE_BURST_SIZE) {
      out.push({
        type: '0DTE_BURST',
        commodity,
        instrument_id: a.instrument_id,
        raw_symbol: a.raw_symbol,
        strike: a.strike,
        expiration: a.expiration,
        contract_type: a.contract_type,
        dte,
        size: a.total_size,
        price: a.max_price,
        total_window: a.total_size,
        print_count: a.print_count,
      });
      continue;
    }

    // Tier 3 — volume spike. Need a prior baseline (skip first tick on each
    // instrument), and prior must be non-trivial so a 0→5 contract bump
    // doesn't trip a 5x spike alert.
    if (prevVol >= 20 && a.total_size >= prevVol * VOL_SPIKE_MULTIPLIER) {
      out.push({
        type: 'VOL_SPIKE',
        commodity,
        instrument_id: a.instrument_id,
        raw_symbol: a.raw_symbol,
        strike: a.strike,
        expiration: a.expiration,
        contract_type: a.contract_type,
        dte,
        size: a.total_size,
        prev_size: prevVol,
        multiplier: a.total_size / prevVol,
        price: a.max_price,
      });
    }
  }
  return out;
}

function alertKey(a) {
  return `flow:${a.commodity}:${a.type}:${a.instrument_id}`;
}

function buildEmbed(a) {
  const direction = a.contract_type === 'call' ? '📈' : '📉';
  const strikeStr = a.strike != null ? `$${Number(a.strike).toFixed(2)}` : '?';
  const dteStr = a.dte != null ? (a.dte <= 0 ? '0DTE' : `${a.dte}d`) : '';
  let title;
  let detail;
  if (a.type === 'BLOCK') {
    title = `${direction} BLOCK on ${a.commodity.toUpperCase()} — ${a.size}× ${a.contract_type} ${strikeStr} ${dteStr}`;
    detail = `Single print: **${a.size}** contracts @ $${(a.price || 0).toFixed(2)}. Window total ${a.total_window} contracts.`;
  } else if (a.type === '0DTE_BURST') {
    title = `${direction} 0DTE burst on ${a.commodity.toUpperCase()} — ${a.contract_type} ${strikeStr}`;
    detail = `**${a.size}** contracts traded in ${FLOW_WINDOW_MS / 60_000}m on a same-day expiry. ${a.print_count} prints, max ${(a.price || 0).toFixed(2)}.`;
  } else if (a.type === 'VOL_SPIKE') {
    title = `${direction} Volume spike on ${a.commodity.toUpperCase()} — ${a.contract_type} ${strikeStr} ${dteStr}`;
    detail = `**${a.size}** contracts in the last ${FLOW_WINDOW_MS / 60_000}m vs ${a.prev_size} prior window (${a.multiplier.toFixed(1)}×).`;
  }
  return {
    title,
    description: detail,
    color: a.contract_type === 'call' ? 0x1f7a3f : 0xb53a3a,
    footer: { text: `instrument ${a.instrument_id} • ${a.raw_symbol}` },
  };
}

async function tick() {
  if (stopRequested) return;
  if (!isOptionsMarketOpen()) {
    // Off-hours: still tick the heartbeat so /health sees an alive feed,
    // but skip the poll entirely. No fresh prints, nothing to alert on.
    recordTick(FEED_NAME);
    return;
  }
  const sinceMs = Date.now() - FLOW_WINDOW_MS;

  // First collect candidate alerts across every underlying, then run one
  // batched dedup query against posted_alerts. Cuts the Supabase round-trips
  // per tick from O(alerts) to O(1).
  const candidates = [];
  for (const underlying of UNDERLYINGS) {
    try {
      const resp = await fetchTrades(underlying, sinceMs);
      const aggregates = aggregateByInstrument(resp.trades || []);
      const commodity = commodityFor(underlying);
      candidates.push(...classifyAlerts(commodity, aggregates));
    } catch (err) {
      console.warn(`[flow-alerts] ${underlying} poll failed: ${err?.message || err}`);
      setFeedStatus(FEED_NAME, { connected: false, lastError: (err?.message || String(err)).slice(0, 240) });
      continue;
    }
  }

  let posted = 0;
  if (candidates.length > 0) {
    const keys = candidates.map(alertKey);
    const alreadyPosted = await filterAlreadyPostedKeys(keys, { hoursWindow: COOLDOWN_MS / 3600_000 });
    const fresh = candidates.filter((a) => !alreadyPosted.has(alertKey(a)));
    const nowIso = new Date().toISOString();
    const recordRows = [];
    for (const a of fresh) {
      // ⛔ NO PER-EVENT DISCORD POST (DISCORD_CONVERSION_MACHINE §4.1).
      //
      // This loop put 96 flow:* embeds into #bot-logs in 48 hours and made the
      // ops bus unreadable — errors, feed-health, sweep summaries and freshness
      // alarms were drowning in telemetry. #bot-logs is where you look when
      // something is broken, so volume there has a real cost.
      //
      // The DB write stays: posted_alerts keeps every flow:* key, the cooldown
      // dedup above still applies, and discord-heartbeat (jobid 69, 22:00) rolls
      // the day up into ONE line. Nothing is lost, it is just not narrated
      // event by event.
      posted += 1;
      recordRows.push({
          alert_key: alertKey(a),
          posted_at: nowIso,
          alert_type: 'flow',
          title: `${a.type} ${a.commodity} ${a.contract_type} ${a.strike}`,
          platform: 'kalshi',
          scanner_data: {
            type: a.type,
            commodity: a.commodity,
            instrument_id: a.instrument_id,
            raw_symbol: a.raw_symbol,
            strike: a.strike,
            expiration: a.expiration,
            contract_type: a.contract_type,
            dte: a.dte,
            size: a.size,
            price: a.price,
          },
        });
    }
    if (recordRows.length > 0) {
      await recordPostedAlerts(recordRows);
    }
  }

  setFeedStatus(FEED_NAME, { connected: true, lastError: null });
  recordTick(FEED_NAME);
  if (posted > 0) {
    console.log(`[flow-alerts] recorded ${posted}/${candidates.length} alert(s) (Discord silenced — rolled up by discord-heartbeat)`);
  }
}

function schedule() {
  if (stopRequested) return;
  timer = setTimeout(async () => {
    await tick().catch((err) => console.error('[flow-alerts] tick failed', err?.stack || err));
    schedule();
  }, FLOW_INTERVAL_MS);
}

export function startFlowAlerts() {
  registerFeed(FEED_NAME);
  stopRequested = false;
  console.log(`[flow-alerts] starting (interval=${FLOW_INTERVAL_MS}ms, window=${FLOW_WINDOW_MS}ms, block≥${BLOCK_SIZE_THRESHOLD}, 0DTE≥${ZERO_DTE_BURST_SIZE}, spike≥${VOL_SPIKE_MULTIPLIER}×)`);
  // First tick immediately so the engine doesn't have a 5min dead window on boot.
  tick().catch((err) => console.error('[flow-alerts] first tick failed', err?.stack || err));
  schedule();
}

export function stopFlowAlerts() {
  stopRequested = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

// Test seam.
export const __test__ = {
  aggregateByInstrument,
  classifyAlerts,
  alertKey,
  buildEmbed,
  _lastWindowVolume: lastWindowVolume,
};
