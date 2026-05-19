// Volatility blender — combines ETF implied vol with realized vol.
//
// Why blend: the legacy engine fed raw ETF IV (e.g. GLD's options-implied vol)
// straight into Black-Scholes. ETF wrapper effects make GLD IV run ~8pp hot
// vs realized gold spot vol over the 2024-2026 backtest. Blending pulls IV
// toward the empirically-observed σ.
//
// Per-commodity weights are starting points from the backtest evidence
// (see handoffs/COMMODITY_EDGE_V2_PHYSICAL_MEASURE_REBUILD_2026-05-19.md):
//   silver:  70/30 IV/RV  — IV ~accurate (47.7% vs 50.6% realized)
//   gold:    40/60 IV/RV  — IV +8pp too high (32.0% vs 23.6% realized)
//   oil:     70/30 IV/RV  — IV spot-on (42.6% vs 42.2% realized)
//   bitcoin: 80/20 IV/RV  — IBIT IV is clean
//
// These are Phase 1 defaults. Phase 4 calibration may retune from live data.

import { fetchYahooDailyLookback, sortedClosesFromMap } from '../feeds/yahoo-spot.js';

const COMMODITY_CFG = {
  silver: { etf: 'SLV', w_iv: 0.70, w_rv: 0.30 },
  gold: { etf: 'GLD', w_iv: 0.40, w_rv: 0.60 },
  oil: { etf: 'USO', w_iv: 0.70, w_rv: 0.30 },
  bitcoin: { etf: 'IBIT', w_iv: 0.80, w_rv: 0.20 },
  copper: { etf: 'CPER', w_iv: 0.70, w_rv: 0.30 },
};

const RV_LOOKBACK_CALENDAR_DAYS = 35; // ~20 trading days
const MIN_TRADING_DAYS = 10;
const TRADING_DAYS_PER_YEAR = 252;
const CACHE_TTL_MS = 15 * 60 * 1000;

const _rvCache = new Map(); // commodity → { rv, ts, nDays }

// 20-day rolling stddev of daily log-returns, annualized √252.
// Returns null when fewer than MIN_TRADING_DAYS samples available.
function realizedVolFromCloses(sorted, windowDays = 20) {
  if (!sorted || sorted.length < MIN_TRADING_DAYS + 1) return null;
  const tail = sorted.slice(-Math.min(sorted.length, windowDays + 1));
  const rets = [];
  for (let i = 1; i < tail.length; i++) {
    const a = tail[i - 1].close;
    const b = tail[i].close;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < MIN_TRADING_DAYS) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  let varSum = 0;
  for (const r of rets) varSum += (r - mean) ** 2;
  const variance = varSum / (rets.length - 1);
  const dailyVol = Math.sqrt(variance);
  const annualized = dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR);
  if (!Number.isFinite(annualized) || annualized <= 0) return null;
  return { rv: annualized, nDays: rets.length };
}

async function fetchRealizedVol(commodity, { now = new Date() } = {}) {
  const cached = _rvCache.get(commodity);
  if (cached && now.getTime() - cached.ts < CACHE_TTL_MS) return cached;

  const cfg = COMMODITY_CFG[commodity];
  if (!cfg) return null;

  try {
    const map = await fetchYahooDailyLookback(cfg.etf, RV_LOOKBACK_CALENDAR_DAYS);
    const sorted = sortedClosesFromMap(map);
    const r = realizedVolFromCloses(sorted, 20);
    if (!r) return null;
    const out = { rv: r.rv, nDays: r.nDays, ts: now.getTime() };
    _rvCache.set(commodity, out);
    return out;
  } catch (err) {
    console.warn(
      `[vol] ${commodity}: realized vol fetch failed (${err?.message || err}) — using IV only`,
    );
    return null;
  }
}

// Synchronous wrapper that consumes the already-warmed cache. Returns the
// blended σ object. Falls back to IV-only when RV unavailable. iv must be
// a positive number; null/0 returns null.
function blendFromCache(iv, commodity) {
  if (iv == null || !(iv > 0)) return null;
  const cfg = COMMODITY_CFG[commodity];
  if (!cfg) {
    return {
      sigma_iv: iv,
      sigma_rv20: null,
      sigma_blend: iv,
      weights: { iv: 1, rv: 0 },
      source: 'iv_only',
    };
  }
  const cached = _rvCache.get(commodity);
  if (!cached) {
    return {
      sigma_iv: iv,
      sigma_rv20: null,
      sigma_blend: iv,
      weights: { iv: 1, rv: 0 },
      source: 'iv_only',
    };
  }
  const sigma_blend = cfg.w_iv * iv + cfg.w_rv * cached.rv;
  return {
    sigma_iv: iv,
    sigma_rv20: cached.rv,
    sigma_blend,
    weights: { iv: cfg.w_iv, rv: cfg.w_rv },
    source: 'iv_realized_blend',
  };
}

// Warm the realized-vol cache for a commodity. Engine should call this once
// per snapshot before iterating strikes — the per-strike estimateVol()
// reads synchronously from cache.
export async function warmVolCache(commodity, opts = {}) {
  return fetchRealizedVol(commodity, opts);
}

// Synchronous σ blender — call after warmVolCache(). For per-strike IV.
export function estimateVol(iv, commodity) {
  return blendFromCache(iv, commodity);
}

// Async one-shot — useful for scripts/tests. Warms cache, then blends.
export async function estimateVolAsync(iv, commodity, opts = {}) {
  await warmVolCache(commodity, opts);
  return blendFromCache(iv, commodity);
}

export const __test__ = {
  realizedVolFromCloses,
  COMMODITY_CFG,
  _rvCache,
  blendFromCache,
};
