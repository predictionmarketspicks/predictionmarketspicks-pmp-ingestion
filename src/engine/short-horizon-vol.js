// Short-horizon realized vol + drift from a Pyth tick buffer.
//
// Built for KXBTCD's intra-hour TWAP-settled binary markets, where the
// IBIT IV smile (calibrated to weekly+ expiries) doesn't carry BTC's
// sub-hour realized vol. Pyth polls at 10s; a 15-min lookback gives
// ~90 samples — enough for a stable σ_annual / μ_annual estimate
// without paying for a streaming feed.
//
// Module-level state is intentional: the engine process is long-lived
// (Fly), so the buffer survives across the 60s bitcoin snapshot cadence
// and warms across the typical 5-min cold-start window after a redeploy.
//
// Consumer contract (commodity-base.js → probAboveTwap):
//   - Call recordTick(commodity, price, tsMs) on every Pyth tick.
//   - Call getShortHorizonStats(commodity, opts) once per snapshot.
//   - On null result: fall back to the existing σ-blend × shortHorizonVolScale
//     path and tag rows quality_flag='cold_buffer'.

const BUFFER_CAPACITY = 600;          // ≈100 min at 10s Pyth cadence
const MIN_TICKS_FOR_RV = 30;          // below this the σ estimate is too noisy
const MAX_STALE_TICK_MS = 90_000;     // last tick must be fresher than 90s
const MIN_TICK_INTERVAL_MS = 800;     // sample-rate guard
const SECONDS_PER_YEAR = 365 * 24 * 3600;

// Sanity clamps. Outside the band we still return a value but flag the
// source so downstream telemetry can demote confidence.
const SIGMA_MIN = 0.10;               // 10% annualized
const SIGMA_MAX = 5.0;                // 500% annualized
const MU_CAP = 3.0;                   // ±300% annualized

const _buffers = new Map();           // commodity → Array<{ price, ts }>

function getBuffer(commodity) {
  let buf = _buffers.get(commodity);
  if (!buf) {
    buf = [];
    _buffers.set(commodity, buf);
  }
  return buf;
}

export function recordTick(commodity, price, tsMs) {
  if (!commodity || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return;
  }
  const ts = typeof tsMs === 'number' && Number.isFinite(tsMs) ? tsMs : Date.now();
  const buf = getBuffer(commodity);
  const last = buf.length > 0 ? buf[buf.length - 1] : null;
  if (last && ts - last.ts < MIN_TICK_INTERVAL_MS) return;
  buf.push({ price, ts });
  if (buf.length > BUFFER_CAPACITY) buf.shift();
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Pure function — sample list to stats. Exposed via __test__ so the unit
// tests can drive known sequences through without going via the buffer.
function computeFromSamples(samples, { now = Date.now() } = {}) {
  if (!Array.isArray(samples) || samples.length < MIN_TICKS_FOR_RV) return null;
  const last = samples[samples.length - 1];
  if (now - last.ts > MAX_STALE_TICK_MS) return null;
  const returns = [];
  const dts = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!(a.price > 0) || !(b.price > 0)) continue;
    const dtMs = b.ts - a.ts;
    if (dtMs <= 0) continue;
    returns.push(Math.log(b.price / a.price));
    dts.push(dtMs / 1000);
  }
  if (returns.length < MIN_TICKS_FOR_RV - 1) return null;
  const medianDtS = median(dts);
  if (!medianDtS || medianDtS <= 0) return null;
  const periodsPerYear = SECONDS_PER_YEAR / medianDtS;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  let varSum = 0;
  for (const r of returns) varSum += (r - mean) ** 2;
  const variance = varSum / Math.max(returns.length - 1, 1);
  if (!Number.isFinite(variance) || variance < 0) return null;

  const sigmaRaw = Math.sqrt(variance) * Math.sqrt(periodsPerYear);
  const muRaw = mean * periodsPerYear;

  let source = 'pyth_short_horizon';
  let sigma = sigmaRaw;
  let mu = muRaw;
  if (sigma < SIGMA_MIN) { sigma = SIGMA_MIN; source = 'clamped_low'; }
  if (sigma > SIGMA_MAX) { sigma = SIGMA_MAX; source = 'clamped_high'; }
  if (mu > MU_CAP) { mu = MU_CAP; source = source === 'pyth_short_horizon' ? 'clamped_mu_high' : source; }
  if (mu < -MU_CAP) { mu = -MU_CAP; source = source === 'pyth_short_horizon' ? 'clamped_mu_low' : source; }

  return {
    sigma_annual: sigma,
    mu_annual: mu,
    // Uncapped drift for consumers with their own horizon-appropriate clamp.
    // The ±MU_CAP band above is sized for 60d-drift sanity — ~30x too tight
    // for intra-hour momentum (±3.0/yr over 30min moves log-spot ~1.7bp).
    // commodity-base.js resolveTwapMu applies scale + per-commodity cap.
    // BITCOIN_V2_CUTOVER_2026-07-27.
    mu_annual_raw: muRaw,
    nTicks: samples.length,
    lookbackActualMin: (last.ts - samples[0].ts) / 60_000,
    lastTickAgeS: (now - last.ts) / 1000,
    medianDtS,
    source,
  };
}

export function getShortHorizonStats(commodity, { lookbackMin = 15, now = new Date() } = {}) {
  const buf = _buffers.get(commodity);
  if (!buf || buf.length === 0) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const cutoff = nowMs - lookbackMin * 60_000;
  // Buffer is append-ordered by recordTick — scan backwards to find the
  // first sample within the lookback window.
  let startIdx = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].ts < cutoff) { startIdx = i + 1; break; }
  }
  const samples = buf.slice(startIdx);
  return computeFromSamples(samples, { now: nowMs });
}

export function _resetBuffers() {
  _buffers.clear();
}

export const __test__ = {
  _buffers,
  computeFromSamples,
  BUFFER_CAPACITY,
  MIN_TICKS_FOR_RV,
  MAX_STALE_TICK_MS,
  MIN_TICK_INTERVAL_MS,
  SIGMA_MIN,
  SIGMA_MAX,
  MU_CAP,
};
