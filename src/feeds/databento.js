// Databento OPRA feed — thin Node client to the Python sidecar.
//
// The Python sidecar (python/databento_live.py) owns the raw TCP + DBN
// binary protocol to the upstream gateway via the official SDK. This file
// is the Node-side adapter that matches feeds/massive.js's surface
// (getChain, fetchPrevClose) so commodity-base.js doesn't change a line
// when OPTIONS_PROVIDER=databento.
//
// Why this split — no official Databento Node SDK; the upstream protocol
// is raw TCP + DBN binary, not WebSocket. Porting that to Node would
// be ~1000 LOC of binary parsing with high parity risk against the
// official client. Letting Python own the wire protocol keeps the IV
// math + edge methodology in Node (where the Brent solver already lives)
// and the binary-protocol layer in a thoroughly-tested SDK.
//
// IV/Greeks: re-enables the pre-Massive code path. impliedVol() (Brent's
// method back-solver in src/engine/options.js) was authored before the
// Massive Options Advanced tier returned server-side IV — it ran in
// production for the original commodity_edge Python before the Massive
// shortcut. Same numerics, identical methodology.
//
// ETF spot: the sidecar's OPRA records don't carry the underlying stock
// price (OPRA tape is options-only). We derive SLV/GLD/USO/CPER spot via
// put-call parity at the strike with the tightest two-sided book:
//   S = C - P + K * exp(-r*T)  (with q=0 for ETFs in this model)
// If no usable PC pair exists (cold start, weekend, deep ITM only),
// fall back to fetchPrevClose(). Implementation pulls from massive.js
// as the bridge — a Phase 2 enhancement is to swap for a Databento
// stocks subscription so prev-close becomes real-time too.

import { setFeedStatus, recordTick } from '../observability/health.js';
import { impliedVol, bsDelta, yearFraction } from '../engine/options.js';
import {
  RISK_FREE_RATE,
  DIVIDEND_YIELD,
} from '../engine/thresholds.js';
import {
  passesDeltaFilter,
  passesQualityFilters,
  isSpeculativeOption,
  fetchPrevClose as massiveFetchPrevClose,
  isOptionsMarketOpen,
} from './massive.js';

const SIDECAR_HOST = process.env.DATABENTO_SIDECAR_HOST || '127.0.0.1';
const SIDECAR_PORT = Number(process.env.DATABENTO_SIDECAR_PORT || 9090);
const SIDECAR_BASE = `http://${SIDECAR_HOST}:${SIDECAR_PORT}`;

// Snapshot cadence. Matches the pre-2026-05-05 5-second market-hours value
// the engine used before Massive forced us to a 15-min delayed poll. Off-hours
// rate is loose because OPRA itself is dark; we keep polling at a slow rate
// just to refresh the in-memory snapshot for /health visibility.
const POLL_INTERVAL_MARKET_MS = 5_000;
const POLL_INTERVAL_OFF_MS = 5 * 60_000;

const chainCache = new Map(); // underlying → { fetchedAt, expirationDate, contracts }
const timers = new Map(); // underlying → setTimeout id
let stopRequested = false;

// Sidecar strike-bounds push state. Bounds are spot × [STRIKE_LO_FRAC, STRIKE_HI_FRAC]
// — wider than the IV smile range (commodity-base.js uses 0.75/1.25) so the
// sidecar admits a small buffer of contracts around the smile edges. Re-push
// only when spot moves >STRIKE_REPUSH_PCT from the last value we pushed.
const STRIKE_LO_FRAC = 0.70;
const STRIKE_HI_FRAC = 1.30;
const STRIKE_REPUSH_PCT = 0.02; // 2% drift — re-push when spot moves enough to shift bounds
const _lastPushedSpot = new Map(); // underlying → spot used at last push

async function pushStrikeBounds(underlying, etfSpot) {
  if (!underlying || !(etfSpot > 0)) return;
  const prev = _lastPushedSpot.get(underlying);
  if (prev != null && Math.abs(etfSpot - prev) / prev < STRIKE_REPUSH_PCT) return;
  const lo = etfSpot * STRIKE_LO_FRAC;
  const hi = etfSpot * STRIKE_HI_FRAC;
  try {
    const res = await fetch(`${SIDECAR_BASE}/strike-bounds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [underlying]: [lo, hi] }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      console.warn(`[databento] strike-bounds push ${underlying} returned ${res.status}`);
      return;
    }
    _lastPushedSpot.set(underlying, etfSpot);
  } catch (err) {
    // Sidecar may be cold-starting or briefly unreachable; this is fire-and-
    // forget so the snapshot path doesn't block. Next pollOnce retries.
    console.warn(`[databento] strike-bounds push ${underlying} failed: ${err?.message || err}`);
  }
}

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function midFromBook(bid, ask, last) {
  const b = num(bid);
  const a = num(ask);
  if (b != null && a != null && b > 0 && a > 0 && a >= b) return (b + a) / 2;
  const l = num(last);
  return l && l > 0 ? l : null;
}

// Put-call parity spot derivation. Pairs call + put at each strike with both
// sides quoted, picks the strike whose joint book has the tightest combined
// spread (best quality), returns S = C_mid - P_mid + K*exp(-r*T). q=0 for
// ETFs in this model — matches the Massive path's assumption.
function deriveEtfSpotByParity(rawContracts, now = Date.now()) {
  const byStrikeExpiry = new Map(); // key=`${strike}|${expiration}` → { call, put }
  for (const c of rawContracts) {
    if (c.strike == null || !c.expiration || !c.contract_type) continue;
    if (c.bid == null || c.ask == null || c.bid <= 0 || c.ask <= 0 || c.ask < c.bid) continue;
    const key = `${c.strike}|${c.expiration}`;
    const slot = byStrikeExpiry.get(key) || {};
    if (c.contract_type === 'call') slot.call = c;
    else if (c.contract_type === 'put') slot.put = c;
    byStrikeExpiry.set(key, slot);
  }

  let best = null;
  let bestQuality = Infinity;
  for (const [, slot] of byStrikeExpiry) {
    if (!slot.call || !slot.put) continue;
    const cSpread = slot.call.ask - slot.call.bid;
    const pSpread = slot.put.ask - slot.put.bid;
    const cMid = (slot.call.bid + slot.call.ask) / 2;
    const pMid = (slot.put.bid + slot.put.ask) / 2;
    // Quality score: relative spread on the more-liquid leg, plus a
    // small bonus for shorter dated (better-priced) options. Lower = better.
    const quality = (cSpread / Math.max(cMid, 0.01)) + (pSpread / Math.max(pMid, 0.01));
    if (quality < bestQuality) {
      bestQuality = quality;
      best = slot;
    }
  }

  if (!best) return null;
  const K = best.call.strike;
  const expMs = new Date(best.call.expiration).getTime();
  const T = yearFraction(now / 1000, expMs / 1000);
  if (!(T > 0)) return null;
  const cMid = (best.call.bid + best.call.ask) / 2;
  const pMid = (best.put.bid + best.put.ask) / 2;
  const S = cMid - pMid + K * Math.exp(-RISK_FREE_RATE * T);
  return S > 0 ? S : null;
}

// Resolve ETF spot for the snapshot. PC parity first (real-time, free, no
// extra subscription); fall back to massiveFetchPrevClose for cold start
// or weekends when there are no two-sided books.
async function resolveEtfSpot(underlying, rawContracts, now) {
  const parity = deriveEtfSpotByParity(rawContracts, now);
  if (parity && parity > 0) return { price: parity, source: 'pc_parity' };
  try {
    const prev = await massiveFetchPrevClose(underlying);
    if (prev && prev > 0) return { price: prev, source: 'prev_close_bridge' };
  } catch (err) {
    console.warn(`[databento] prev-close fallback failed for ${underlying}: ${err?.message || err}`);
  }
  return null;
}

// Build the Massive-shaped contract record. IV is back-solved via Brent's
// method against mid price; delta is computed from the same IV. Greeks
// other than delta (theta/vega) stay null — gamma is recomputed by
// engine/gamma.js from IV+OI on its own path. Volume is the sidecar's
// 24h rolling sum; OI is null in Phase 1 (OPRA OI lives on the daily
// statistics schema — wire in Phase 2).
function normalizeAndSolve(c, etfSpot, now) {
  const expMs = new Date(c.expiration).getTime();
  const T = yearFraction(now / 1000, expMs / 1000);
  if (!(T > 0)) return null;
  const mid = midFromBook(c.bid, c.ask, c.last);
  if (mid == null || mid <= 0) return null;
  const ivResult = impliedVol(
    mid,
    etfSpot,
    c.strike,
    T,
    RISK_FREE_RATE,
    DIVIDEND_YIELD,
    c.contract_type,
  );
  if (!ivResult || ivResult.iv == null) return null;
  const delta = bsDelta(
    etfSpot,
    c.strike,
    T,
    RISK_FREE_RATE,
    DIVIDEND_YIELD,
    ivResult.iv,
    c.contract_type,
  );
  return {
    ticker: c.raw_symbol || null,
    contractType: c.contract_type,
    strike: num(c.strike),
    expirationDate: c.expiration,
    iv: ivResult.iv,
    delta,
    gamma: null,
    theta: null,
    vega: null,
    bid: num(c.bid),
    ask: num(c.ask),
    last: num(c.last),
    volume24h: num(c.volume_24h),
    openInterest: num(c.open_interest),
    breakEven: null,
    underlyingPrice: etfSpot,
  };
}

async function fetchSidecarChain(underlying) {
  const url = `${SIDECAR_BASE}/chain/${encodeURIComponent(underlying)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`sidecar ${res.status}: ${url}`);
  return res.json();
}

async function pollOnce(underlying) {
  const feedName = `databento_${underlying.toLowerCase()}`;
  try {
    const raw = await fetchSidecarChain(underlying);
    const rawContracts = Array.isArray(raw?.contracts) ? raw.contracts : [];
    if (rawContracts.length === 0) {
      // Sidecar is up but the book hasn't populated yet (cold start). Don't
      // bin the cache — just hold the previous snapshot and tick observability.
      recordTick(feedName);
      setFeedStatus(feedName, { connected: true, lastError: 'empty_chain' });
      return;
    }

    const now = Date.now();
    const spotResolution = await resolveEtfSpot(underlying, rawContracts, now);
    if (!spotResolution) {
      recordTick(feedName);
      setFeedStatus(feedName, { connected: true, lastError: 'no_spot' });
      return;
    }

    // Push strike-range bounds to the sidecar so it can drop far-OTM
    // contracts at the SDK callback layer. Fire-and-forget; sidecar applies
    // bounds asynchronously and reclassifies existing instruments. Internal
    // re-push throttle gates network traffic.
    pushStrikeBounds(underlying, spotResolution.price);

    const contracts = [];
    for (const c of rawContracts) {
      if (c.strike == null || !c.expiration || !c.contract_type) continue;
      const norm = normalizeAndSolve(c, spotResolution.price, now);
      if (!norm) continue;
      contracts.push(norm);
    }

    const filtered = contracts
      .filter(passesDeltaFilter)
      .filter(passesQualityFilters)
      .map((c) => ({ ...c, speculative: isSpeculativeOption(c) }));

    // expirationDate mimics Massive's chain envelope: pick the nearest expiry
    // present in the filtered set. commodity-base.js doesn't read this field
    // directly — it's preserved for observability/log parity with massive.js.
    const expirationDate = filtered.length > 0
      ? filtered.reduce((min, c) => (c.expirationDate < min ? c.expirationDate : min), filtered[0].expirationDate)
      : null;

    // ── TERM-MIXING PROBE (EDGE_MARKETS §2.4, 2026-08-31) — MEASUREMENT ONLY ──
    //
    // buildIvSmile (commodity-base.js) filters contracts by IV range and
    // liquidity but NEVER by expiry, so if a chain spans several expiration
    // dates it builds one strike→IV curve out of mixed terms. IV has a term
    // structure, so such a curve belongs to no actual expiry and every
    // probability priced off it inherits that.
    //
    // Whether that happens is an EMPIRICAL question about what the sidecar
    // returns, and this process cannot answer it from the code: `/chain/` takes
    // no expiry parameter and the answer depends on the live OPRA response. So
    // count first and fix second — the same order the Mcp-Session-Id probe used,
    // for the same reason: the alternative is changing live pricing math on four
    // paying surfaces to fix a problem nobody has yet shown exists.
    //
    // If this logs 1 expiry, there is nothing to fix. If it logs several, the
    // fix is to scope the smile to the expiry nearest the event's close.
    const expiries = new Set(filtered.map((c) => c.expirationDate).filter(Boolean));
    if (expiries.size > 1) {
      console.warn(
        `[databento] TERM-MIX ${underlying}: chain spans ${expiries.size} expiries ` +
          `(${[...expiries].sort().join(', ')}) across ${filtered.length} contracts — ` +
          `buildIvSmile does not filter by expiry, so the smile mixes terms`,
      );
    } else if (filtered.length === 0) {
      // ⛔ NOT A RESULT. An empty chain trivially has one distinct expiry, so
      // the clean-looking branch below would report "single-expiry" for a poll
      // that saw nothing at all — off-hours, a dead sidecar, or a filter that
      // ate everything all read identically. Same failure the repo already has
      // a rule about ("never log a checkmark for a 0-row upsert"): an absence
      // dressed as an answer is worse than no answer, because it ends the
      // investigation. Say "no data" and keep the question open.
      console.log(`[databento] ${underlying}: no chain this poll (0 contracts) — term-mix UNMEASURED`);
    } else {
      console.log(`[databento] ${underlying}: single-expiry chain (${filtered.length} contracts)`);
    }

    chainCache.set(underlying, {
      fetchedAt: now,
      expirationDate,
      contracts: filtered,
    });
    recordTick(feedName);
    setFeedStatus(feedName, { connected: true, lastError: null });
  } catch (err) {
    console.warn(`[databento] poll ${underlying} failed: ${err?.message || err}`);
    setFeedStatus(feedName, {
      connected: false,
      lastError: (err?.message || String(err)).slice(0, 240),
    });
  }
}

function schedule(underlying) {
  if (stopRequested) return;
  const delay = isOptionsMarketOpen() ? POLL_INTERVAL_MARKET_MS : POLL_INTERVAL_OFF_MS;
  const t = setTimeout(async () => {
    await pollOnce(underlying);
    schedule(underlying);
  }, delay);
  timers.set(underlying, t);
}

// --- Public API (mirrors massive.js) -----------------------------------

export function startDatabentoPoller(underlying /* , expirationDateRef */) {
  stopRequested = false;
  pollOnce(underlying).then(() => schedule(underlying));
  console.log(`[databento] started poller for ${underlying} (sidecar ${SIDECAR_BASE})`);
}

export function stopDatabentoPoller(underlying) {
  const t = timers.get(underlying);
  if (t) {
    clearTimeout(t);
    timers.delete(underlying);
  }
}

export function stopAllDatabentoPollers() {
  stopRequested = true;
  for (const [u, t] of timers) {
    clearTimeout(t);
    timers.delete(u);
  }
}

export function getChain(underlying) {
  return chainCache.get(underlying) || null;
}

// Phase 1 bridge — re-export Massive's prev-close. ETF stocks aren't in
// our OPRA subscription; a Phase 2 enhancement wires a Databento stocks
// dataset (e.g. XNAS.NLS) for true real-time prev-close.
export const fetchPrevClose = massiveFetchPrevClose;

// Test seam for the parity script.
export const __test__ = {
  deriveEtfSpotByParity,
  normalizeAndSolve,
  midFromBook,
};
