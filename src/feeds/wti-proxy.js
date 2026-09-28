// KXWTI15M spot — the replacement for Pythnet's front-month WTI future, which
// stopped updating 2026-09-15.
//
// ── WHY PYTHNET DIED (measured 2026-09-28) ──────────────────────────────────
// Not a contract roll and not a feed-id change: the TRANSPORT is gone. Both
// public Pythnet RPCs are closed — `pythnet.rpcpool.com` answers every call
// (even getSlot) with 403 "Access forbidden", and `api2.pythnet.pyth.network`
// no longer resolves in DNS (`api.pythnet…` 301s to it). Hermes has been behind
// a paid key since 2026-08-26. There is no free Pyth path left for oil.
//
// A SECOND, latent bug surfaced while measuring: pyth.js resolves the front
// month BY EXPIRY, but Kalshi's PYTHOIL index had already rolled to the Nov
// contract (CLX6) by 2026-09-16 — at least six days before Oct (CLV6) expired
// on 2026-09-22. Expiry-based resolution would have priced the wrong contract
// for that whole week even with a healthy RPC.
//
// ── WHAT THIS READS ─────────────────────────────────────────────────────────
// Kalshi settles KXWTI15M on the 1-minute candle close of Pyth
// `Commodities.Index.PYTHOIL/USD` (series settlement_sources; the feed is not
// publicly readable). The best free, live, measured proxy is the oracle price
// of the `xyz:CL` WTI perpetual on Hyperliquid's public info API (no key, ~3s
// updates, $75M/day notional). Measured against Kalshi's own `expiration_value`
// over the same 176 settled windows (2026-09-24 → 09-28), verdict agreement:
//   xyz:CL (1-min close)          97.2%
//   front-month future CLX26      96.5%   (Yahoo history, delayed — reference only)
//   next month CLZ26              52.7%   raw  → 93.1% after the re-anchor below
// ~10% of windows settle within 2¢ of their strike, which caps every proxy.
//
// ── ROLL HANDLING: RE-ANCHOR TO KALSHI'S OWN PRINTS ─────────────────────────
// Instead of guessing which contract month Kalshi's index is on, the basis is
// MEASURED: every settled window gives `expiration_value − ourRawAt(close)`.
// The median of the last BASIS_WINDOW of those is the basis. Inside the
// ±BASIS_DEADBAND it is treated as zero (on-contract: correcting sub-deadband
// noise measured WORSE, 96.6% vs 97.2%); outside it is applied (a roll mismatch
// on either side — the CLZ26 simulation above goes 52.7% → 93.1%). If the
// recent basis readings disagree with each other by more than BASIS_MAX_MAD the
// feed THROWS rather than publish a number it cannot place — fail closed; the
// engine shows stale_spot.
//
// Kalshi's floor_strike is itself a PYTHOIL print, so this also makes the
// proxy's LEVEL match the strike it is compared against — which is the only
// thing a 15-minute up/down contract cares about.
//
// ⛔ Still a PROXY, and internal-only: this number never leaves the engine
// (metals-15m.js publicEnvelope strips it). Never name the vendor on a public
// surface, never call it the settlement source.

const HL_INFO_URL = process.env.WTI_PROXY_HL_INFO_URL || 'https://api.hyperliquid.xyz/info';
const HL_DEX = 'xyz';
const HL_COIN = 'xyz:CL';
const KALSHI_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const SERIES = 'KXWTI15M';

/** Logical symbol the 15-minute engine asks pyth.js getPrice() for. */
export const WTI_PROXY_SYMBOL = 'WTI_PROXY/USD';
/** Health-feed key (pyth.js pollOnce would otherwise prefix `pyth_`, which this is not). */
export const WTI_PROXY_HEALTH_KEY = 'wti_15m_proxy';

export const BASIS_WINDOW = 8;
export const BASIS_MIN_OBS = 3;
export const BASIS_DEADBAND = 0.1; // dollars
export const BASIS_MAX_MAD = 0.15; // dollars
const SAMPLE_KEEP_MS = 4 * 3600_000;
const SAMPLE_MAX_GAP_MS = 30_000; // a raw read older than this at a close is not "at" it
const OBS_KEEP = 16;
const BASIS_REFRESH_MS = 60_000;
const FROZEN_MS = 120_000; // oracle unchanged this long = not trading

export function hasWtiProxyFeed(symbol) {
  return symbol === WTI_PROXY_SYMBOL;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Pure: Hyperliquid metaAndAssetCtxs payload → { price, mid, halfSpread, dayNtlVlm }. Exported for tests. */
export function parseHyperliquidCtx(payload, coin = HL_COIN) {
  if (!Array.isArray(payload) || payload.length < 2) throw new Error('wti-proxy: malformed metaAndAssetCtxs');
  const universe = payload[0]?.universe;
  const ctxs = payload[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) throw new Error('wti-proxy: malformed metaAndAssetCtxs');
  const i = universe.findIndex((u) => u?.name === coin);
  if (i < 0) throw new Error(`wti-proxy: ${coin} not listed`);
  const c = ctxs[i] ?? {};
  const price = Number(c.oraclePx);
  if (!(price > 0)) throw new Error(`wti-proxy: ${coin} oraclePx ${c.oraclePx}`);
  const [ib, ia] = Array.isArray(c.impactPxs) ? c.impactPxs.map(Number) : [NaN, NaN];
  const halfSpread = ib > 0 && ia >= ib ? (ia - ib) / 2 : null;
  const mid = Number(c.midPx);
  return { price, mid: mid > 0 ? mid : null, halfSpread, dayNtlVlm: Number(c.dayNtlVlm) || null };
}

/**
 * Pure: basis from settle observations [{ t, settle, raw }] (oldest first).
 * Returns { value, status: 'cold'|'ok'|'rolled'|'unstable', n, median, mad }.
 */
export function computeBasis(observations, {
  window = BASIS_WINDOW,
  minObs = BASIS_MIN_OBS,
  deadband = BASIS_DEADBAND,
  maxMad = BASIS_MAX_MAD,
} = {}) {
  const diffs = observations
    .filter((o) => Number.isFinite(o?.settle) && Number.isFinite(o?.raw))
    .slice(-window)
    .map((o) => o.settle - o.raw);
  if (diffs.length < minObs) return { value: 0, status: 'cold', n: diffs.length, median: null, mad: null };
  const med = median(diffs);
  const mad = median(diffs.map((d) => Math.abs(d - med)));
  if (mad > maxMad) return { value: null, status: 'unstable', n: diffs.length, median: med, mad };
  if (Math.abs(med) < deadband) return { value: 0, status: 'ok', n: diffs.length, median: med, mad };
  return { value: med, status: 'rolled', n: diffs.length, median: med, mad };
}

/** Pure: the last raw sample at or before t, within maxGapMs; null otherwise. */
export function rawAt(samples, t, maxGapMs = SAMPLE_MAX_GAP_MS) {
  let best = null;
  for (const s of samples) {
    if (s.t <= t && t - s.t <= maxGapMs && (!best || s.t > best.t)) best = s;
  }
  return best ? best.raw : null;
}

// ── module state (one process, one poller) ──────────────────────────────────
const state = {
  samples: [], // { t, raw }
  observations: [], // { t, settle, raw } per settled window, oldest first
  seenCloses: new Set(),
  lastRaw: null,
  lastChangeAt: null,
  lastBasisCheckAt: 0,
  basis: { value: 0, status: 'cold', n: 0, median: null, mad: null },
  lastBasisLogged: 'cold',
};

export function wtiProxyState() {
  return {
    basis: state.basis,
    observations: state.observations.length,
    samples: state.samples.length,
    lastChangeAt: state.lastChangeAt,
  };
}

/** Test hook. */
export function _resetWtiProxy() {
  state.samples = [];
  state.observations = [];
  state.seenCloses = new Set();
  state.lastRaw = null;
  state.lastChangeAt = null;
  state.lastBasisCheckAt = 0;
  state.basis = { value: 0, status: 'cold', n: 0, median: null, mad: null };
  state.lastBasisLogged = 'cold';
}

async function refreshBasis(now) {
  if (now - state.lastBasisCheckAt < BASIS_REFRESH_MS) return;
  state.lastBasisCheckAt = now;
  const res = await fetch(`${KALSHI_BASE}/markets?series_ticker=${SERIES}&status=settled&limit=12`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`kalshi settled ${res.status}`);
  const { markets = [] } = await res.json();
  const fresh = [];
  for (const m of markets) {
    const t = Date.parse(m?.close_time);
    const settle = Number(m?.expiration_value);
    if (!Number.isFinite(t) || !(settle > 0) || state.seenCloses.has(t)) continue;
    const raw = rawAt(state.samples, t);
    // Before our first sample we cannot pair it. Mark it seen only when paired or
    // clearly older than our buffer, so a close that lands just after a restart
    // is not dropped forever.
    if (raw == null) {
      if (state.samples.length && t < state.samples[0].t) state.seenCloses.add(t);
      continue;
    }
    state.seenCloses.add(t);
    fresh.push({ t, settle, raw });
  }
  if (fresh.length) {
    state.observations = [...state.observations, ...fresh].sort((a, b) => a.t - b.t).slice(-OBS_KEEP);
    state.basis = computeBasis(state.observations);
    if (state.basis.status !== state.lastBasisLogged) {
      console.warn(
        `[wti-proxy] basis ${state.lastBasisLogged} → ${state.basis.status} ` +
          `(median ${state.basis.median?.toFixed(3) ?? 'n/a'}, mad ${state.basis.mad?.toFixed(3) ?? 'n/a'}, n ${state.basis.n})`,
      );
      state.lastBasisLogged = state.basis.status;
    }
  }
}

/**
 * One read. Same return shape as pyth.js fetchOnce (plus rawPrice/basis), so
 * getPrice() callers are unchanged. Throws when the basis is unstable.
 */
export async function fetchWtiProxy(now = Date.now()) {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'pmp-ingestion/0.1' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: HL_DEX }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`wti-proxy HTTP ${res.status}`);
  const px = parseHyperliquidCtx(await res.json());

  if (state.lastRaw !== px.price || state.lastChangeAt == null) state.lastChangeAt = now;
  state.lastRaw = px.price;
  state.samples.push({ t: now, raw: px.price });
  while (state.samples.length && now - state.samples[0].t > SAMPLE_KEEP_MS) state.samples.shift();

  try {
    await refreshBasis(now);
  } catch (err) {
    // A missed refresh keeps the last basis; the next poll retries in 60s.
    console.warn(`[wti-proxy] basis refresh failed (keeping ${state.basis.status}): ${err?.message || err}`);
  }

  const b = state.basis;
  if (b.status === 'unstable') {
    throw new Error(`wti-proxy basis unstable (mad ${b.mad.toFixed(3)} > ${BASIS_MAX_MAD}) — refusing to publish`);
  }
  return {
    price: px.price + b.value,
    rawPrice: px.price,
    confidence: px.halfSpread,
    publishTimeMs: state.lastChangeAt,
    trading: now - state.lastChangeAt <= FROZEN_MS,
    basis: b.value,
    basisStatus: b.status,
  };
}
