// 15-minute commodity edge engine — KXGOLD15M + KXSILVER15M + KXWTI15M.
//
// Writes ONE widget_payloads row per tool (gold-edge-15m / silver-edge-15m) on
// a short timer while a window is open. The site reads those rows; the browser
// polls Pyth Hermes itself for live spot and recomputes the gauge between ISR
// ticks, so this engine only has to be fresh, not real-time.
//
// WHAT THIS IS NOT: a directional pick engine. There is no options chain at a
// 15-minute horizon, and V2.1 showed the momentum-driven directional model
// collapsing to the base rate at the HOURLY horizon (Brier 0.2243 vs the
// market's 0.2167 — the book beat the model on its own product). At 15 minutes
// that gets worse. So fair value here is computed with mu = 0 DELIBERATELY:
// once the window opens the strike K is locked and fair value is arithmetic,
// not forecasting. Do not add a drift term without a promotion gate.
//
// Settlement is Pyth's 1-minute candle close vs the candle close at window
// open. Kalshi names index symbols that Pyth does NOT publish
// (Metal.Index.GOLD/USD etc.), so rather than assume our public feeds match, we
// measured them against Kalshi's own published settlement prints
// (`expiration_value` on settled markets) over 200 windows each:
//
//   KXGOLD15M   Metal.XAU/USD          99.5% verdict agreement
//   KXSILVER15M Metal.XAG/USD          99.0%
//   KXWTI15M    front-month WTI future 99.5%
//
// "Verdict agreement" = would this feed have called the same up/down result.
// That is the metric that decides a contract; price error is scale-dependent.
// Re-run with `scripts/validate-15m-settlement-feed.ts` in the site repo.
// Crypto 15m series settle on CF Benchmarks and are NOT covered by this engine.
//
// Why widget_payloads and not commodity_edge_signals: that table is
// strike-ladder-shaped AND carries the tool_picks mint trigger. Writing 96
// windows/day into it would either mint junk picks or force trigger surgery.
// One payload row per tool, upserted in place, is the Oracle-dashboard pattern
// and keeps the graded record clean by construction.
//
// Spec: prediction-marketspicks/handoffs/GOLD_SILVER_15M_EDGE_2026-08-05.md

import { getPrice, WTI_FRONT_MONTH_SYMBOL } from '../feeds/pyth.js';
import { getShortHorizonStats } from './short-horizon-vol.js';
import { normCdf } from './options.js';
import {
  upsertWidgetPayloads,
  recordFifteenMinObservation,
  finalizeFifteenMinSettle,
  fetchUngradedFifteenMinWindows,
} from '../delivery/supabase.js';
import { registerFeed, markFeedRequired, setFeedStatus, recordTick } from '../observability/health.js';

const KALSHI_API_BASE =
  process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

// 15s while a window is live. The whole market IS the burst window, so the
// commodity engines' EXPIRATION_BURST_WINDOW_MS pattern is deliberately NOT
// used here — there is nothing to burst toward.
const ACTIVE_INTERVAL_MS = Number(process.env.METALS_15M_INTERVAL_MS || 15_000);
// When nothing is listed (weekends / holidays) back off hard. Metals hours are
// Kalshi's call, not NYSE's, so we re-check on this timer rather than guessing
// a calendar.
const IDLE_INTERVAL_MS = Number(process.env.METALS_15M_IDLE_INTERVAL_MS || 5 * 60_000);

const ENABLED = process.env.METALS_15M_ENABLED !== '0';

// Quadratic taker fee: 0.07 * P * (1-P) per contract at multiplier 1 (verified
// on the series object 2026-08-05 — fee_type/fee_multiplier live on the SERIES,
// not the market). 1.75c at 50c, 0.63c at 90c.
const FEE_COEFFICIENT = 0.07;

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

// Spot older than this and we refuse to price rather than guess — parity with
// crypto-15m.js. A frozen Pyth feed must never produce a fair value: the
// 2026-08-26 Hermes outage pinned metals spot for 28 hours and the engine
// kept pricing off it.
const MAX_SPOT_AGE_S = 60;

export const METALS = {
  gold: {
    commodity: 'gold',
    series: 'KXGOLD15M',
    slug: 'gold-edge-15m',
    pythSymbol: 'XAU/USD',
    label: 'Gold',
  },
  silver: {
    commodity: 'silver',
    series: 'KXSILVER15M',
    slug: 'silver-edge-15m',
    pythSymbol: 'XAG/USD',
    label: 'Silver',
  },
  // WTI asks for the LOGICAL symbol, never a contract id — Pyth serves oil as
  // per-expiry futures and the front month rolls (WTIU6 -> WTIV6 on 2026-08-20).
  // feeds/pyth.js resolves it by expiry at call time.
  //
  // Kalshi names `Commodities.Index.PYTHOIL/USD` for this series; that feed is
  // dead on both public Pyth channels (last publish 2026-03-30, $103 vs a ~$75
  // market). Measured against Kalshi's own published settlement prints over 200
  // windows, the front-month future reproduces the settled verdict 99.5% of the
  // time; `Commodities.USOILSPOT` — the obvious-looking CFD — manages 49.7%,
  // i.e. a coin flip. Do not "simplify" this to USOILSPOT.
  wti: {
    commodity: 'wti',
    series: 'KXWTI15M',
    slug: 'wti-edge-15m',
    pythSymbol: WTI_FRONT_MONTH_SYMBOL,
    label: 'WTI',
  },
};

/** Symbols the 15-minute engines need polled. index.js unions these into the
 *  Pyth subscription list — they are NOT derivable from enabledCommodities. */
export const METALS_15M_SYMBOLS = Object.values(METALS).map((m) => m.pythSymbol);

const state = {
  ticks: 0,
  writes: 0,
  observations: 0,
  graded: 0,
  lastRunAt: null,
  lastErrorAt: null,
  lastError: null,
  lastSweepAt: null,
  timer: null,
  sweepTimer: null,
  perMetal: {},
};

let stopRequested = false;

registerFeed('metals_15m_engine');
if (ENABLED) markFeedRequired('metals_15m_engine', { maxStaleMs: 15 * 60_000 });

// ── field-shape helpers ──────────────────────────────────────────────────────
// These series ship the new *_dollars / *_fp string shape, but older markets
// use yes_bid/yes_ask numbers. Operational Rules mandate handling both.

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Price in CENTS from either the *_dollars string or the legacy cent number.
 *  Kalshi sends the STRING '0.0000' (and '1.0000' on the far side) for a side
 *  with no quote — a sentinel, not a price (see the KXNFL props incident,
 *  2026-08-29: '0.0000' is truthy and parses to 0). Both shapes return null
 *  here so a one-sided book yields mid === null and nothing downstream can
 *  mistake an empty side for a 0c or 100c quote. */
export function priceCents(market, side) {
  const dollars = numOrNull(market?.[`${side}_dollars`]);
  if (dollars !== null) {
    return dollars > 0 && dollars < 1 ? Math.round(dollars * 100) : null;
  }
  const cents = numOrNull(market?.[side]);
  if (cents === null) return null;
  return cents > 0 && cents < 100 ? cents : null;
}

/** Size/volume from *_fp string or legacy numeric. */
export function fpNum(market, base) {
  const fp = numOrNull(market?.[`${base}_fp`]);
  if (fp !== null) return fp;
  return numOrNull(market?.[base]);
}

// ── fair value ───────────────────────────────────────────────────────────────

/**
 * P(settle >= K) for a lognormal spot with ZERO drift.
 *
 *   d = (ln(S/K) - sigma^2 * tau / 2) / (sigma * sqrt(tau))
 *   P(YES) = Phi(d)
 *
 * mu = 0 is a deliberate modelling choice, not an omission — see the module
 * header. tau is in YEARS because getShortHorizonStats returns an ANNUALIZED
 * sigma.
 *
 * Degenerate tau or sigma collapses to the honest indicator: with no time left
 * the contract is worth exactly whether spot cleared the strike.
 */
export function fairYes({ spot, strike, sigmaAnnual, tauYears }) {
  if (!(spot > 0) || !(strike > 0)) return null;
  const vol = sigmaAnnual > 0 ? sigmaAnnual * Math.sqrt(tauYears) : 0;
  if (!(vol > 1e-9) || !(tauYears > 0)) return spot >= strike ? 1 : 0;
  const d = (Math.log(spot / strike) - (sigmaAnnual ** 2 * tauYears) / 2) / vol;
  const p = normCdf(d);
  return Math.min(1, Math.max(0, p));
}

/** Quadratic taker fee in CENTS at probability p (0-1). */
export function feeCentsAt(p) {
  if (!(p >= 0 && p <= 1)) return null;
  return FEE_COEFFICIENT * p * (1 - p) * 100;
}

/**
 * The no-trade band, in percentage POINTS, around fair value: a round trip
 * (enter + exit) of quadratic fee plus half the quoted spread. Inside this
 * band there is nothing to do — which is the honest headline for this product
 * and the pre-emptive answer to "why isn't there a signal every window".
 */
export function feeBandPp({ fair, bidCents, askCents }) {
  const fee = feeCentsAt(fair);
  if (fee === null) return null;
  const roundTrip = 2 * fee;
  const halfSpread =
    bidCents !== null && askCents !== null && askCents >= bidCents
      ? (askCents - bidCents) / 2
      : 0;
  return roundTrip + halfSpread;
}

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * One call per series per tick. The close-timestamp window returns exactly the
 * live window plus the next listed one, which is all the payload needs — and
 * it structurally cannot hit the banned `status=open&limit=200` shape that
 * returns thousands of zero-volume rows.
 */
export async function fetchWindows(series, { now = Date.now(), timeoutMs = 15_000 } = {}) {
  const nowS = Math.floor(now / 1000);
  const url =
    `${KALSHI_API_BASE}/markets?series_ticker=${encodeURIComponent(series)}` +
    `&min_close_ts=${nowS}&max_close_ts=${nowS + 2400}&limit=20`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'pmp-ingestion/1.0' },
    });
    if (!res.ok) throw new Error(`kalshi ${series} HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.markets) ? json.markets : [];
  } finally {
    clearTimeout(t);
  }
}

/** Split the listed markets into the live window and the next one up. */
export function classifyWindows(markets, now = Date.now()) {
  let active = null;
  let next = null;
  for (const m of markets) {
    const open = Date.parse(m.open_time);
    const close = Date.parse(m.close_time);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    if (open <= now && now < close) {
      if (!active || close < Date.parse(active.close_time)) active = m;
    } else if (open > now) {
      if (!next || open < Date.parse(next.open_time)) next = m;
    }
  }
  return { active, next };
}

// ── payload ──────────────────────────────────────────────────────────────────

export function buildPayload(cfg, { markets, spot, stats, now = Date.now() }) {
  const { active, next } = classifyWindows(markets, now);
  const nowIso = new Date(now).toISOString();

  const nextWindow = next
    ? { open: next.open_time, close: next.close_time, strike_locks_at: next.open_time }
    : null;

  // Nothing live and nothing listed => Kalshi has gone dark (weekend/holiday).
  // Metals run ~24/5 and the calendar is Kalshi's call, so this is derived from
  // the series' own listings, never from NYSE hours.
  if (!active) {
    return {
      as_of: nowIso,
      stale: false,
      data: {
        commodity: cfg.commodity,
        label: cfg.label,
        series: cfg.series,
        market_closed: true,
        quality: nextWindow ? 'between_windows' : 'closed',
        window: null,
        strike: null,
        spot: spot?.price ?? null,
        spot_age_s: spot ? Math.max(0, (now - spot.publishTimeMs) / 1000) : null,
        sigma_15m: stats?.sigma_annual ?? null,
        fair_yes: null,
        book: null,
        fee_band_pp: null,
        divergence_pp: null,
        next_window: nextWindow,
      },
      _raw: [],
    };
  }

  const closeMs = Date.parse(active.close_time);
  const openMs = Date.parse(active.open_time);
  const tauYears = Math.max(0, (closeMs - now) / 1000) / SECONDS_PER_YEAR;
  const strike = numOrNull(active.floor_strike);

  const bid = priceCents(active, 'yes_bid');
  const ask = priceCents(active, 'yes_ask');
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;

  const sigma = stats?.sigma_annual ?? null;
  const spotPrice = spot?.price ?? null;
  const spotAgeS = spot ? Math.max(0, (now - spot.publishTimeMs) / 1000) : null;

  const spotFresh = spotAgeS !== null && spotAgeS <= MAX_SPOT_AGE_S;
  const fair =
    strike !== null && spotPrice !== null && sigma !== null && spotFresh
      ? fairYes({ spot: spotPrice, strike, sigmaAnnual: sigma, tauYears })
      : null;

  const band = fair !== null ? feeBandPp({ fair, bidCents: bid, askCents: ask }) : null;
  const divergence = fair !== null && mid !== null ? fair * 100 - mid : null;

  // Quality ladder, in crypto-15m.js order: stale_spot is checked BEFORE
  // sigma's `warming` — a dead feed must not present as a 5-minute warm-up.
  // `warming` is the cold-buffer contract: short-horizon-vol needs 30 ticks at
  // 10s = ~5 min after a redeploy before sigma is non-null. Surface it rather
  // than silently publishing a strike-only card.
  let quality = 'ok';
  if (strike === null) quality = 'no_strike';
  else if (spotPrice === null || !spotFresh) quality = 'stale_spot';
  else if (sigma === null) quality = 'warming';

  return {
    as_of: nowIso,
    stale: false,
    data: {
      commodity: cfg.commodity,
      label: cfg.label,
      series: cfg.series,
      market_closed: false,
      quality,
      window: {
        ticker: active.ticker,
        event_ticker: active.event_ticker,
        open: active.open_time,
        close: active.close_time,
        seconds_remaining: Math.max(0, Math.round((closeMs - now) / 1000)),
        elapsed_pct:
          closeMs > openMs
            ? Math.min(100, Math.max(0, ((now - openMs) / (closeMs - openMs)) * 100))
            : null,
      },
      strike,
      spot: spotPrice,
      spot_age_s: spotAgeS,
      sigma_15m: sigma,
      fair_yes: fair,
      book: {
        yes_bid: bid,
        yes_ask: ask,
        mid,
        volume_fp: fpNum(active, 'volume'),
        oi_fp: fpNum(active, 'open_interest'),
      },
      fee_band_pp: band,
      divergence_pp: divergence,
      // Actionable ONLY as an educational overlay until the shadow record
      // clears the promotion gate (spec §6). Never minted into tool_picks.
      divergence_beyond_band:
        divergence !== null && band !== null ? Math.abs(divergence) > band : null,
      next_window: nextWindow,
    },
    _raw: [],
  };
}

// ── run loop ─────────────────────────────────────────────────────────────────

export async function runMetals15mOnce({ now = Date.now() } = {}) {
  if (!ENABLED) return { written: 0, skipped: 'METALS_15M_ENABLED=0' };
  state.ticks += 1;
  state.lastRunAt = new Date(now).toISOString();

  let written = 0;
  let anyActive = false;

  for (const cfg of Object.values(METALS)) {
    try {
      const markets = await fetchWindows(cfg.series, { now });
      const spot = getPrice(cfg.pythSymbol);
      const stats = getShortHorizonStats(cfg.commodity, { lookbackMin: 15, now: new Date(now) });
      const envelope = buildPayload(cfg, { markets, spot, stats, now });

      if (!envelope.data.market_closed) anyActive = true;

      await upsertWidgetPayloads(cfg.slug, envelope, ['hero']);
      written += 1;

      // Phase 2: accumulate the shadow record. Only once fair value is real —
      // a `warming` tick has no model number to grade, and writing one would
      // put a null-fair row in the graded table.
      const d = envelope.data;
      if (!d.market_closed && d.quality === 'ok' && d.fair_yes != null && d.book?.mid != null) {
        try {
          await recordFifteenMinObservation({
            commodity: cfg.commodity,
            series: cfg.series,
            eventTicker: d.window.event_ticker,
            marketTicker: d.window.ticker,
            windowOpen: d.window.open,
            windowClose: d.window.close,
            strike: d.strike,
            midCents: d.book.mid,
            fair: d.fair_yes,
            sigma: d.sigma_15m,
            divergencePp: d.divergence_pp,
            bandPp: d.fee_band_pp,
            tauS: d.window.seconds_remaining,
            volumeFp: d.book.volume_fp,
            oiFp: d.book.oi_fp,
          });
          state.observations += 1;
        } catch (err) {
          // Shadow logging must never take the payload writer down with it —
          // the tool page is the product, the shadow record is research.
          console.warn(
            `[metals-15m] ${cfg.commodity} observation failed: ${(err?.message || err).toString().slice(0, 200)}`,
          );
        }
      }
      state.perMetal[cfg.commodity] = {
        quality: envelope.data.quality,
        marketClosed: envelope.data.market_closed,
        fairYes: envelope.data.fair_yes,
        at: envelope.as_of,
      };
    } catch (err) {
      state.lastErrorAt = new Date().toISOString();
      state.lastError = (err?.message || String(err)).slice(0, 240);
      console.warn(`[metals-15m] ${cfg.commodity} tick failed: ${state.lastError}`);
    }
  }

  state.writes += written;
  if (written > 0) {
    recordTick('metals_15m_engine');
    setFeedStatus('metals_15m_engine', { connected: true, lastError: null });
  } else {
    setFeedStatus('metals_15m_engine', { connected: false, lastError: state.lastError });
  }
  return { written, anyActive };
}

function schedule(delayMs) {
  if (stopRequested) return;
  state.timer = setTimeout(async () => {
    let nextDelay = ACTIVE_INTERVAL_MS;
    try {
      const { anyActive } = await runMetals15mOnce();
      nextDelay = anyActive ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
    } catch {
      nextDelay = IDLE_INTERVAL_MS;
    }
    schedule(nextDelay);
  }, delayMs);
}

// Settle sweep runs on its own slower timer: a window is finalized within
// ~5 minutes of close (settlement_timer_seconds is 1, but Kalshi's status
// transition is not instant), and the sweep is idempotent, so 5 minutes is
// ample and keeps the extra Kalshi calls to ~576/day across both series.
const SWEEP_INTERVAL_MS = Number(process.env.METALS_15M_SWEEP_MS || 5 * 60_000);

function scheduleSweep() {
  if (stopRequested) return;
  state.sweepTimer = setTimeout(async () => {
    try {
      await sweepSettles();
      state.lastSweepAt = new Date().toISOString();
    } catch {
      /* already logged */
    }
    scheduleSweep();
  }, SWEEP_INTERVAL_MS);
}

export function bootstrapMetals15m() {
  if (!ENABLED) return;
  // 40s — after the macro (15s), Gamma (20s) and Polymarket US (35s)
  // bootstraps, and far enough in that the Pyth buffer has begun filling.
  setTimeout(() => {
    runMetals15mOnce().catch(() => {});
    schedule(ACTIVE_INTERVAL_MS);
  }, 40_000);
  // 90s — after the first payload tick, so the first sweep has something to
  // grade against on a warm restart.
  setTimeout(() => {
    sweepSettles()
      .then(() => {
        state.lastSweepAt = new Date().toISOString();
      })
      .catch(() => {});
    scheduleSweep();
  }, 90_000);
}

export function stopMetals15m() {
  stopRequested = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.sweepTimer) {
    clearTimeout(state.sweepTimer);
    state.sweepTimer = null;
  }
}

export function getMetals15mState() {
  return {
    enabled: ENABLED,
    ticks: state.ticks,
    writes: state.writes,
    observations: state.observations,
    graded: state.graded,
    lastRunAt: state.lastRunAt,
    lastSweepAt: state.lastSweepAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
    perMetal: state.perMetal,
  };
}

// ── Phase 2: settle capture ──────────────────────────────────────────────────
//
// A window we observed becomes a GRADED row once Kalshi finalizes it. Kalshi
// publishes `expiration_value` — the settlement price it actually resolved on —
// so we grade against that rather than reconstructing settlement from our own
// spot feed. Reconstructing it would only ever measure Kalshi's resolver, which
// is a different (and far less useful) question than "is our signal any good".
//
// The sweep is idempotent: finalize_fifteen_min_settle only writes where
// result IS NULL, so re-scanning a lookback window costs nothing.

/** Map a finalized Kalshi market to its settle fields. */
export function parseSettled(market) {
  const result = String(market?.result || '').toLowerCase();
  if (result !== 'yes' && result !== 'no') return null;
  return {
    eventTicker: market.event_ticker,
    settlePx: numOrNull(market.expiration_value),
    result,
    volumeFp: fpNum(market, 'volume'),
    oiFp: fpNum(market, 'open_interest'),
  };
}

export async function sweepSettles({ now = Date.now(), timeoutMs = 20_000 } = {}) {
  let graded = 0;
  for (const cfg of Object.values(METALS)) {
    try {
      const pending = await fetchUngradedFifteenMinWindows(cfg.commodity);
      if (pending.length === 0) continue;

      // One paged call per series covering the pending span, rather than one
      // request per window.
      const oldest = pending.reduce(
        (min, p) => Math.min(min, Date.parse(p.window_close_at)),
        now,
      );
      const url =
        `${KALSHI_API_BASE}/markets?series_ticker=${encodeURIComponent(cfg.series)}` +
        `&status=settled&min_close_ts=${Math.floor(oldest / 1000) - 60}` +
        `&max_close_ts=${Math.floor(now / 1000)}&limit=200`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let markets = [];
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'pmp-ingestion/1.0' },
        });
        if (!res.ok) throw new Error(`kalshi settled ${cfg.series} HTTP ${res.status}`);
        const json = await res.json();
        markets = Array.isArray(json?.markets) ? json.markets : [];
      } finally {
        clearTimeout(t);
      }

      const byEvent = new Map();
      for (const m of markets) {
        const parsed = parseSettled(m);
        if (parsed) byEvent.set(parsed.eventTicker, parsed);
      }

      for (const p of pending) {
        const s = byEvent.get(p.event_ticker);
        if (!s) continue;
        const didGrade = await finalizeFifteenMinSettle({
          commodity: cfg.commodity,
          eventTicker: s.eventTicker,
          settlePx: s.settlePx,
          result: s.result,
          volumeFp: s.volumeFp,
          oiFp: s.oiFp,
        });
        if (didGrade) graded += 1;
      }
    } catch (err) {
      state.lastErrorAt = new Date().toISOString();
      state.lastError = (err?.message || String(err)).slice(0, 240);
      console.warn(`[metals-15m] ${cfg.commodity} settle sweep failed: ${state.lastError}`);
    }
  }
  if (graded > 0) {
    state.graded += graded;
    console.log(`[metals-15m] graded ${graded} window(s)`);
  }
  return { graded };
}

export const __test__ = { FEE_COEFFICIENT, SECONDS_PER_YEAR, MAX_SPOT_AGE_S, numOrNull };
