/**
 * 15-minute CRYPTO edge engine — KXBTC15M (KXETH15M ready behind the same map).
 *
 * WHY THIS IS A SEPARATE ENGINE FROM metals-15m.js
 * ------------------------------------------------
 * Same 15-minute cadence, three structural differences that make sharing one
 * code path a lie rather than a saving:
 *
 *  1. SETTLEMENT IS AN AVERAGE, NOT A POINT. Kalshi's own rules_primary:
 *       "If the simple average of the sixty seconds of CF Benchmarks' BRTI
 *        before 3:15 PM EDT ... is at least the simple average of the sixty
 *        seconds of BRTI before 3:00 PM EDT ... resolves to Yes."
 *     BOTH endpoints are 60-second averages. The strike Kalshi publishes as
 *     `floor_strike` is the already-computed opening average, so K is known and
 *     exact; the terminal variable is an average over the final 60s. That is an
 *     Asian payoff, not a European one, and it is priced with probAboveTwap
 *     (variance σ²(T − 2τ/3)), NOT the point digital in metals-15m.js. Pricing
 *     it as a point overstates terminal variance and systematically fattens
 *     both tails.
 *
 *  2. THE FEED IS CF BENCHMARKS, NOT PYTH. No Pyth dependency at all — which is
 *     why this engine could ship while gold/silver/WTI are blocked on the 24/7
 *     Pyth index feeds we cannot read for free (handoffs/FIFTEEN_MIN_ENGINE_V2_
 *     2026-08-29.md §3.4/§3.5). feeds/brti-spot.js polls the BRTI constituent
 *     basket every 10s, keyless, and already feeds short-horizon-vol under the
 *     commodity key 'bitcoin'.
 *
 *  3. THE BOOK IS PRICED IN TENTHS OF A CENT. `price_level_structure` is
 *     `tapered_deci_cent`: 0.1c steps below 10c and above 90c, 1c in between.
 *     Rounding to whole cents throws away the entire tick structure exactly
 *     where the longshot/favourite pricing lives. We read the `*_dollars`
 *     strings and keep cents as a float.
 *
 * DRIFT IS ZERO, DELIBERATELY. Same discipline as metals-15m.js: once the
 * window opens K is locked and fair value is arithmetic, not forecasting.
 * getShortHorizonStats does return mu_annual and it is NOT used here. Adding a
 * drift term needs a promotion gate and a graded record showing it helps.
 *
 * SHADOW-FIRST. `model_status` is 'shadow' until GRADED_WINDOWS_REQUIRED windows
 * have settled, and the site must not render fair value or divergence while it
 * is. We told readers in /articles/kalshi-bitcoin-15-minute-markets that a
 * 15-minute model "will only ship after it's been backtested"; publishing an
 * ungraded number would make that a lie. The page is worth shipping on day one
 * regardless — the live window, the locked strike, the book and the settlement
 * rule are what the `kxbtc15m` query set is actually asking for.
 *
 * Spec: handoffs/FIFTEEN_MIN_ENGINE_V2_2026-08-29.md
 */
import {
  fetchWindows,
  classifyWindows,
  feeBandPp,
  fpNum,
  parseSettled,
} from './metals-15m.js';
import { probAboveTwap } from './options.js';
import { getShortHorizonStats } from './short-horizon-vol.js';
import { getBrtiSpot } from '../feeds/brti-spot.js';
import {
  upsertWidgetPayloads,
  recordFifteenMinObservationV2,
  finalizeFifteenMinSettle,
  fetchUngradedFifteenMinWindows,
  countGradedFifteenMinWindows,
} from '../delivery/supabase.js';

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/** Kalshi averages the final 60 seconds of BRTI. Not a guess — rules_primary. */
const TWAP_WINDOW_SEC = 60;

/** Below this many graded windows the payload stays model_status='shadow'. */
export const GRADED_WINDOWS_REQUIRED = 200;

/**
 * Kill switch, mirroring METALS_15M_ENABLED in metals-15m.js. Set
 * CRYPTO_15M_ENABLED=0 and restart to stop this engine without touching the
 * others — a redeploy or rollback to disable one 15-minute engine would take
 * every other engine on this box down with it. Checked inside the run loop, not
 * at bootstrap, so flipping it does not require the timers to be rebuilt.
 */
const ENABLED = process.env.CRYPTO_15M_ENABLED !== '0';

/** Spot older than this and we refuse to price rather than guess. */
const MAX_SPOT_AGE_S = 60;

export const CRYPTO_15M = {
  btc: {
    commodity: 'btc',
    series: 'KXBTC15M',
    slug: 'bitcoin-edge-15m',
    label: 'Bitcoin',
    /** short-horizon-vol key — brti-spot.js records ticks under 'bitcoin'. */
    shCommodity: 'bitcoin',
  },
  // eth: pending a free 24/7 ETH reference of the same quality as BRTI.
  // KXETH15M also settles on CF Benchmarks; brti-spot only carries BTC today.
};

const state = {
  writes: 0,
  observations: 0,
  graded: 0,
  gradedKnownAt: 0,
  gradedCount: {},
  lastRunAt: null,
  lastErrorAt: null,
  lastError: null,
  timer: null,
  sweepTimer: null,
  perAsset: {},
};

/** `yes_bid_dollars` etc. are 4-dp strings. Return CENTS as a float so the
 *  deci-cent ladder survives. Null when the side is empty (Kalshi sends
 *  "0.0000" for no quote, which is not the same as a 0c bid). */
export function priceCentsDollars(market, key) {
  const raw = market?.[key];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n * 100;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * P(average of the final 60s of BRTI >= K), zero drift.
 *
 * Delegates to probAboveTwap so the Asian variance term stays in ONE place —
 * the hourly KXBTCD path uses the same function, so a fix there fixes both.
 * shortHorizonScale is 1: sigma already comes from a realized-vol estimator at
 * this horizon, so the IV-repair ramp must not double-count.
 */
export function fairYesTwap({ spot, strike, sigmaAnnual, tauYears }) {
  if (!(spot > 0) || !(strike > 0)) return null;
  if (!(sigmaAnnual > 0) || !(tauYears > 0)) return spot >= strike ? 1 : 0;
  const p = probAboveTwap(spot, strike, tauYears, 0, sigmaAnnual, TWAP_WINDOW_SEC, 1);
  return Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : null;
}

export function buildPayload(cfg, { markets, spot, stats, gradedCount, now = Date.now() }) {
  const { active, next } = classifyWindows(markets, now);
  const nowIso = new Date(now).toISOString();
  const modelStatus = (gradedCount ?? 0) >= GRADED_WINDOWS_REQUIRED ? 'graded' : 'shadow';

  const nextWindow = next
    ? { open: next.open_time, close: next.close_time, strike_locks_at: next.open_time }
    : null;

  const spotPrice = spot?.price ?? null;
  const spotAgeS = spot ? Math.max(0, (now - spot.publishTimeMs) / 1000) : null;
  const sigma = stats?.sigma_annual ?? null;

  const base = {
    commodity: cfg.commodity,
    label: cfg.label,
    series: cfg.series,
    settles_on: 'CF Benchmarks BRTI, 60-second average',
    twap_window_s: TWAP_WINDOW_SEC,
    model_status: modelStatus,
    graded_windows: gradedCount ?? 0,
    graded_windows_required: GRADED_WINDOWS_REQUIRED,
  };

  if (!active) {
    return {
      as_of: nowIso,
      stale: false,
      data: {
        ...base,
        market_closed: true,
        quality: nextWindow ? 'between_windows' : 'closed',
        window: null,
        strike: null,
        spot: spotPrice,
        spot_age_s: spotAgeS,
        sigma_15m: sigma,
        fair_yes: null,
        book: null,
        fee_band_pp: null,
        divergence_pp: null,
        divergence_beyond_band: null,
        next_window: nextWindow,
      },
    };
  }

  const closeMs = Date.parse(active.close_time);
  const openMs = Date.parse(active.open_time);
  const secondsRemaining = Math.max(0, (closeMs - now) / 1000);
  const tauYears = secondsRemaining / SECONDS_PER_YEAR;
  const strike = numOrNull(active.floor_strike);

  const bid = priceCentsDollars(active, 'yes_bid_dollars');
  const ask = priceCentsDollars(active, 'yes_ask_dollars');
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;

  const spotFresh = spotAgeS !== null && spotAgeS <= MAX_SPOT_AGE_S;
  const fair =
    strike !== null && spotPrice !== null && sigma !== null && spotFresh
      ? fairYesTwap({ spot: spotPrice, strike, sigmaAnnual: sigma, tauYears })
      : null;

  const band = fair !== null ? feeBandPp({ fair, bidCents: bid, askCents: ask }) : null;
  const divergence = fair !== null && mid !== null ? fair * 100 - mid : null;

  let quality = 'ok';
  if (strike === null) quality = 'no_strike';
  else if (spotPrice === null || !spotFresh) quality = 'stale_spot';
  else if (sigma === null) quality = 'warming';

  return {
    as_of: nowIso,
    stale: false,
    data: {
      ...base,
      market_closed: false,
      quality,
      window: {
        ticker: active.ticker,
        event_ticker: active.event_ticker,
        open: active.open_time,
        close: active.close_time,
        seconds_remaining: Math.round(secondsRemaining),
        elapsed_pct:
          Number.isFinite(openMs) && closeMs > openMs
            ? Math.min(1, Math.max(0, (now - openMs) / (closeMs - openMs)))
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
      divergence_beyond_band:
        divergence !== null && band !== null ? Math.abs(divergence) > band : null,
      next_window: nextWindow,
    },
  };
}

export async function runCrypto15mOnce({ now = Date.now() } = {}) {
  if (!ENABLED) return { written: 0, skipped: 'CRYPTO_15M_ENABLED=0' };
  state.lastRunAt = new Date(now).toISOString();
  let written = 0;

  // The graded count gates model_status. One query per minute, not per tick.
  if (now - state.gradedKnownAt > 60_000) {
    for (const cfg of Object.values(CRYPTO_15M)) {
      try {
        state.gradedCount[cfg.commodity] = await countGradedFifteenMinWindows(cfg.commodity);
      } catch {
        /* keep the last known count — a failed count must not flip us to shadow */
      }
    }
    state.gradedKnownAt = now;
  }

  for (const cfg of Object.values(CRYPTO_15M)) {
    try {
      const markets = await fetchWindows(cfg.series, { now });
      const spot = getBrtiSpot();
      const stats = getShortHorizonStats(cfg.shCommodity, { lookbackMin: 15, now: new Date(now) });
      const envelope = buildPayload(cfg, {
        markets,
        spot,
        stats,
        gradedCount: state.gradedCount[cfg.commodity] ?? 0,
        now,
      });

      await upsertWidgetPayloads(cfg.slug, envelope, ['hero']);
      written += 1;

      // Shadow record. Unlike the metals writer this stores SPOT and both sides
      // of the book — without them no alternative model can be re-priced on
      // captured history, which is the defect that blocked the metals V2
      // backtest (spec §3.2). Only rows with a real fair value are graded.
      const d = envelope.data;
      if (!d.market_closed && d.quality === 'ok' && d.fair_yes != null && d.book?.mid != null) {
        try {
          await recordFifteenMinObservationV2({
            commodity: cfg.commodity,
            series: cfg.series,
            eventTicker: d.window.event_ticker,
            marketTicker: d.window.ticker,
            windowOpen: d.window.open,
            windowClose: d.window.close,
            strike: d.strike,
            spot: d.spot,
            yesBidCents: d.book.yes_bid,
            yesAskCents: d.book.yes_ask,
            midCents: d.book.mid,
            fair: d.fair_yes,
            sigma: d.sigma_15m,
            divergencePp: d.divergence_pp,
            bandPp: d.fee_band_pp,
            tauS: d.window.seconds_remaining,
            volumeFp: d.book.volume_fp,
            oiFp: d.book.oi_fp,
            modelVersion: 'twap-v1',
          });
          state.observations += 1;
        } catch (err) {
          // Never take the payload writer down for the research table.
          console.warn(
            `[crypto-15m] ${cfg.commodity} observation failed: ${(err?.message || err).toString().slice(0, 200)}`,
          );
        }
      }

      state.perAsset[cfg.commodity] = {
        quality: d.quality,
        marketClosed: d.market_closed,
        modelStatus: d.model_status,
        gradedWindows: d.graded_windows,
        fairYes: d.fair_yes,
        at: envelope.as_of,
      };
    } catch (err) {
      state.lastErrorAt = new Date().toISOString();
      state.lastError = (err?.message || String(err)).slice(0, 240);
      console.warn(`[crypto-15m] ${cfg.commodity} tick failed: ${state.lastError}`);
    }
  }

  state.writes += written;
  return { written };
}

export async function sweepCryptoSettles({ now = Date.now(), timeoutMs = 20_000 } = {}) {
  let graded = 0;
  for (const cfg of Object.values(CRYPTO_15M)) {
    try {
      const pending = await fetchUngradedFifteenMinWindows(cfg.commodity);
      if (pending.length === 0) continue;
      const oldest = pending.reduce((min, p) => Math.min(min, Date.parse(p.window_close_at)), now);
      const url =
        `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${encodeURIComponent(cfg.series)}` +
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
      console.warn(`[crypto-15m] ${cfg.commodity} settle sweep failed: ${state.lastError}`);
    }
  }
  if (graded > 0) {
    state.graded += graded;
    console.log(`[crypto-15m] graded ${graded} window(s)`);
  }
  return { graded };
}

/** 15s payload cadence (a 15-min window is 60 ticks), 5-min settle sweep. */
export function bootstrapCrypto15m() {
  if (state.timer) return;
  runCrypto15mOnce().catch(() => {});
  state.timer = setInterval(() => {
    runCrypto15mOnce().catch(() => {});
  }, 15_000);
  state.sweepTimer = setInterval(() => {
    sweepCryptoSettles().catch(() => {});
  }, 300_000);
  if (state.timer.unref) state.timer.unref();
  if (state.sweepTimer.unref) state.sweepTimer.unref();
}

export function stopCrypto15m() {
  if (state.timer) clearInterval(state.timer);
  if (state.sweepTimer) clearInterval(state.sweepTimer);
  state.timer = null;
  state.sweepTimer = null;
}

export function getCrypto15mState() {
  return { ...state, timer: undefined, sweepTimer: undefined };
}

export const __test__ = { TWAP_WINDOW_SEC, MAX_SPOT_AGE_S, SECONDS_PER_YEAR };
