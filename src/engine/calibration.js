// Edge calibration maps — score the model against our own settled record.
// handoffs/BITCOIN_EDGE_V21_CALIBRATED_RELAUNCH_2026-08-05.md §4
//
// The V2.1 incident was a model that claimed 0.794 while the market said 0.498
// and reality said 0.481, for a week, with nothing in the loop able to notice.
// This is that missing feedback: a map fitted weekly on settled picks, stored
// on every row so it can be scored BEFORE it is trusted, and promoted to
// decision-making only when it demonstrably beats both the raw model and the
// market's own Brier on out-of-sample data.
//
// Fail-open by construction: no map, an unreadable table, an unknown method or
// a non-finite result all degrade to "no calibration" and the engine keeps
// running on prob_physical exactly as it does today.

import { getClient } from '../delivery/supabase.js';

// Keep outputs strictly interior. A degenerate 0 or 1 is not a probability the
// rest of the system can use — the bot's modelProbOf and the alert tier ceiling
// both test interiority — and logit(0/1) is infinite.
const CLIP = 1e-4;
const LOGIT_EPS = 1e-6;

export function logit(p) {
  const q = Math.min(1 - LOGIT_EPS, Math.max(LOGIT_EPS, p));
  return Math.log(q / (1 - q));
}

// Overflow-safe on both tails.
export function sigmoid(z) {
  if (!Number.isFinite(z)) return null;
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

// Apply a fitted map to a model probability. Pure. Returns null (= "no
// opinion", caller keeps the raw prob) for anything it cannot handle.
export function applyCalibration(map, p) {
  if (!map) return null;
  // Unknown method must NOT silently pass the input through as if calibrated —
  // that would lift the alert ceiling on an uncalibrated number.
  if (map.method !== 'platt_pooled') return null;
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  const a = Number(map.knots?.a);
  const b = Number(map.knots?.b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const out = sigmoid(a * logit(n) + b);
  if (out == null || !Number.isFinite(out)) return null;
  return Math.min(1 - CLIP, Math.max(CLIP, out));
}

// ---------------------------------------------------------------------------
// Map cache. One map GOVERNS a commodity at a time.
// ---------------------------------------------------------------------------
// Selection is active-first, then most-recent-shadow — NOT simply "latest".
// The weekly refit writes a new shadow row; if selection were "latest", that
// write would silently displace a promoted active map and quietly turn
// calibration off. Active-first makes a refit inert until it is promoted.
//
// Exactly one map per row means calibrated_prob, fused_edge_pp, the tier and
// the alert all rest on one basis — the 7/27 modelProbOf lesson: never let two
// layers disagree about which probability is the real one.

let _maps = new Map();
let _lastRefreshMs = 0;
let _lastError = null;

function pickGoverning(rows) {
  const active = rows.find((r) => r.active === true);
  if (active) return active;
  // rows arrive newest-first
  return rows[0] ?? null;
}

export async function refreshCalibrationMaps() {
  let sb;
  try {
    sb = getClient();
  } catch (err) {
    _lastError = err.message;
    return { ok: false, error: err.message };
  }
  const { data, error } = await sb
    .from('edge_calibration_maps')
    .select('id, commodity, method, knots, active, shadow, fit_at, n_samples, n_events')
    .order('fit_at', { ascending: false });

  if (error) {
    // Fail open: keep whatever we already had rather than dropping calibration
    // mid-session on a transient read failure.
    _lastError = error.message;
    console.warn('[calibration] refresh failed, keeping previous maps:', error.message);
    return { ok: false, error: error.message };
  }

  const byCommodity = new Map();
  for (const row of data ?? []) {
    if (!byCommodity.has(row.commodity)) byCommodity.set(row.commodity, []);
    byCommodity.get(row.commodity).push(row);
  }
  const next = new Map();
  for (const [commodity, rows] of byCommodity) {
    const governing = pickGoverning(rows);
    if (governing) next.set(commodity, governing);
  }
  _maps = next;
  _lastRefreshMs = Date.now();
  _lastError = null;

  const summary = Array.from(_maps.values()).map(
    (m) => `${m.commodity}#${m.id}${m.active ? ' ACTIVE' : ' shadow'}`,
  );
  console.log(
    `[calibration] loaded ${_maps.size} map(s)${summary.length ? `: ${summary.join(', ')}` : ''}`,
  );
  return { ok: true, count: _maps.size };
}

export function getCalibrationMap(commodity) {
  if (!commodity) return null;
  return _maps.get(String(commodity).toLowerCase()) ?? null;
}

// Is calibration actually DRIVING decisions for this commodity? This is the
// signal the alert tier ceiling keys on. Presence of a calibrated_prob is NOT
// the same question: shadow rows carry one while decisions still run on the
// raw model, and lifting the ceiling then would resume STRONG alerts on
// uncalibrated edges — the exact failure the ceiling exists to prevent.
export function isCalibrationActive(commodity) {
  return getCalibrationMap(commodity)?.active === true;
}

export function calibrationStatus() {
  return {
    count: _maps.size,
    lastRefreshMs: _lastRefreshMs,
    lastError: _lastError,
    maps: Array.from(_maps.values()).map((m) => ({
      id: m.id,
      commodity: m.commodity,
      method: m.method,
      active: m.active,
      shadow: m.shadow,
      n_samples: m.n_samples,
      n_events: m.n_events,
    })),
  };
}

// Test seam only — lets unit tests install a map without a database.
export function __setMapsForTest(entries) {
  _maps = new Map(entries);
}
