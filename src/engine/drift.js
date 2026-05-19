// Physical-measure drift estimator.
//
// The legacy commodity engines feed (r − q) ≈ 4.5% into Black-Scholes when
// asking "what is P(spot > strike at T)?". That is the risk-neutral drift —
// a pricing artifact, not a forecast. The 2024-2026 backtest showed the
// engines biased low by 5-10pp at near-the-money upside strikes, the textbook
// missing-drift signature.
//
// This module returns μ_physical: a real-world drift estimate consumed by
// probAboveStrikePhysical() in src/engine/options.js. Phase 1 ships with
// realized-only blending. Phase 2 will add a futures-curve slope component
// for SLV/GLD/USO (SI=F/GC=F/CL=F on Yahoo).
//
// Bayesian blend:
//   μ = w_realized × μ_realized_60d + w_prior × μ_long_run_prior
//
// Caps:  μ ∈ [-2.0, +2.0] annualized — defends against blowoff/crash artifacts.
// Cache: per-commodity, 15min TTL. Yahoo's chart endpoint is cheap but no
//        reason to hit it on every snapshot tick across 4 commodities.

import { fetchYahooDailyLookback, sortedClosesFromMap } from '../feeds/yahoo-spot.js';

// Per-commodity static config. ETF used for the realized-drift lookback
// (matches what the engine prices off — same wrapper effects either way).
//
// long_run_prior is a hand-set anchor (5yr ish) — pulls the blend toward
// reasonable in low-data regimes. Keep modest; don't fight a strong realized
// signal with a stale prior.
const COMMODITY_CFG = {
  silver: { etf: 'SLV', long_run_prior: 0.06 },
  gold: { etf: 'GLD', long_run_prior: 0.06 },
  oil: { etf: 'USO', long_run_prior: 0.03 },
  bitcoin: { etf: 'IBIT', long_run_prior: 0.30 },
  copper: { etf: 'CPER', long_run_prior: 0.04 },
};

// Bayesian blend weights. Realized dominates once we have 60 trading days;
// prior is the catch when the realized series is short or absent.
const W_REALIZED = 0.80;
const W_PRIOR = 0.20;

const MU_CAP = 2.0; // ±200% annualized hard cap
const LOOKBACK_CALENDAR_DAYS = 90; // 90 calendar days → ~60 trading days
const TRADING_DAYS_PER_YEAR = 252;
const CACHE_TTL_MS = 15 * 60 * 1000;

const _cache = new Map(); // commodity → { result, ts }

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

// Annualized log-return drift over the available trading days. Returns
// { mu, nDays } or null when fewer than MIN_TRADING_DAYS samples are usable.
const MIN_TRADING_DAYS = 20;

function realizedDriftFromCloses(sorted) {
  if (!sorted || sorted.length < MIN_TRADING_DAYS + 1) return null;
  // Use last 60 trading days if we have them; otherwise use what we've got.
  const window = sorted.slice(-Math.min(sorted.length, 61));
  const first = window[0].close;
  const last = window[window.length - 1].close;
  if (!(first > 0) || !(last > 0)) return null;
  const nDays = window.length - 1;
  // Annualized log-return.
  const mu = (Math.log(last / first) / nDays) * TRADING_DAYS_PER_YEAR;
  if (!Number.isFinite(mu)) return null;
  return { mu, nDays };
}

// Compute μ for the given commodity. Cached 15min per commodity.
// Returns the structured object documented in the handoff.
export async function estimateDrift(commodity, { now = new Date() } = {}) {
  const cfg = COMMODITY_CFG[commodity];
  if (!cfg) {
    return {
      commodity,
      mu: 0,
      source: 'fallback_zero',
      confidence: 'low',
      components: { realized_60d: null, futures_curve: null, long_run_prior: 0 },
      as_of: now.toISOString(),
    };
  }

  const cached = _cache.get(commodity);
  if (cached && now.getTime() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  const components = {
    realized_60d: null,
    futures_curve: null, // Phase 2: SI=F/GC=F/CL=F basis
    long_run_prior: cfg.long_run_prior,
  };

  let realized = null;
  try {
    const map = await fetchYahooDailyLookback(cfg.etf, LOOKBACK_CALENDAR_DAYS);
    const sorted = sortedClosesFromMap(map);
    realized = realizedDriftFromCloses(sorted);
    if (realized) components.realized_60d = realized.mu;
  } catch (err) {
    console.warn(
      `[drift] ${commodity}: realized fetch failed (${err?.message || err}) — falling back to prior`,
    );
  }

  let mu;
  let source;
  let confidence;
  if (realized != null) {
    mu = W_REALIZED * realized.mu + W_PRIOR * cfg.long_run_prior;
    source = 'realized_60d';
    // Confidence ladder by sample size. 60d sweet spot, 30-59d ok, <30 weak.
    if (realized.nDays >= 60) confidence = 'high';
    else if (realized.nDays >= 30) confidence = 'medium';
    else confidence = 'low';
  } else {
    mu = cfg.long_run_prior;
    source = 'fallback_prior';
    confidence = 'low';
  }

  mu = clamp(mu, -MU_CAP, MU_CAP);

  const result = {
    commodity,
    mu,
    source,
    confidence,
    components,
    as_of: now.toISOString(),
  };

  _cache.set(commodity, { result, ts: now.getTime() });
  return result;
}

export const __test__ = {
  realizedDriftFromCloses,
  COMMODITY_CFG,
  W_REALIZED,
  W_PRIOR,
  MU_CAP,
  _cache,
};
