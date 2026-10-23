// Variance-time clock for the daily metals ladders (gold, silver).
// Site repo: handoffs/METALS_EDGE_VARIANCE_CLOCK_2026-10-23.md PART 2.
//
// The engine prices every strike with one annualized σ spread over CALENDAR time
// (options.js yearFraction). Gold's realized vol 8–10 AM ET is ~3.5× its vol
// 4–5 PM ET, the contract settles at 5 PM ET and the engine runs 9:35 AM–4 PM ET,
// so nearly every horizon it prices runs through the quiet end of the day and
// the distribution comes out too wide (fat tails → phantom NO edges on 80¢
// favorites, phantom YES edges on sub-20¢ longshots).
//
// The σ LEVEL is right (pooled 23-hour realized σ matches sigma_blend within a
// point); only its distribution across the day is wrong. So the fix keeps σ and
// changes the clock: T_eff = Σ_remaining w(hour)·Δt / year, where the 24 ET-hour
// weights average 1 over the hours the market trades and closed hours weigh 0.
//
// Pure. No I/O. Never throws from the public functions: anything it cannot
// handle fails OPEN to calendar time (= the engine's behaviour before the clock).

import { yearFraction } from './options.js';

export const CLOCK_METHOD = 'variance_clock_v1';
/** A profile older than this is not trusted (the weekly refit missed twice). */
export const CLOCK_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
/** Shrink-toward-flat strength until the full window exists: λ = H / (H + 240). */
export const SHRINK_K_HOURS = 240;
export const FULL_WINDOW_MS = 8 * 7 * 24 * 3600 * 1000;
/** Below this many returns an hour's σ² is not estimated; it keeps weight 1. */
export const MIN_RETURNS_PER_HOUR = 20;
/** The COMEX/Globex metals week, in ET. Holidays are not modelled. */
export const CALENDAR_METALS = 'metals_globex';
export const CALENDAR_NONE = 'none';

const YEAR_S = 365 * 24 * 3600;
const HOUR_MS = 3600 * 1000;
const MAX_SEGMENTS = 400 * 24; // beyond ~400 days, fail open rather than loop

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: 'numeric',
  hourCycle: 'h23',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** ET weekday (0 = Sunday) and hour (0–23) of an instant. */
export function etDowHour(ms) {
  const parts = ET.formatToParts(new Date(ms));
  let dow = 0;
  let hour = 0;
  for (const p of parts) {
    if (p.type === 'weekday') dow = DOW[p.value];
    else if (p.type === 'hour') hour = Number(p.value) % 24;
  }
  return { dow, hour };
}

/**
 * Is the metals market trading in this ET hour? Saturday: closed. Sunday: opens
 * 18:00. Friday: closes 17:00. Mon–Thu: the 17:00–18:00 daily break.
 */
export function metalsOpen(dow, hour) {
  if (dow === 6) return false;
  if (dow === 0) return hour >= 18;
  if (dow === 5) return hour < 17;
  return hour !== 17;
}

/** The identity profile: every hour of every day weighs 1 ⇒ T_eff ≡ yearFraction. */
export function flatProfile() {
  return { hours_et: Array(24).fill(1), calendar: CALENDAR_NONE };
}

/**
 * 15-minute log returns from spot marks, with the same filters as the handoff's
 * PART 0.3 SQL: consecutive marks 850–950 s apart, |r| < 3%. Each return is
 * stamped with its END mark's time (the hour the move happened in).
 */
export function returnsFromMarks(marks) {
  const sorted = [...(marks ?? [])]
    .map((m) => ({ t: Date.parse(m.mark_at), s: Number(m.spot) }))
    .filter((m) => Number.isFinite(m.t) && m.s > 0)
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    const dt = (sorted[i].t - sorted[i - 1].t) / 1000;
    if (dt < 850 || dt > 950) continue;
    const r = Math.log(sorted[i].s / sorted[i - 1].s);
    if (!Number.isFinite(r) || Math.abs(r) >= 0.03) continue;
    out.push({ t: sorted[i].t, r });
  }
  return out;
}

/**
 * Fit the 24 ET-hour variance weights. `returns` = [{ t: ms, r: log return }].
 * w_h = σ²_h / mean(σ²) over the trading hours, pooled over a trailing 8-week
 * window; closed hours weigh 0 (the calendar zeroes them at integration time and
 * the 17:00 slot is stored as 0). Until 8 weeks of data exist the raw weights
 * are shrunk toward flat with λ = H / (H + 240), H = distinct trading hours
 * observed, so the first fits cannot be violent. Throws on unusable input —
 * the fit script reports it; the engine never calls this.
 */
export function fitIntradayProfile(returns, { commodity = null } = {}) {
  const usable = (returns ?? []).filter((x) => Number.isFinite(x?.t) && Number.isFinite(x?.r));
  if (usable.length === 0) throw new Error(`fitIntradayProfile(${commodity}): no returns`);
  const windowTo = usable.reduce((m, x) => Math.max(m, x.t), -Infinity);
  const earliest = usable.reduce((m, x) => Math.min(m, x.t), Infinity);
  const windowFrom = Math.max(earliest, windowTo - FULL_WINDOW_MS);

  const ss = Array(24).fill(0);
  const n = Array(24).fill(0);
  const hoursSeen = new Set();
  for (const x of usable) {
    if (x.t < windowFrom) continue;
    const { dow, hour } = etDowHour(x.t);
    if (!metalsOpen(dow, hour)) continue;
    ss[hour] += x.r * x.r;
    n[hour] += 1;
    hoursSeen.add(Math.floor(x.t / HOUR_MS));
  }
  const tradingHours = [...Array(24).keys()].filter((h) => h !== 17);
  const estimated = tradingHours.filter((h) => n[h] >= MIN_RETURNS_PER_HOUR);
  if (estimated.length < 12) {
    throw new Error(`fitIntradayProfile(${commodity}): only ${estimated.length} hours with ≥${MIN_RETURNS_PER_HOUR} returns`);
  }
  const var_ = Array(24).fill(null);
  for (const h of estimated) var_[h] = ss[h] / n[h];
  const meanVar = estimated.reduce((a, h) => a + var_[h], 0) / estimated.length;
  if (!(meanVar > 0)) throw new Error(`fitIntradayProfile(${commodity}): zero variance`);

  const fullWindow = windowTo - earliest >= FULL_WINDOW_MS;
  const H = hoursSeen.size;
  const lambda = fullWindow ? 1 : H / (H + SHRINK_K_HOURS);

  const raw = Array(24).fill(1);
  for (const h of estimated) raw[h] = var_[h] / meanVar;
  raw[17] = 0;
  const w = raw.map((x, h) => (h === 17 ? 0 : lambda * x + (1 - lambda)));
  // Re-centre so the trading hours average exactly 1 (σ level unchanged).
  const meanW = tradingHours.reduce((a, h) => a + w[h], 0) / tradingHours.length;
  const hours = w.map((x) => x / meanW);

  const tradingDays = new Set(
    usable.filter((x) => x.t >= windowFrom).map((x) => new Date(x.t - 5 * HOUR_MS).toISOString().slice(0, 10)),
  );
  return {
    hours_et: hours.map((x) => Math.round(x * 1e6) / 1e6),
    calendar: CALENDAR_METALS,
    window_from: new Date(windowFrom).toISOString(),
    window_to: new Date(windowTo).toISOString(),
    n_returns: tradingHours.reduce((a, h) => a + n[h], 0),
    n_per_hour: n,
    hours_observed: H,
    lambda: Math.round(lambda * 1e6) / 1e6,
    raw_sigma_annual: var_.map((v) => (v == null ? null : Math.round(Math.sqrt(v * 8760 * 4) * 1e4) / 1e4)),
    n_trading_days: tradingDays.size,
  };
}

/** Structural validity of a profile's knots. Pure, never throws. */
export function profileProblem(profile) {
  if (!profile || typeof profile !== 'object') return 'no_profile';
  const w = profile.hours_et;
  if (!Array.isArray(w) || w.length !== 24) return 'bad_shape';
  for (const x of w) if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return 'non_finite_weight';
  if (profile.calendar !== CALENDAR_METALS && profile.calendar !== CALENDAR_NONE) return 'unknown_calendar';
  if (!w.some((x) => x > 0)) return 'all_zero';
  return null;
}

/**
 * Integrate the profile from now to close. Flat profile ⇒ exactly yearFraction.
 * Fail-open: an unusable profile returns calendar time (never throws).
 */
export function effectiveYearFraction(nowMs, closeMs, profile) {
  const calendarT = yearFraction(nowMs / 1000, closeMs / 1000);
  if (profileProblem(profile) != null) return calendarT;
  if (!Number.isFinite(nowMs) || !Number.isFinite(closeMs) || closeMs <= nowMs) return 0;
  if ((closeMs - nowMs) / HOUR_MS > MAX_SEGMENTS) return calendarT;
  const w = profile.hours_et;
  const gated = profile.calendar === CALENDAR_METALS;
  let acc = 0;
  let t = nowMs;
  while (t < closeMs) {
    // ET is a whole-hour offset from UTC, so ET hour boundaries are UTC hour boundaries.
    const segEnd = Math.min(closeMs, (Math.floor(t / HOUR_MS) + 1) * HOUR_MS);
    const { dow, hour } = etDowHour(t);
    const weight = gated && !metalsOpen(dow, hour) ? 0 : w[hour];
    acc += weight * (segEnd - t);
    t = segEnd;
  }
  return Math.max(0, acc / 1000 / YEAR_S);
}

// Fail-open log: once per (commodity, reason) change, not every tick.
const _lastReason = new Map();
function noteFailOpen(commodity, reason, log) {
  const key = commodity ?? '?';
  if (_lastReason.get(key) === reason) return;
  _lastReason.set(key, reason);
  if (reason != null) log(`[clock] fail-open ${key}: ${reason} — calendar time`);
}

/**
 * Decide whether a stored edge_calibration_maps row may drive the clock right
 * now. Returns its knots (the profile) or null (→ calendar time, prob_clock
 * null). Never throws.
 */
export function resolveVarianceClock(row, { nowMs = Date.now(), commodity = null, log = console.warn } = {}) {
  try {
    let reason = null;
    if (!row) reason = 'no_clock_row';
    else if (row.method !== CLOCK_METHOD) reason = `unknown_method:${row.method}`;
    else if (!(nowMs - Date.parse(row.fit_at) <= CLOCK_MAX_AGE_MS)) reason = 'stale_profile';
    else reason = profileProblem(row.knots);
    noteFailOpen(commodity ?? row?.commodity, reason, log);
    return reason == null ? row.knots : null;
  } catch {
    return null;
  }
}

export function __resetClockLogForTest() {
  _lastReason.clear();
}
