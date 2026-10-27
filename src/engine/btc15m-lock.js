// R-AVG-LOCK v1 — the final-minute lane on KXBTC15M. PAPER ONLY.
//
// Site-repo spec: handoffs/FINAL_MINUTE_LANE_AND_5MIN_HUB_2026-10-27.md §2.3–2.4.
// Migration: supabase/migrations/20261027140000_btc15m_avg_lock_v1.sql (site repo).
//
// WHY. KXBTC15M settles on A = the simple average of the 60 one-second CF Benchmarks BRTI
// prints in the final minute. With r seconds left inside that minute, (60 − r)/60 of A is
// already fixed, so the outcome's uncertainty shrinks with r^1.5, not r^0.5:
//   E[A]  = ((60 − r)·locked + r·BRTI_now) / 60
//   sd[A] = (r/60) · σ · √(r/3)        σ = per-second sd (price units), from 5-s log returns
//                                         between 6:00 and 1:00 before the close
//   z     = (E[A] − strike) / sd[A]   P(YES) = Φ(z)
//
// WHAT THIS MODULE DOES. At r = 50, 40, 30, 20, 10 s before each close it computes z from
// the in-flight cfbenchmarks_value prints and writes ONE btc15m_lock_obs row: z, the locked
// share, Kalshi's top of book and the index print's age. The trigger (favorite band, fee,
// edge line), the fill rules and the grading all live in the database
// (grade_btc15m_paper_lanes, hourly), so this module holds no thresholds and places nothing.
//
// ⛔ OPRA-CLASS INPUTS. Raw index prints and the running average price the model; they are
// NEVER stored, logged or published. z and the locked share are the only outputs.
//
// Kill switch: BTC15M_LOCK_ENABLED=0.

import { getCfIndex, getIndexPrints, isCfArmed } from '../feeds/cfbenchmarks.js';
import { normCdf } from './options.js';

export const MODEL_VERSION = 'v1';
export const CHECKPOINTS_S = [50, 40, 30, 20, 10];
const AVG_WINDOW_MS = 60_000;
/** σ window: 6:00 → 1:00 before the close, sampled on a 5-s grid. */
const SIGMA_FROM_MS = 360_000;
const SIGMA_TO_MS = 60_000;
const SIGMA_STEP_MS = 5_000;
/** At least half of the 60 five-second returns must exist for a σ read. */
const SIGMA_MIN_RETURNS = 30;
/** An index print older than this at the decision is not a live read → z null. */
export const MAX_INDEX_AGE_MS = 5_000;
const Z_CLAMP = 8;
const KALSHI_API_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

export const lockEnabled = () => process.env.BTC15M_LOCK_ENABLED !== '0';

// ── pure helpers (exported for tests) ─────────────────────────────────────────

/**
 * Which checkpoint (seconds) a sample at `tauMs` before the close belongs to, or null.
 * A checkpoint c is due once τ ≤ c·1000 and still open while τ > (c − 5)·1000, so a sampler
 * that slips a second still fires it once; `done` holds the checkpoints already written.
 */
export function dueCheckpoint(tauMs, done = new Set()) {
  for (const c of CHECKPOINTS_S) {
    if (done.has(c)) continue;
    if (tauMs <= c * 1000 && tauMs > (c - 5) * 1000) return c;
  }
  return null;
}

/**
 * Per-second σ in LOG-return units from prints on a 5-s grid over [close − 360 s, close − 60 s].
 * Each grid point takes the last print at or before it; returns between consecutive grid
 * points with both values present. Null when fewer than SIGMA_MIN_RETURNS returns exist.
 */
export function sigmaPerSecondLog(prints, closeMs) {
  const grid = [];
  let i = 0;
  let last = null;
  for (let g = closeMs - SIGMA_FROM_MS; g <= closeMs - SIGMA_TO_MS; g += SIGMA_STEP_MS) {
    while (i < prints.length && prints[i].t <= g) { last = prints[i]; i++; }
    // a grid value is only usable if its print is within one step of the grid point
    grid.push(last && g - last.t < SIGMA_STEP_MS ? last.price : null);
  }
  const rets = [];
  for (let k = 1; k < grid.length; k++) {
    if (grid[k] > 0 && grid[k - 1] > 0) rets.push(Math.log(grid[k] / grid[k - 1]));
  }
  if (rets.length < SIGMA_MIN_RETURNS) return null;
  const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
  const v = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) / Math.sqrt(SIGMA_STEP_MS / 1000);
}

/**
 * The lock model. Inputs are internal (OPRA-class); the return carries only derived values.
 * @returns {{ z: number|null, lockedShare: number, pYes: number|null }}
 */
export function lockModel({ lockedAvg, lockedPrints, indexNow, strike, sigmaLog, rSec }) {
  const lockedShare = Math.max(0, Math.min(1, (lockedPrints ?? 0) / 60));
  if (!(lockedAvg > 0) || !(indexNow > 0) || !(strike > 0) || !(sigmaLog > 0) || !(rSec > 0) || rSec > 60) {
    return { z: null, lockedShare, pYes: null };
  }
  const ea = ((60 - rSec) * lockedAvg + rSec * indexNow) / 60;
  const sd = (rSec / 60) * (sigmaLog * indexNow) * Math.sqrt(rSec / 3);
  if (!(sd > 0)) return { z: null, lockedShare, pYes: null };
  const z = Math.max(-Z_CLAMP, Math.min(Z_CLAMP, (ea - strike) / sd));
  return { z, lockedShare, pYes: normCdf(z) };
}

// ── strike cache (Kalshi REST, once per window) ───────────────────────────────

/** market_ticker → { strike: number|null, at: ms, inflight: Promise|null } */
const strikes = new Map();
const STRIKE_RETRY_MS = 5_000;

async function fetchStrike(market, timeoutMs = 4_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${KALSHI_API_BASE}/markets/${encodeURIComponent(market)}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'pmp-ingestion/1.0' },
    });
    if (!res.ok) throw new Error(`kalshi market ${market} HTTP ${res.status}`);
    const json = await res.json();
    const k = Number(json?.market?.floor_strike);
    return Number.isFinite(k) && k > 0 ? k : null;
  } finally {
    clearTimeout(t);
  }
}

/** Kick off (or reuse) the strike read for a window; returns the cached strike or null. */
export function strikeFor(market, nowMs = Date.now()) {
  let e = strikes.get(market);
  if (e?.strike != null) return e.strike;
  if (!e || (!e.inflight && nowMs - e.at >= STRIKE_RETRY_MS)) {
    e = { strike: null, at: nowMs, inflight: null };
    strikes.set(market, e);
    e.inflight = fetchStrike(market)
      .then((k) => { e.strike = k; })
      .catch((err) => { stats.lastError = `strike: ${String(err?.message || err).slice(0, 160)}`; })
      .finally(() => { e.inflight = null; e.at = Date.now(); });
  }
  return null;
}

export function forgetWindow(market) {
  strikes.delete(market);
  done.delete(market);
}

// ── per-window checkpoint state + stats ───────────────────────────────────────

/** market_ticker → Set of checkpoints already written. */
const done = new Map();
const stats = { rowsQueued: 0, zNull: 0, lastAt: null, lastReason: null, lastError: null };

/**
 * Called from kalshi-btc15m.js sampleOnce for the LIVE window every second. Returns a
 * btc15m_lock_obs row when a checkpoint is due (the caller buffers and flushes it), else null.
 * `top` is bookTop() of Kalshi's book in YES dollars.
 */
export function lockObservation({ market, event, closeMs }, top, observedMs) {
  if (!lockEnabled()) return null;
  const tau = closeMs - observedMs;
  if (tau <= 0 || tau > 120_000) return null;
  // Read the strike early (from 2:00 left) so it is cached before the first checkpoint.
  const strike = strikeFor(market, observedMs);
  let d = done.get(market);
  if (!d) { d = new Set(); done.set(market, d); }
  const cp = dueCheckpoint(tau, d);
  if (cp == null) return null;
  d.add(cp);

  const rSec = tau / 1000;
  const latest = isCfArmed() ? getCfIndex('BRTI') : null;
  const ageMs = latest ? Math.max(0, observedMs - latest.publishTimeMs) : null;
  const locked = getIndexPrints('BRTI', closeMs - AVG_WINDOW_MS, Math.min(observedMs + 1, closeMs));
  const lockedAvg = locked.length ? locked.reduce((a, p) => a + p.price, 0) / locked.length : null;
  const sigmaLog = sigmaPerSecondLog(getIndexPrints('BRTI', closeMs - SIGMA_FROM_MS - SIGMA_STEP_MS, closeMs - SIGMA_TO_MS + 1), closeMs);

  let reason = null;
  if (!latest) reason = 'no_index';
  else if (ageMs > MAX_INDEX_AGE_MS) reason = 'index_stale';
  else if (strike == null) reason = 'no_strike';
  else if (sigmaLog == null) reason = 'no_sigma';
  else if (lockedAvg == null) reason = 'no_locked_prints';

  const m = reason
    ? { z: null, lockedShare: Math.min(1, locked.length / 60) }
    : lockModel({ lockedAvg, lockedPrints: locked.length, indexNow: latest.price, strike, sigmaLog, rSec });
  if (!reason && m.z == null) reason = 'model_null';

  stats.rowsQueued++;
  if (m.z == null) stats.zNull++;
  stats.lastAt = new Date(observedMs).toISOString();
  stats.lastReason = reason;

  return {
    event_ticker: event,
    checkpoint_s: cp,
    model_version: MODEL_VERSION,
    observed_at: new Date(observedMs).toISOString(),
    window_close_at: new Date(closeMs).toISOString(),
    tau_ms: tau,
    locked_share: Number(m.lockedShare.toFixed(4)),
    z: m.z == null ? null : Number(m.z.toFixed(4)),
    yes_bid: top?.yesBid ?? null,
    yes_ask: top?.yesAsk ?? null,
    brti_age_ms: ageMs == null ? null : Math.round(ageMs),
  };
}

export function lockHealth() {
  return { enabled: lockEnabled(), model: MODEL_VERSION, ...stats, windowsTracked: done.size };
}

export const __test__ = { strikes, done, stats };
