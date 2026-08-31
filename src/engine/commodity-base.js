// Shared compute path for every commodity engine (silver/gold/oil/copper).
//
// Methodology (locked in CLAUDE.md):
//   - Kalshi YES implied prob: prefer mid for tight two-sided books, fall back
//     to last only with volume confirmation AND in-window
//   - IV smile: filter to in-window OTM strikes, plausible IV, then
//     np.interp-style clamped linear interpolation
//   - Risk-neutral P(S_T > K) via N(d2)
//
// All commodity-specific knobs (Kalshi series, ETF, Pyth symbol) come in via a
// `config` row from src/engine/commodities.js. Lift one knob, and you have a
// new commodity engine — that's the whole point of this module.
//
// Mirrors commodity_edge/src/edge.py — ports the Python methodology to JS while
// reusing Massive's server-side IV/Greeks (the Python path back-solves IV from
// Yahoo, which has known quantization issues; the engine doesn't).

import { probAboveStrike, probAboveStrikePhysical, probAboveTwap, yearFraction } from './options.js';
import { computeDealerGamma } from './gamma.js';
import { estimateDrift } from './drift.js';
import { warmVolCache, estimateVol } from './vol.js';
import { getShortHorizonStats } from './short-horizon-vol.js';
import { getCalibrationMap, applyCalibration, isCalibrationActive } from './calibration.js';
import { applyEngineRules } from './engine-rules.js';
import {
  MIN_EDGE_PP,
  MIN_EDGE_PP_NO,
  BTC_MU_SCALE,
  BTC_MU_CAP_ANNUAL,
  YES_FAVORITE_PRICE,
  MIN_EDGE_PP_YES_FAVORITE,
  YES_LONGSHOT_PRICE_MIN,
  MIN_VOL_FOR_LIVE_PRICE,
  MAX_BID_ASK_SPREAD,
  MAX_QUOTE_AGE_SEC,
  RISK_FREE_RATE,
  DIVIDEND_YIELD,
  fusedTier,
  confidenceTierInt,
  downgradeFusedTier,
  downgradeLegacyConfidence,
  FRED_DIVERGENCE_BP_THRESHOLD,
  FRED_MAX_AGE_HOURS,
  OPTION_QUALITY_MIN_VOLUME,
  OPTION_QUALITY_MIN_OI,
  KALSHI_MAX_SKEW_SECONDS,
  edgeImplausibleThreshold,
  EDGE_IMPLAUSIBLE_FLOOR_PP,
  EDGE_IMPLAUSIBLE_SIGMA_MULT,
  WATCH_EDGE_PP,
} from './thresholds.js';
import { getQuote } from '../feeds/kalshi.js';
import { getChain, fetchPrevClose } from '../feeds/options-provider.js';
import { getPrice } from '../feeds/pyth.js';
import { getBrtiSpot } from '../feeds/brti-spot.js';
import { WTI_FRONT_MONTH_SYMBOL } from '../feeds/pyth.js';

/** Oil snapshots run on a 5-min cadence, so a Pyth tick older than 10 min means
 *  the feed is dead rather than quiet. Falls through to Yahoo, never publishes. */
const PYTH_WTI_MAX_AGE_MS = 10 * 60 * 1000;

import { getOilSpot, getContractSpot } from '../feeds/yahoo-oil.js';
import { synthesizeWtiSpot } from '../feeds/uso-synthetic.js';
import { getFredDailyClose } from '../feeds/fred.js';
import { fetchEvent, getNextEvent, refetchEventMarkets } from '../feeds/kalshi-event.js';
import { getActiveSettleContract } from '../feeds/kalshi-series.js';
import { isOptionsMarketOpen } from '../feeds/massive.js';
import { recordGuardRejection, recordGuardOk } from '../observability/health.js';

// Kalshi-side suppression thresholds (2026-05-21 unified bitcoin-edge fix).
// Stale-print divergence: when classifyKalshiView returns 'stale_print' AND
// the live options-implied prob disagrees with the Kalshi side by more than
// this much, suppress the row. The 8c-vs-60c artifact lived in stale-print
// rows whose bid/ask happened to bracket an ancient lastPrice from a prior
// spot regime.
const STALE_PRINT_DIVERGENCE_CEILING = 0.25; // 25pp
// Thin-book large-edge ceiling: when passesLiquidityGate fails (volume_24h
// floor or quote-age) AND |edge| > this, suppress. Below the ceiling the row
// still ships as LOW with the gate-failed caveat in the rationale.
const THIN_BOOK_EDGE_CEILING = 0.10; // 10pp

// Snapshot-write guards. Hardening added after the 2026-05-15 Databento cutover
// surfaced a cold-start IV-solver bail-out (handoff: SILVER_EDGE_GUARDS_2026-05-15).
// Provider-agnostic — a no-op on Massive (server-side IV passes magnitude +
// smile-coherence trivially), real safety net on Databento or any future
// provider that re-engages the Brent solver in src/engine/options.js.
const MIN_STRIKES_PER_SNAPSHOT = 5;
const IV_HARD_CAP = 3.0;
const SMILE_CLUSTER_IV_FLOOR = 3.5;
const SMILE_CLUSTER_EPS = 0.02;
const SMILE_CLUSTER_LEN = 3;
const firstSnapshotWritten = new Map(); // commodity → true once one clean parity write has landed this session
let prevMarketOpen = null; // tracks options-market-open transition for session reset

function maybeResetSessionFlags(now = new Date()) {
  const open = isOptionsMarketOpen(now);
  if (prevMarketOpen === false && open === true) {
    firstSnapshotWritten.clear();
  }
  prevMarketOpen = open;
}

// Spearman rank correlation between two numeric arrays of equal length.
// Used by the event-level smile-vs-Kalshi sanity pass. Returns null on
// degenerate inputs (length < 2 or zero variance after ranking).
function spearmanCorr(xs, ys) {
  const n = xs.length;
  if (n !== ys.length || n < 2) return null;
  const rank = (arr) => {
    const indexed = arr.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && indexed[j + 1].v === indexed[i].v) j++;
      const avg = (i + j + 2) / 2; // 1-based average rank for ties
      for (let k = i; k <= j; k++) r[indexed[k].i] = avg;
      i = j + 1;
    }
    return r;
  };
  const xr = rank(xs);
  const yr = rank(ys);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xr);
  const my = mean(yr);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let k = 0; k < n; k++) {
    const a = xr[k] - mx;
    const b = yr[k] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function smileCoherenceCheck(rows) {
  const high = rows
    .filter((r) => r.options_iv != null && r.options_iv >= SMILE_CLUSTER_IV_FLOOR)
    .map((r) => r.options_iv);
  if (high.length < SMILE_CLUSTER_LEN) return { ok: true };
  high.sort((a, b) => a - b);
  let cluster = 1;
  for (let i = 1; i < high.length; i++) {
    if (Math.abs(high[i] - high[i - 1]) <= SMILE_CLUSTER_EPS) cluster++;
    else cluster = 1;
    if (cluster >= SMILE_CLUSTER_LEN) {
      return {
        ok: false,
        reason: 'smile_cluster',
        detail: { ivs: high.slice(i - SMILE_CLUSTER_LEN + 1, i + 1) },
      };
    }
  }
  return { ok: true };
}

// Order of operations:
//   1. Per-row drop: options_iv > IV_HARD_CAP (one bad strike shouldn't kill
//      the snapshot; smile interpolation already excludes IV > 1.5 contributors
//      but downstream `atmIv` can leak a ceiling-pegged value through).
//   2. Guard A — min strikes: filtered rows.length >= MIN_STRIKES_PER_SNAPSHOT.
//   3. Guard B — cold-start spot freshness: if firstSnapshotWritten[commodity]
//      is not set AND spot_source = 'prev_close_bridge', reject. Lets mid-session
//      thin-book gaps fall back to prev-close without bailing the engine, but
//      a fresh session must prove parity before any data lands.
//   4. Guard C — smile coherence: ≥3 strikes with IV ≥ 3.5 within 0.02 of each
//      other clusters at the solver ceiling. Real vol smiles don't cluster.
function validateSnapshot(rows, { commodity, spotSource }) {
  if (rows.length < MIN_STRIKES_PER_SNAPSHOT) {
    return { ok: false, reason: 'min_strikes', detail: { count: rows.length } };
  }
  if (!firstSnapshotWritten.get(commodity) && spotSource === 'prev_close_bridge') {
    return { ok: false, reason: 'cold_start_prev_close', detail: { spotSource } };
  }
  return smileCoherenceCheck(rows);
}

// ---------- Kalshi probability inference ----------
// Direct port of KalshiMarket.yes_implied_prob in commodity_edge/src/kalshi.py.

function kalshiYesImpliedProb(market) {
  const { yesBid, yesAsk, lastPrice, volume24h } = market;
  const hasBook = (yesBid ?? 0) > 0 && (yesAsk ?? 0) > 0;
  if (hasBook) {
    const spread = yesAsk - yesBid;
    const mid = (yesBid + yesAsk) / 2;
    if (spread <= 0.1) return mid;
    if (
      (volume24h ?? 0) >= MIN_VOL_FOR_LIVE_PRICE &&
      lastPrice != null &&
      lastPrice > 0 &&
      lastPrice < 1 &&
      yesBid - 0.05 <= lastPrice &&
      lastPrice <= yesAsk + 0.05
    ) {
      return lastPrice;
    }
    return mid;
  }
  // No live two-sided book — only trust lastPrice when there's recent volume.
  // Without a quote ts we can't verify recency directly; volume_24h is the
  // proxy — a strike with ≥ MIN_VOL_FOR_LIVE_PRICE in the last 24h has at
  // least one recent trade, which is much better than a single ancient print
  // on a $0 book. Returning null signals the caller ('cannot price this
  // strike'); caller writes a quality_flag row instead of a phantom edge.
  if (
    lastPrice != null &&
    lastPrice > 0 &&
    lastPrice < 1 &&
    (volume24h ?? 0) >= MIN_VOL_FOR_LIVE_PRICE
  ) {
    return lastPrice;
  }
  return null;
}

// V2 Phase 2 liquidity gate. Returns { ok, reason } — `ok=true` means the
// market is liquid enough that an actionable confidence is trustworthy.
// Failures are recorded so the rationale can name the specific gate that
// tripped. Null quote age passes (cold-start before any live WS frame has
// landed); engine cannot tell the difference between "fresh REST seed" and
// "stale WS quote that happens to still match the REST snapshot". Aligns with
// applyTickerMsg behaviour where seedFromMarket stamps ts_ms = Date.now().
function passesLiquidityGate(market) {
  if (!market) return { ok: false, reason: 'no_market' };
  const vol = market.volume24h ?? 0;
  if (vol < MIN_VOL_FOR_LIVE_PRICE) {
    return { ok: false, reason: `volume_24h ${Math.round(vol)} < ${MIN_VOL_FOR_LIVE_PRICE}` };
  }
  const bid = market.yesBid ?? 0;
  const ask = market.yesAsk ?? 0;
  if (bid > 0 && ask > 0) {
    const spread = ask - bid;
    // 1e-9 epsilon absorbs float-rounding noise at the boundary (Kalshi quotes
    // are $0.01 granular, so "spread > 0.15" semantically means $0.16+).
    if (spread > MAX_BID_ASK_SPREAD + 1e-9) {
      return {
        ok: false,
        reason: `bid-ask spread $${spread.toFixed(2)} > $${MAX_BID_ASK_SPREAD.toFixed(2)}`,
      };
    }
  }
  // quoteTsMs surfaced in mergeLiveQuote (V2 Phase 1). Null = no live frame yet
  // → fail open. Stale frame (>30min) → demote.
  const quoteTsMs = market.quoteTsMs;
  if (quoteTsMs != null) {
    const ageSec = Math.max(0, Math.round((Date.now() - quoteTsMs) / 1000));
    if (ageSec > MAX_QUOTE_AGE_SEC) {
      return { ok: false, reason: `quote ${ageSec}s stale (> ${MAX_QUOTE_AGE_SEC}s)` };
    }
  }
  return { ok: true, reason: null };
}

function classifyKalshiView(market) {
  const { yesBid, yesAsk, volume24h, lastPrice } = market;
  const hasBook = (yesBid ?? 0) > 0 && (yesAsk ?? 0) > 0;
  const spread = hasBook ? yesAsk - yesBid : 1.0;
  const wideSpread = spread > 0.2;
  if (hasBook && spread <= 0.1) return 'tight_book';
  if ((volume24h ?? 0) >= MIN_VOL_FOR_LIVE_PRICE && lastPrice > 0 && !wideSpread) return 'live';
  if (lastPrice > 0 && wideSpread) return 'wide_spread';
  if (lastPrice > 0) return 'stale_print';
  return 'no_market';
}

// ---------- IV smile from Massive chain ----------

function buildIvSmile(contracts, etfSpot) {
  const lo = etfSpot * 0.75;
  const hi = etfSpot * 1.25;
  // Each entry is [strike, iv, speculative] so ivAt can flag interpolations
  // that lean on thin-volume contracts (handoff §2.3). The row's confidence is
  // capped to 'low' downstream when smile contributors are speculative.
  //
  // Liquidity hard-floor (2026-05-21): the upstream passesQualityFilters in
  // feeds/massive.js + feeds/databento.js uses null-passthrough for cold-start
  // protection on off-hours snapshots. For bitcoin (OPRA-hours-only + paused
  // off-hours) we should never be in cold-start during writes — and on May 21
  // a single thin contract entering the smile as spot drifted made ATM IV
  // jump 33→66% on a $34 BTC move. Hard-reject contracts whose volume/OI
  // can't be confirmed above the floor, falling back to unfiltered only if
  // the filter would zero out the chain entirely.
  const filterLiquid = (c) =>
    c.iv != null &&
    c.strike != null &&
    c.iv >= 0.1 &&
    c.iv <= 1.5 &&
    (c.volume24h ?? 0) >= OPTION_QUALITY_MIN_VOLUME &&
    (c.openInterest ?? 0) >= OPTION_QUALITY_MIN_OI;
  const filterLoose = (c) =>
    c.iv != null && c.strike != null && c.iv >= 0.1 && c.iv <= 1.5;
  const liquidContracts = contracts.filter(filterLiquid);
  const atmPool = liquidContracts.length > 0 ? liquidContracts : contracts.filter(filterLoose);

  const clean = [];
  for (const c of atmPool) {
    if (c.strike < lo || c.strike > hi) continue;
    if (c.strike >= etfSpot && c.contractType === 'call') clean.push([c.strike, c.iv, !!c.speculative]);
    else if (c.strike < etfSpot && c.contractType === 'put') clean.push([c.strike, c.iv, !!c.speculative]);
  }
  clean.sort((a, b) => a[0] - b[0]);

  // ATM IV: average put + call at the closest strike where both legs exist,
  // filtered for liquidity. Put-call parity says the two should match; if
  // they disagree by >10% absolute, flag speculative (something is off on
  // one leg). Falls back to single-leg + speculative when no paired strike
  // exists at all. Was previously single closest contract with no liquidity
  // floor — meaning a thin strike could become ATM IV whenever spot crossed
  // a boundary, causing the May 21 13-min 33→66→39% IV swing.
  let atmIv = null;
  let atmSpeculative = false;
  if (atmPool.length > 0) {
    const byStrike = new Map(); // strike → { call, put }
    for (const c of atmPool) {
      const existing = byStrike.get(c.strike) || {};
      if (c.contractType === 'call') existing.call = c;
      else if (c.contractType === 'put') existing.put = c;
      byStrike.set(c.strike, existing);
    }
    let bestPaired = null;
    let bestPairedDist = Infinity;
    let bestSingle = null;
    let bestSingleDist = Infinity;
    for (const [strike, legs] of byStrike) {
      const d = Math.abs(strike - etfSpot);
      if (legs.call && legs.put && d < bestPairedDist) {
        bestPairedDist = d;
        bestPaired = legs;
      }
      if ((legs.call || legs.put) && d < bestSingleDist) {
        bestSingleDist = d;
        bestSingle = legs.call || legs.put;
      }
    }
    if (bestPaired) {
      const ivCall = bestPaired.call.iv;
      const ivPut = bestPaired.put.iv;
      atmIv = (ivCall + ivPut) / 2;
      atmSpeculative =
        !!bestPaired.call.speculative ||
        !!bestPaired.put.speculative ||
        Math.abs(ivCall - ivPut) > 0.10;
    } else if (bestSingle) {
      atmIv = bestSingle.iv;
      atmSpeculative = true; // single-leg ATM is always speculative
    }
  }

  // ivAt returns { iv, speculative } — speculative=true when any of the
  // contracts feeding the interpolation (or extrapolation) was thin-volume.
  function ivAt(targetStrikeEtf) {
    if (clean.length === 0) return { iv: atmIv, speculative: atmSpeculative };
    if (targetStrikeEtf <= clean[0][0]) return { iv: clean[0][1], speculative: clean[0][2] };
    if (targetStrikeEtf >= clean[clean.length - 1][0]) {
      const last = clean[clean.length - 1];
      return { iv: last[1], speculative: last[2] };
    }
    for (let i = 1; i < clean.length; i++) {
      if (clean[i][0] >= targetStrikeEtf) {
        const [x0, y0, s0] = clean[i - 1];
        const [x1, y1, s1] = clean[i];
        const t = (targetStrikeEtf - x0) / (x1 - x0);
        return { iv: y0 + (y1 - y0) * t, speculative: s0 || s1 };
      }
    }
    return { iv: atmIv, speculative: atmSpeculative };
  }

  return { atmIv, ivAt };
}

function mergeLiveQuote(market) {
  const live = getQuote(market.ticker);
  if (!live) return market;
  return {
    ...market,
    yesBid: live.yesBid ?? market.yesBid,
    yesAsk: live.yesAsk ?? market.yesAsk,
    lastPrice: live.price ?? market.lastPrice,
    volume24h: market.volume24h,
    openInterest: live.openInt ?? market.openInterest,
    // V2 Phase 1: surface the WS frame's ts (ms epoch) for quote_age_seconds.
    // applyTickerMsg in src/feeds/kalshi.js stores it as `ts` on the cached
    // entry. Cold-start REST seed sets ts = Date.now() in seedFromMarket.
    quoteTsMs: live.ts ?? null,
  };
}

// ---------- public API ----------

export async function discoverEvent(config) {
  // config.eventFilter optionally restricts candidate events before picking the
  // soonest. Used by bitcoin to skip hourly KXBTCD settles outside the IBIT
  // chain window; silver/gold/oil don't set a filter and pass through.
  const ev = await getNextEvent(config.seriesTicker, { filter: config.eventFilter });
  if (!ev) return null;
  return fetchEvent(ev.event_ticker);
}

// Kalshi trading fee for ONE contract, as a probability FRACTION (EDGE_MARKETS
// §1.4, 2026-08-31).
//
// ⛔ SOURCE OF TRUTH IS THE SITE: prediction-marketspicks/lib/tools/kalshi-fees.ts
// (`feeCents`). It is replicated rather than imported because this engine is a
// separate repo and cannot reach across; if the published schedule changes,
// change it THERE and mirror here in the same commit.
//
//   fee = ceil(0.07 · p · (1−p) · 100) cents, per contract, taker.
//
// Two properties that matter for how it is used below:
//   · it is SYMMETRIC in p — fee(p) === fee(1−p) — so the NO contract at
//     (1 − yesBid) is charged exactly fee(yesBid). No separate NO branch.
//   · it PEAKS at p=0.5 (1.75¢) and vanishes at the wings, so it bites hardest
//     precisely in the mid-band that produces this tool's realised profit. A
//     5pp gross edge at 50¢ is ~3.2pp after fee alone — which is why a tier
//     computed on gross was never a statement about money.
export function feeFraction(priceFraction) {
  if (!Number.isFinite(priceFraction)) return 0;
  const p = Math.min(1, Math.max(0, priceFraction));
  return Math.ceil(0.07 * p * (1 - p) * 100) / 100;
}

// Post-spread, side-aware BUY gate (bitcoin only — BITCOIN_EDGE_NO_SIDE_FIX_2026-06-16).
//
// The legacy gate compared |edge| to a single symmetric threshold and set the
// side from the sign alone, so it flipped to BUY NO on every negative-edge strike
// with no check that the NO contract clears a real edge after its own ask-side
// spread. This charges each side its actual ask-side spread off the live Kalshi
// book and holds the NO side to a stricter floor:
//   - YES net edge = chosenProb - yesAsk   (the price to lift the YES offer)
//   - NO  net edge = yesBid   - chosenProb   (NO ask = 1 - yesBid, so this is the
//                                             post-spread NO edge, derived purely
//                                             from the published bid)
// YES is preferred when both sides somehow qualify (the profitable cluster). The
// returned netEdge drives confidence/tier magnitude so spread cost is reflected
// in the tier. pass=false => not a BUY (caller emits PASS/low). Pure + deterministic.
export function postSpreadSideGate({
  chosenProb,
  yesBid,
  yesAsk,
  minEdgeYes,
  minEdgeNo,
  noSideEnabled = true,
  chargeFees = false,
}) {
  // NET OF FEES TOO (§1.4). The spread was already charged here — this adds the
  // other real cost, so `netEdge` is what the position actually clears and the
  // floors below are floors on MONEY, not on a gross gap. Opt-in per commodity
  // via config.chargeFees so enabling it is a deliberate, recorded signal change
  // (it moves published tiers) rather than a silent one.
  //
  // Charged on the side actually lifted: YES at the ask, NO at (1 − yesBid).
  // feeFraction is symmetric, so the NO fee is feeFraction(yesBid).
  const yesFee = chargeFees && yesAsk != null ? feeFraction(yesAsk) : 0;
  const noFee = chargeFees && yesBid != null ? feeFraction(yesBid) : 0;
  const yesNet = chosenProb != null && yesAsk != null ? chosenProb - yesAsk - yesFee : null;
  const noNet = chosenProb != null && yesBid != null ? yesBid - chosenProb - noFee : null;
  if (yesNet != null && yesNet >= minEdgeYes) {
    return { pass: true, dirYes: true, netEdge: yesNet, yesNet, noNet, reason: null };
  }
  // Evaluate the NO floor BEFORE consulting the kill switch, so `reason` can tell
  // the caller WHICH of the two stopped this row. ANDing them (the pre-2026-08-13
  // form) collapsed both into pass=false, and the rationale builder guessed
  // "below the floor" — printing that on rows clearing it by 6.9pp. A suppressed
  // side and a failed floor are different facts and must not share one message.
  if (noNet != null && noNet >= minEdgeNo) {
    if (noSideEnabled) {
      return { pass: true, dirYes: false, netEdge: noNet, yesNet, noNet, reason: null };
    }
    return { pass: false, dirYes: null, netEdge: null, yesNet, noNet, reason: 'no_side_disabled' };
  }
  return { pass: false, dirYes: null, netEdge: null, yesNet, noNet, reason: 'below_floor' };
}

// YES favorite/longshot recalibration (TOOL_RECALIBRATION_ROUND2_2026-07-21) — pure.
// Given the live yesAsk, returns the effective YES post-spread floor and whether
// the YES side is a suppressed longshot:
//   - favorites (yesAsk >= favPrice) must clear favFloor (10pp) — the 85-92c
//     model-saturation artifact (model 89.8% vs realized 75.7%, n=37);
//   - mid-band keeps midFloor (5pp) — the tool's entire realized profit;
//   - longshots (yesAsk < longshotMin, i.e. <15c) are flagged for suppression.
// enabled=false reverts to symmetric: midFloor everywhere, never a longshot.
// Longshot suppression itself is applied at the call site (only when a YES BUY
// would otherwise fire); this helper only classifies the price.
export function resolveYesFloor({ yesAsk, enabled = true, favPrice, favFloor, midFloor, longshotMin }) {
  if (!enabled) return { minEdgeYes: midFloor, longshot: false };
  const minEdgeYes = yesAsk != null && yesAsk >= favPrice ? favFloor : midFloor;
  const longshot = yesAsk != null && yesAsk < longshotMin;
  return { minEdgeYes, longshot };
}

// Physical-measure mu for the TWAP path (BITCOIN_V2_CUTOVER_2026-07-27) — pure.
// shStats.mu_annual arrives pre-clamped to +/-3.0/yr (MU_CAP in
// short-horizon-vol.js) — a 60d-drift sanity band, ~30x too tight for
// intra-hour momentum. Consume the RAW buffer drift instead, shrunk by
// lambda (scale) and clamped to a horizon-appropriate +/-capAnnual. Falls
// back to the clamped mu when the raw field is absent (old buffer shape) so
// a partial deploy can't produce an undefined mu; degrades to 0 (= pure
// vol model) when neither resolved.
export function resolveTwapMu({ muRaw, muClamped = null, scale = BTC_MU_SCALE, capAnnual = BTC_MU_CAP_ANNUAL }) {
  const base = Number.isFinite(muRaw) ? muRaw : Number.isFinite(muClamped) ? muClamped : 0;
  const scaled = base * scale;
  return Math.max(-capAnnual, Math.min(capAnnual, scaled));
}

// Returns { meta, rows } shaped for the supabase writer. Returns null if any
// upstream feed has no data yet (cold-start race) or a fail-open guard fires.
export async function computeSnapshot(config, event, { now = new Date() } = {}) {
  // Spot source ladder (oil-specific path is the most complex):
  //   silver/gold        → Pyth via getPrice(config.pythSymbol)
  //   bitcoin            → BRTI constituent basket (getBrtiSpot) — Kalshi
  //                        settles KXBTCD on CF Benchmarks BRTI, so the basket
  //                        that BRTI is computed from beats Pyth's own aggregate
  //   oil PRIMARY        → USO-synthetic (Databento USO mid × FRED anchor)
  //   oil SECONDARY      → contract-aware Yahoo (CLM26.NYM etc.)
  //   oil TERTIARY       → Yahoo CL=F continuous (getOilSpot)
  // USO-synthetic landed 2026-05-22 as Phase B of the V2 cutover plan;
  // Yahoo paths are preserved as fallbacks so any synthetic failure mode
  // is covered without a deploy. See src/feeds/uso-synthetic.js.
  const useUsoSynthetic = config.useUsoSynthetic === true;
  const useYahooSpot = config.useYahooSpot === true;
  const useBrtiSpot = config.useBrtiSpot === true;
  const usePythWtiSpot = config.usePythWtiSpot === true;

  // Chain must be fetched before spot when useUsoSynthetic is on — the
  // synthetic needs the live USO mid that already rides on every chain
  // contract as underlyingPrice. For Pyth/Yahoo paths the order doesn't
  // matter, so we always fetch chain first to keep one code path.
  const chain = getChain(config.underlyingEtf);

  let spot = null;

  // PRIMARY (oil only): USO-synthetic. Derives WTI spot from live USO mid
  // off the chain × daily wti/uso ratio anchored to FRED DCOILWTICO.
  if (useUsoSynthetic && chain?.contracts?.length > 0) {
    const usoLive = chain.contracts.find((c) => c.underlyingPrice != null)?.underlyingPrice;
    if (usoLive > 0) {
      try {
        const synthetic = await synthesizeWtiSpot(usoLive);
        if (synthetic) {
          spot = synthetic;
          console.log(
            `[${config.commodity}] USO-synthetic spot: USO $${usoLive.toFixed(2)} × ${synthetic.anchor.wti_per_uso.toFixed(4)} = $${synthetic.price.toFixed(2)} WTI (anchor ${synthetic.anchor.as_of})`,
          );
        } else {
          console.warn(
            `[${config.commodity}] USO-synthetic returned null (anchor unavailable) — falling back to contract-aware Yahoo`,
          );
        }
      } catch (err) {
        console.warn(
          `[${config.commodity}] USO-synthetic threw: ${err?.message || err} — falling back to contract-aware Yahoo`,
        );
      }
    } else {
      console.warn(
        `[${config.commodity}] no underlyingPrice on chain contracts — falling back to contract-aware Yahoo`,
      );
    }
  }

  // PRIMARY (oil, 2026-08-27): Pyth front-month WTI future off Pythnet.
  //
  // Freshness is checked HERE rather than trusted, because getPrice() returns the
  // last cached tick whether or not upstream is still alive — the exact shape that
  // let gold and silver sit frozen for 28 hours while looking fine
  // (docs/lessons/freshness-is-a-property-of-the-timestamp.md in the site repo).
  // Stale => fall through to the Yahoo rungs rather than publish a dead number.
  if (!spot && usePythWtiSpot) {
    const px = getPrice(WTI_FRONT_MONTH_SYMBOL);
    const ageMs = px ? Date.now() - px.publishTimeMs : Infinity;
    if (px && ageMs <= PYTH_WTI_MAX_AGE_MS) {
      spot = px;
      console.log(
        `[${config.commodity}] PRIMARY spot ${px.source} = $${px.price.toFixed(2)} (${Math.round(ageMs / 1000)}s old)`,
      );
    } else if (px) {
      console.warn(
        `[${config.commodity}] Pyth WTI is ${Math.round(ageMs / 60000)}min stale — falling back to Yahoo`,
      );
    }
  }

  // SECONDARY (oil only): contract-aware Yahoo (Part B of
  // OIL_EDGE_WTI_ROLLOVER_FIX_2026-05-13). Resolve the active settle
  // contract from Kalshi /series and pull the matching specific-month
  // Yahoo ticker (CLM26.NYM, CLN26.NYM, ...).
  if (!spot && useYahooSpot && config.useContractAwareSpot === true) {
    try {
      const settle = await getActiveSettleContract(config.seriesTicker, event.closeTime);
      if (settle) {
        const cSpot = await getContractSpot(settle.yyyymm);
        if (cSpot && cSpot.price > 0) {
          spot = {
            price: cSpot.price,
            publishTimeMs: cSpot.publishTimeMs,
            source: cSpot.source, // e.g. 'yahoo_clm26_nym'
          };
          console.log(
            `[${config.commodity}] FALLBACK contract-aware spot ${settle.contract} (${cSpot.symbol}) = $${cSpot.price.toFixed(2)}`,
          );
        } else {
          console.warn(
            `[${config.commodity}] contract-aware spot lookup empty for ${settle.contract} — falling back to CL=F`,
          );
        }
      } else {
        console.warn(
          `[${config.commodity}] could not resolve settle contract for ${config.seriesTicker} — falling back to CL=F`,
        );
      }
    } catch (err) {
      console.warn(
        `[${config.commodity}] contract-aware spot resolution failed: ${err?.message || err} — falling back to CL=F`,
      );
    }
  }

  // TERTIARY: silver/gold = Pyth; bitcoin = BRTI basket; oil = Yahoo CL=F.
  if (!spot) {
    spot = useYahooSpot
      ? getOilSpot()
      : useBrtiSpot
        ? getBrtiSpot()
        : getPrice(config.pythSymbol);
    if (spot && useYahooSpot) {
      console.log(`[${config.commodity}] TERTIARY spot ${spot.source} = $${spot.price.toFixed(2)}`);
    }
  }

  if (!spot) {
    console.warn(
      `[${config.commodity}] no spot price (${
        useYahooSpot ? 'yahoo CL=F' : useBrtiSpot ? 'BRTI basket' : `pyth ${config.pythSymbol}`
      }) — skipping snapshot`,
    );
    return null;
  }
  if (!chain || !chain.contracts || chain.contracts.length === 0) {
    console.warn(
      `[${config.commodity}] empty chain — skipping snapshot (chain=${chain ? 'present' : 'null'}, contracts=${chain?.contracts?.length ?? 0})`,
    );
    return null;
  }

  const spotPrice = spot.price;
  let etfPrice =
    chain.contracts.find((c) => c.underlyingPrice != null)?.underlyingPrice || null;
  if (!etfPrice) {
    try {
      etfPrice = await fetchPrevClose(config.underlyingEtf);
    } catch (err) {
      console.warn(`[${config.commodity}] ${config.underlyingEtf} spot fallback failed: ${err?.message || err}`);
      return null;
    }
  }
  if (!etfPrice || etfPrice <= 0 || spotPrice <= 0) {
    console.warn(
      `[${config.commodity}] bad spot/etf — skipping snapshot (etfPrice=${etfPrice}, spotPrice=${spotPrice})`,
    );
    return null;
  }

  const ratio = etfPrice / spotPrice;
  const closeMs = new Date(event.closeTime).getTime();
  const T = yearFraction(now.getTime() / 1000, closeMs / 1000);
  if (T <= 0) {
    console.warn(
      `[${config.commodity}] event already expired — skipping snapshot (closeTime=${event.closeTime}, T=${T})`,
    );
    return null;
  }

  const smile = buildIvSmile(chain.contracts, etfPrice);

  // V2 physical-measure inputs — drift + realized vol estimated once per
  // snapshot, then applied per-strike alongside the legacy risk-neutral path.
  // Both drift and vol estimators are cached internally; warmVolCache populates
  // the synchronous cache estimateVol() reads from when iterating strikes.
  // Failures fall back to mu=0 / vol=iv (i.e. v2 collapses to v1 behaviour
  // for that snapshot) — never throws.
  let driftEst = null;
  try {
    driftEst = await estimateDrift(config.commodity, { now });
  } catch (err) {
    console.warn(`[${config.commodity}] drift estimate failed: ${err?.message || err}`);
  }
  try {
    await warmVolCache(config.commodity, { now });
  } catch (err) {
    console.warn(`[${config.commodity}] vol cache warm failed: ${err?.message || err}`);
  }
  const muUsed = driftEst?.mu ?? null;
  const muSource = driftEst?.source ?? 'fallback_zero';
  const muConfidence = driftEst?.confidence ?? 'low';

  // Short-horizon σ + μ estimator (Pyth tick buffer). When config.use-
  // ShortHorizonRv is true, the per-strike vol blender below uses these
  // realized estimates instead of the σ × shortHorizonVolScale ramp. The
  // ramp stays wired as a cold-buffer fallback only — on the first ~5min
  // after a Fly redeploy or when the Pyth feed is stale, shStats is null
  // and rows go out with quality_flag='cold_buffer'.
  let shStats = null;
  let eventColdBuffer = false;
  if (config.useShortHorizonRv === true) {
    shStats = getShortHorizonStats(config.commodity, {
      lookbackMin: config.shortHorizonLookbackMin ?? 15,
      now,
    });
    if (shStats == null) eventColdBuffer = true;
  }
  // α(T) blend factor — full short-horizon RV at T → 0, full IV smile at
  // T ≥ shortHorizonVolCapHours. Linear ramp in between. Computed once
  // per snapshot since T is constant across the strikes of an event.
  const shortHorizonCapHours = config.shortHorizonVolCapHours ?? 1;
  const T_hours = T * 365 * 24;
  const alphaShortHorizon = shortHorizonCapHours > 0
    ? Math.max(0, Math.min(1, 1 - T_hours / shortHorizonCapHours))
    : 0;

  // FRED Phase 5 cross-check — once per snapshot. Compares realtime spot
  // (Pyth or Yahoo) against the FRED daily close. >150bp divergence flags
  // the realtime feed as likely stale; per-row tier/confidence get
  // demoted one notch downstream. Silver/copper opt out via fredSeriesId=null.
  let fredDivergenceBp = null;
  let divergenceWarning = false;
  let fredObservationDate = null;
  // Why the tier got demoted — FRED divergence or spot staleness. Kept separate
  // from the boolean so the caveat text can name the real cause.
  let spotWarningReason = null;
  if (config.fredSeriesId) {
    const fred = await getFredDailyClose(config.fredSeriesId);
    if (fred && fred.age_hours < FRED_MAX_AGE_HOURS && fred.price > 0) {
      fredDivergenceBp = ((spotPrice - fred.price) / fred.price) * 10000;
      fredObservationDate = fred.observation_date;
      if (Math.abs(fredDivergenceBp) > FRED_DIVERGENCE_BP_THRESHOLD) {
        divergenceWarning = true;
        spotWarningReason =
          `spot diverges from FRED ${config.fredSeriesId} by ` +
          `${Math.abs(fredDivergenceBp).toFixed(0)}bp`;
        console.warn(
          `[${config.commodity}] FRED divergence ${fredDivergenceBp.toFixed(0)}bp ` +
          `(spot ${spotPrice.toFixed(2)} vs FRED ${config.fredSeriesId} ` +
          `${fred.price.toFixed(2)} on ${fredObservationDate}) — demoting tier`,
        );
      }
    }
  }

  // Spot staleness gate (2026-08-19). Replaces what the FRED cross-check was
  // meant to do for gold and never did: GOLDPMGBD228NLBM was deleted from FRED
  // on 2022-01-31 (ICE Benchmark Administration licensing) but was wired up in
  // 2026-05, so every gold snapshot since called a dead series, took a 400, and
  // skipped the check while the config claimed a guard existed.
  //
  // Checking the feed's OWN publish timestamp is a better instrument than
  // cross-checking its price against a second vendor's daily close: divergence
  // is an indirect proxy for staleness, needs a second dependency, and can be
  // withdrawn from under us (which is exactly what happened). Pyth publishes
  // publish_time on every tick and pyth.js already carries it through as
  // publishTimeMs.
  //
  // Opt-in per commodity via config.maxSpotAgeMs — null means no gate, matching
  // how fredSeriesId opts out. Oil deliberately has none: its spot is Yahoo CL=F
  // on a ~15-minute delay, so a Pyth-scale threshold would flag it permanently,
  // and its FRED series (DCOILWTICO) still resolves.
  const maxSpotAgeMs = config.maxSpotAgeMs ?? null;
  const spotAgeMs = spot.publishTimeMs ? Date.now() - spot.publishTimeMs : null;
  if (maxSpotAgeMs && spotAgeMs !== null && spotAgeMs > maxSpotAgeMs) {
    divergenceWarning = true;
    spotWarningReason =
      `${spot.source ?? 'spot'} last published ${(spotAgeMs / 1000).toFixed(0)}s ago ` +
      `(max ${(maxSpotAgeMs / 1000).toFixed(0)}s)`;
    console.warn(
      `[${config.commodity}] STALE SPOT — ${spotWarningReason} — demoting tier`,
    );
  }

  // --- Atomic Kalshi leg (2026-06-10 stale-Kalshi-leg fix) ---
  // event.markets was captured at discovery and the event-refresh timer only
  // re-pulls every 30 min — for hourly KXBTCD that book could be ~1h stale
  // while spot + the IBIT chain ran live every snapshot, surfacing any BTC move
  // since discovery as a phantom edge. The Kalshi WS overlay was meant to keep
  // it fresh but only ~12% of bitcoin strikes ever get a live frame. Re-pull
  // the whole book in one with_nested_markets call here, in the same pass as
  // spot, and stamp kalshi_quoted_at. The WS overlay (mergeLiveQuote) still
  // applies on top; this guarantees the REST base is current, not hours old.
  // On refetch failure we fall back to the discovery markets and let the
  // staleness guard below flag them via event.fetchedAtMs.
  let snapshotMarkets = event.markets;
  let kalshiQuotedAtMs = event.fetchedAtMs ?? null;
  try {
    const refreshed = await refetchEventMarkets(event.eventTicker);
    if (refreshed.markets.length > 0) {
      snapshotMarkets = refreshed.markets;
      kalshiQuotedAtMs = refreshed.fetchedAtMs;
    } else {
      console.warn(`[${config.commodity}] kalshi book refetch returned 0 markets — using discovery snapshot`);
    }
  } catch (err) {
    console.warn(
      `[${config.commodity}] kalshi book refetch failed: ${err?.message || err} — using discovery snapshot`,
    );
  }
  const kalshiQuotedAtIso = kalshiQuotedAtMs != null ? new Date(kalshiQuotedAtMs).toISOString() : null;
  const kalshiSkewSeconds =
    kalshiQuotedAtMs != null ? Math.max(0, Math.round((now.getTime() - kalshiQuotedAtMs) / 1000)) : null;

  // --- Bitcoin-only strike band (2026-06-10 BITCOIN_EDGE_STRIKE_BAND handoff) ---
  // Persist + evaluate only strikes within ±strikeBandPct of spot OR with a live
  // two-sided book (union). The hourly KXBTCD ladder spans the whole wing (~188
  // strikes), but hourly BTC σ ≈ 0.4–0.7% makes anything past ±6% unreachable
  // within the contract's life — 85% of those strikes carry zero volume, no
  // book, or a prob saturated at 0/1. Filtering here (not just on display) means
  // skipped strikes write no row at all — no dead-weight flag rows. Bitcoin-only
  // via config.strikeBandPct; silver/gold/oil leave it unset and keep the full
  // (already-narrow) ladder. The live-book arm still captures cascade-hour wing
  // strikes that traders are actively quoting beyond ±6%.
  if (config.strikeBandPct != null && spotPrice > 0) {
    const band = config.strikeBandPct;
    const before = snapshotMarkets.length;
    snapshotMarkets = snapshotMarkets.filter((m) => {
      if (m.floorStrike == null) return false;
      const withinBand = Math.abs(m.floorStrike / spotPrice - 1) <= band;
      const liveBook = (m.yesBid ?? 0) > 0 && (m.yesAsk ?? 0) > 0;
      return withinBand || liveBook;
    });
    console.log(
      `[${config.commodity}] strike band ±${(band * 100).toFixed(0)}% of $${spotPrice.toFixed(0)}: ${snapshotMarkets.length}/${before} strikes kept`,
    );
  }

  // Flags that force a non-actionable row regardless of which guard set them,
  // so any downstream consumer that doesn't filter quality_flag still sees
  // PASS/skip rather than a phantom BUY (the tool_picks feed reads engine
  // output directly). Applied per-row just before push.
  const HARD_SUPPRESS_FLAGS = new Set([
    'kalshi_no_book',
    'kalshi_stale',
    'edge_implausible',
    'kalshi_stale_divergence',
    'kalshi_thin_book_large_edge',
    'twap_settle_window',
  ]);

  const rows = [];
  for (const rawMarket of snapshotMarkets) {
    if (rawMarket.floorStrike == null) continue;
    const market = mergeLiveQuote(rawMarket);
    const kSpot = market.floorStrike;
    const kEtf = kSpot * ratio;
    const ivResult = smile.ivAt(kEtf);
    const iv = ivResult?.iv ?? null;
    const ivSpeculative = !!ivResult?.speculative;

    let optProb = null;             // v1 risk-neutral
    let probPhysical = null;        // v2 physical-measure
    let rowMuUsed = muUsed;         // mu actually driving THIS row's physical prob
    let rowMuSource = muSource;     //   (TWAP warm-buffer path overrides below)
    let volEst = null;
    let sigmaBlendVal = null;
    let sigmaIvVal = null;
    let sigmaRv20Val = null;
    let sigmaSource = null;
    if (iv != null && iv > 0 && T > 0) {
      // Per-commodity dividend yield: silver/gold/oil/bitcoin all inherit the
      // global 0.0 (commodities + spot-BTC pay no cash dividend); SPX sets
      // 0.013 explicitly in commodities.js because SPY's ~1.3% dividend yield
      // materially shifts the risk-neutral drift for sub-hour expiries.
      const q = config.dividendYield ?? DIVIDEND_YIELD;
      volEst = estimateVol(iv, config.commodity);
      const sigmaIvBlend = volEst?.sigma_blend ?? iv;
      sigmaBlendVal = volEst?.sigma_blend ?? null;
      sigmaIvVal = volEst?.sigma_iv ?? iv;
      sigmaRv20Val = volEst?.sigma_rv20 ?? null;
      sigmaSource = volEst?.source ?? 'iv_only';
      const muForPhysical = muUsed != null ? muUsed : (RISK_FREE_RATE - q);
      // Sub-hour TWAP-settled commodities (KXBTCD): route through
      // probAboveTwap which integrates the Asian-window variance σ²(T-2τ/3)
      // and the drift period (T-τ/2). The σ + μ inputs differ depending on
      // whether we have a warm Pyth tick buffer:
      //
      //   • Warm buffer + config.useShortHorizonRv:
      //       σ_eff = α(T) × σ_rv_short + (1-α) × σ_iv_blend
      //       μ_eff = shStats.mu_annual  (RV-based intra-hour drift)
      //       probAboveTwap called with scale=1 — boost is folded into σ_eff.
      //
      //   • Cold buffer (eventColdBuffer): fall back to the σ × shortHorizon-
      //       VolScale ramp inside probAboveTwap. Rows downstream get
      //       quality_flag='cold_buffer' so the site reader can suppress.
      //
      //   • No twapWindowSeconds: silver/gold/oil/spx/copper — daily settles,
      //       standard probAboveStrike + probAboveStrikePhysical path.
      if (config.twapWindowSeconds != null) {
        let sigmaRiskNeutral = iv;
        let sigmaPhysical = sigmaIvBlend;
        let muPhysicalForTwap = muForPhysical;
        let twapScale = 1;
        const twapCapHours = shortHorizonCapHours;
        if (shStats != null) {
          sigmaRiskNeutral = alphaShortHorizon * shStats.sigma_annual + (1 - alphaShortHorizon) * iv;
          sigmaPhysical    = alphaShortHorizon * shStats.sigma_annual + (1 - alphaShortHorizon) * sigmaIvBlend;
          muPhysicalForTwap = resolveTwapMu({
            muRaw: shStats.mu_annual_raw,
            muClamped: shStats.mu_annual,
            scale: config.shortHorizonMuScale ?? BTC_MU_SCALE,
            capAnnual: config.shortHorizonMuCapAnnual ?? BTC_MU_CAP_ANNUAL,
          });
          rowMuUsed = muPhysicalForTwap;
          rowMuSource = `pyth_short_horizon_${config.shortHorizonLookbackMin ?? 15}m`;
          sigmaSource = `pyth_short_horizon_alpha_${alphaShortHorizon.toFixed(2)}`;
        } else if (eventColdBuffer) {
          // Cold-buffer fallback: use the old σ × shortHorizonVolScale ramp
          // inside probAboveTwap. scale > 1 only matters until T = capHours.
          twapScale = config.shortHorizonVolScale ?? 1;
        }
        optProb = probAboveTwap(
          spotPrice,
          kSpot,
          T,
          RISK_FREE_RATE - q,
          sigmaRiskNeutral,
          config.twapWindowSeconds,
          twapScale,
          twapCapHours,
        );
        probPhysical = probAboveTwap(
          spotPrice,
          kSpot,
          T,
          muPhysicalForTwap,
          sigmaPhysical,
          config.twapWindowSeconds,
          twapScale,
          twapCapHours,
        );
      } else {
        optProb = probAboveStrike(spotPrice, kSpot, T, RISK_FREE_RATE, q, iv);
        probPhysical = probAboveStrikePhysical(spotPrice, kSpot, T, muForPhysical, sigmaIvBlend);
      }
    }

    const kalshiProb = kalshiYesImpliedProb(market);
    const kalshiView = classifyKalshiView(market);
    // Row-level suppression flag. Set when the Kalshi side has no usable
    // price (no live two-sided book + insufficient recent volume to trust
    // any standing print). Site reader filters quality_flag IS NULL, so a
    // flagged row exists in the table for audit but never reaches the UI —
    // kills the 8¢/60¢ phantom-edge artifact at the source instead of
    // shipping kalshi_yes=0 + a fake edge against the options-implied prob.
    let qualityFlag = null;
    if (kalshiProb == null) qualityFlag = 'kalshi_no_book';
    // Cold-buffer flag: short-horizon RV was requested but Pyth buffer was
    // empty / stale this tick. Row uses the σ × shortHorizonVolScale fallback
    // — site reader suppresses these so the public surface stays clean.
    if (eventColdBuffer && qualityFlag == null) qualityFlag = 'cold_buffer';
    // Kalshi staleness guard (2026-06-10). kalshi_quoted_at is the actual fetch
    // time of the Kalshi book leg; spot + chain are live per snapshot. If the
    // book leg is more than KALSHI_MAX_SKEW_SECONDS behind this snapshot — the
    // per-snapshot refetch failed and we fell back to the discovery payload, or
    // the API is lagging — any computed edge is a leg-skew artifact. Suppress
    // like kalshi_no_book; the row persists for audit, the site reader hides it.
    if (
      qualityFlag == null &&
      kalshiSkewSeconds != null &&
      kalshiSkewSeconds > KALSHI_MAX_SKEW_SECONDS
    ) {
      qualityFlag = 'kalshi_stale';
    }

    let edge = null;
    if (optProb != null && kalshiProb != null && kalshiProb > 0) edge = optProb - kalshiProb;
    let physicalEdge = null;
    if (probPhysical != null && kalshiProb != null && kalshiProb > 0) physicalEdge = probPhysical - kalshiProb;

    // V2 cutover (2026-05-21). When config.useV2Cutover === true (silver/
    // gold/oil), the physical-measure edge drives direction/confidence/tier/
    // routing. Bitcoin (and any commodity without the flag) keeps V1
    // risk-neutral by construction — its runtime code path is byte-for-byte
    // unchanged. Graceful per-snapshot fallback: if drift estimator or
    // probAboveStrikePhysical returned null this tick, we silently revert
    // to V1 for that row. Always keep edge_pp column = V1 for backtest A/B.
    const v2Eligible = config.useV2Cutover === true;
    const v2Available = v2Eligible && physicalEdge != null && probPhysical != null;
    const activeModelVersion = v2Available ? 'v2_physical' : 'v1_riskneutral';

    // V2.1 calibration layer (§4.2). The governing map is stored on every v2
    // row — shadow AND active — so it can be scored before it is trusted.
    // v2Available already guarantees kalshiProb is non-null and > 0 (it is a
    // precondition of physicalEdge), so the calibrated edge below is safe.
    const calMap = getCalibrationMap(config.commodity);
    const calibratedProb = v2Available ? applyCalibration(calMap, probPhysical) : null;
    const calibrationMapId = calibratedProb != null ? calMap.id : null;
    // ACTIVE means calibration owns the decision: direction, edge, tier, alert
    // and the bot's sizing all read one basis. Shadow stores and observes only.
    const calGoverns = calibratedProb != null && calMap.active === true;

    const chosenEdge = calGoverns
      ? calibratedProb - kalshiProb
      : v2Available
        ? physicalEdge
        : edge;
    const chosenProb = calGoverns ? calibratedProb : v2Available ? probPhysical : optProb;

    // Quote age — Kalshi WS frames carry a `ts` (ms epoch) on the merged
    // market object via mergeLiveQuote / kalshi.js applyTickerMsg. Falls
    // back to null when only the REST seed is present (no live frame yet).
    const quoteTsMs = market.quoteTsMs ?? null;
    const quoteAgeSeconds =
      quoteTsMs != null ? Math.max(0, Math.round((now.getTime() - quoteTsMs) / 1000)) : null;

    let direction = 'PASS';
    let confidence = 'skip';
    let rationale = null;
    // The edge THE POSITION ACTUALLY CLEARS — gross minus the ask-side spread
    // minus the Kalshi fee (§1.4). Null on every row that never reaches the
    // post-spread gate (no book, below the gross floor, or a commodity without
    // it enabled), which is honest: we did not compute one.
    let netEdgePp = null;

    // (The old TWAP hard-guard block was removed 2026-05-22. The graduated
    // tier-ceiling logic further down — `config.tierCeilingByMinutes` —
    // demotes near-settlement signals through the existing tier ladder
    // instead of force-suppressing every row at a single threshold.)
    const minutesToClose = (closeMs - now.getTime()) / 60000;

    if (chosenEdge == null) {
      // Edge is null for two distinct reasons; before today both collapsed
      // to "Missing IV" which masked the more common cause (no Kalshi bid
      // on a thin strike). kalshiYesImpliedProb now returns null when
      // there is neither a two-sided book nor a recent in-band last print.
      if (chosenProb == null) {
        rationale = `Missing IV (could not interpolate from ${config.underlyingEtf} chain)`;
      } else if (kalshiProb == null) {
        rationale = 'No Kalshi quote (no live book + insufficient recent volume)';
      } else {
        rationale = 'No Kalshi quote (zero bid, no recent print)';
      }
    } else if (Math.abs(chosenEdge) < MIN_EDGE_PP) {
      // WATCH lean (2026-06-10). 0.03 ≤ |edge| < 0.05 on a real two-sided book
      // is a directional lean, not a BUY (those stay ≥5pp). confidence='watch';
      // direction stays PASS so it's excluded from topEdge/Discord. The read
      // side derives the lean side from the edge sign and renders an amber
      // WATCH chip. Requires an actual book (tight/live/wide) — a stale print or
      // no-market stays the old non-actionable 'low' so we never lean on a
      // ghost quote. Bitcoin-only via config.watchTierEnabled.
      const hasBook =
        kalshiView === 'tight_book' || kalshiView === 'live' || kalshiView === 'wide_spread';
      if (config.watchTierEnabled === true && Math.abs(chosenEdge) >= WATCH_EDGE_PP && hasBook) {
        confidence = 'watch';
        const leanYes = chosenEdge > 0;
        const modelPct = (chosenProb * 100).toFixed(0);
        const kpPct = (kalshiProb * 100).toFixed(0);
        const edgePct = Math.abs(chosenEdge * 100).toFixed(1);
        rationale =
          `WATCH lean ${leanYes ? 'YES' : 'NO'}: model implies ${modelPct}% vs market ${kpPct}% ` +
          `— ${edgePct}pp gap, below the ${(MIN_EDGE_PP * 100).toFixed(0)}pp BUY threshold. Lean, not actionable.`;
      } else {
        confidence = 'low';
        rationale = `Edge ${(chosenEdge * 100).toFixed(1)}pp below ${(MIN_EDGE_PP * 100).toFixed(0)}pp threshold`;
      }
    } else if (kalshiView === 'no_market') {
      rationale = 'No Kalshi market depth — cannot execute';
    } else {
      // Side selection + actionability. Default (silver/gold/oil, and any
      // commodity without the bitcoin post-spread gate): legacy symmetric path —
      // side from the edge sign, confidence magnitude = |edge|. Unchanged.
      let dirYes = chosenEdge > 0;
      let mag = Math.abs(chosenEdge);
      let buyOk = true;

      // Bitcoin-only post-spread gate (BITCOIN_EDGE_NO_SIDE_FIX_2026-06-16).
      // Replaces the symmetric |edge| < MIN_EDGE_PP gate + sign-only side pick.
      // Charges each side its actual ask-side spread off the live Kalshi book and
      // holds the NO side to a stricter floor. A gross |edge| that cleared
      // MIN_EDGE_PP but whose chosen side doesn't clear its POST-SPREAD floor is
      // NOT a BUY — emit PASS/low so both the bot (reads direction) and tool_picks
      // (trigger records only direction IN ('BUY YES','BUY NO')) skip it.
      if (config.postSpreadGate === true) {
        // YES-side favorite/longshot recalibration (TOOL_RECALIBRATION_ROUND2_2026-07-21).
        // A YES BUY at/above the favorite price line must clear the stricter
        // post-spread floor (the 85-92c model-saturation artifact — model 89.8%
        // vs realized 75.7% on the favorite band); a YES BUY under 15c is
        // suppressed outright (longshot band, 2/14 realized). Mid-band (20-70c)
        // YES keeps the 5pp floor — that band is the tool's entire realized profit.
        // Bitcoin-only via config; kill switch config.yesFavoriteEnabled reverts
        // to the symmetric YES floor without redeploying gate math.
        const yesFavEnabled = config.yesFavoriteEnabled ?? true;
        const { minEdgeYes, longshot: yesPriceLongshot } = resolveYesFloor({
          yesAsk: market.yesAsk,
          enabled: yesFavEnabled,
          favPrice: config.yesFavoritePrice ?? YES_FAVORITE_PRICE,
          favFloor: config.minEdgePpYesFavorite ?? MIN_EDGE_PP_YES_FAVORITE,
          midFloor: MIN_EDGE_PP,
          longshotMin: YES_LONGSHOT_PRICE_MIN,
        });

        const g = postSpreadSideGate({
          chosenProb,
          yesBid: market.yesBid,
          yesAsk: market.yesAsk,
          minEdgeYes,
          minEdgeNo: config.minEdgePpNoSide ?? MIN_EDGE_PP_NO,
          noSideEnabled: config.noSideEnabled ?? true,
          chargeFees: config.chargeFees === true,
        });

        // Longshot suppression: no YES BUYs under 15c, full stop.
        const yesLongshot = g.pass && g.dirYes && yesPriceLongshot;

        if (g.pass && !yesLongshot) {
          dirYes = g.dirYes;
          mag = g.netEdge; // confidence/tier reflect the post-spread, post-fee side edge
          netEdgePp = g.netEdge;
        } else {
          buyOk = false;
          direction = 'PASS';
          confidence = 'low';
          const grossPct = Math.abs(chosenEdge * 100).toFixed(1);
          const noFloor = config.minEdgePpNoSide ?? MIN_EDGE_PP_NO;
          if (yesLongshot) {
            rationale =
              `YES under ${(YES_LONGSHOT_PRICE_MIN * 100).toFixed(0)}¢ — longshot band ` +
              `suppressed (favorite-longshot recalibration 2026-07-21). Not actionable.`;
          } else if (chosenEdge > 0) {
            const netPct = g.yesNet != null ? (g.yesNet * 100).toFixed(1) : 'n/a';
            rationale =
              `YES underpriced by ${grossPct}pp gross, but only ${netPct}pp after the ` +
              `YES ask-side spread — below the ${(minEdgeYes * 100).toFixed(0)}pp net floor. Not actionable.`;
          } else if (g.reason === 'no_side_disabled') {
            // The row cleared the net NO floor; the kill switch stopped it, not the
            // floor. Say that, and do NOT lead with the gross edge — publishing
            // "NO underpriced by 17pp" as the headline on a side we decline to
            // trade reads as a tradeable number to anyone skimming the card.
            rationale =
              `NO side suppressed — the model's NO edge has not held up in live tracking, ` +
              `so we don't publish it as a signal pending recalibration. Not actionable.`;
          } else {
            const netPct = g.noNet != null ? (g.noNet * 100).toFixed(1) : 'n/a';
            rationale =
              `NO underpriced by ${grossPct}pp gross, but only ${netPct}pp after the ` +
              `NO ask-side spread — below the ${(noFloor * 100).toFixed(0)}pp net NO floor. Not actionable.`;
          }
        }
      }

      if (buyOk) {
        direction = dirYes ? 'BUY YES' : 'BUY NO';
        const modelPct = (chosenProb * 100).toFixed(0);
        const kpPct = (kalshiProb * 100).toFixed(0);
        const edgePct = Math.abs(chosenEdge * 100).toFixed(1);
        rationale = `Model implies ${modelPct}% chance ${config.commodity} above $${kSpot.toFixed(2)}, market prices it at ${kpPct}%. ${dirYes ? 'YES' : 'NO'} is underpriced by ${edgePct}pp.`;
        if (mag >= 0.15 && (kalshiView === 'live' || kalshiView === 'tight_book')) confidence = 'high';
        else if (
          mag >= 0.1 &&
          (kalshiView === 'live' || kalshiView === 'tight_book' || kalshiView === 'wide_spread')
        )
          confidence = 'medium';
        else confidence = 'low';
        if (kalshiView === 'stale_print') {
          confidence = 'low';
          rationale += ' (caveat: stale Kalshi print, low recent volume)';
        } else if (kalshiView === 'wide_spread') {
          rationale += ` (caveat: wide bid-ask $${(market.yesBid ?? 0).toFixed(2)}-$${(market.yesAsk ?? 0).toFixed(2)}; verify book depth before sizing)`;
          if (confidence === 'high') confidence = 'medium';
        }
        // Speculative IV cap (handoff §2.3): if the smile leaned on thin-volume
        // contracts (vol ≤ 150), demote actionable rows to 'low' so the site
        // renders advisory rather than tradeable.
        if (ivSpeculative && (confidence === 'high' || confidence === 'medium')) {
          confidence = 'low';
          rationale += ' (caveat: thin options volume on contributing strikes — IV may be unreliable)';
        }
        // V2 Phase 2 liquidity gate: any 'high'/'medium' assignment that fails
        // the explicit (volume, spread, quote age) gate gets demoted to 'low'.
        // Source-of-truth check that catches the 26 silver alerts that shipped
        // on kalshi_volume_24h=0 in May 2026 — the legacy kalshiView=tight_book
        // path didn't enforce a min-volume floor.
        const gate = passesLiquidityGate(market);
        if ((confidence === 'high' || confidence === 'medium') && !gate.ok) {
          confidence = 'low';
          rationale += ` (caveat: liquidity gate failed — ${gate.reason})`;
        }

        // 2026-05-21 unified bitcoin-edge fix (handoffs/BITCOIN_EDGE_KALSHI_STALE_QUOTE_FIX_2026-05-21.md).
        //
        // Edit D — Stale-print divergence ceiling. classifyKalshiView returns
        // 'stale_print' when there's a lastPrice but no live two-sided book +
        // recent volume. The options-implied prob is computed live from spot +
        // chain every snapshot — it cannot be stale by construction. A >25pp
        // gap is the signature of the 8c-vs-60c artifact: an ancient lastPrice
        // from a prior spot regime sitting on a thin or one-sided book. The
        // row stays in the table for audit; the quality_flag hides it from the
        // public surface (site reader filters quality_flag IS NULL).
        if (
          kalshiView === 'stale_print' &&
          chosenProb != null &&
          kalshiProb != null &&
          Math.abs(chosenProb - kalshiProb) > STALE_PRINT_DIVERGENCE_CEILING
        ) {
          qualityFlag = 'kalshi_stale_divergence';
          direction = 'PASS';
          confidence = 'skip';
          rationale =
            `kalshi: stale print ${(kalshiProb * 100).toFixed(0)}c diverges ` +
            `${(Math.abs(chosenProb - kalshiProb) * 100).toFixed(1)}pp from live ` +
            `model ${(chosenProb * 100).toFixed(0)}% — likely stale lastPrice from prior spot regime`;
        }

        // Edit E — Thin-book large-edge ceiling. passesLiquidityGate.ok=false
        // with a still-live bid/ask (kalshiView 'tight_book' or 'live') means
        // the MM is quoting both sides but volume_24h is below the floor — the
        // mid we computed against was a quote that may not have repriced since
        // the last actual trade. An |edge| above 10pp on a market that hasn't
        // traded is more likely a stale-MM-quote artifact than a real edge.
        // Sub-10pp edges remain visible as LOW (the existing demotion ran above).
        // Skip if Edit D already flagged the row.
        if (
          qualityFlag == null &&
          !gate.ok &&
          chosenEdge != null &&
          Math.abs(chosenEdge) > THIN_BOOK_EDGE_CEILING
        ) {
          qualityFlag = 'kalshi_thin_book_large_edge';
          direction = 'PASS';
          confidence = 'skip';
          rationale =
            `kalshi: ${gate.reason} + |edge|=${(Math.abs(chosenEdge) * 100).toFixed(1)}pp ` +
            `— thin-book mid likely stale relative to live model prob`;
        }
      }
    }

    // Sanity cap / defense-in-depth — T-scaled, ALL horizons (EDGE_MARKETS
    // §1.1, 2026-08-31; supersedes the 2026-06-10 ≤30min/25pp form). An |edge|
    // above max(15pp, 6·σ√τ) is a data fault or model saturation by
    // construction — near expiry σ√τ collapses, Φ(d₂) pins at 0/1, and the
    // residual gap is the book's tail premium, not information (the Friday
    // 99%-vs-79¢ gold STRONGs, observed live 2026-08-28; bitcoin's measured
    // version: claimed 0.794, realized 0.481). σ is whichever annualized vol
    // actually drove the model prob this row (blend preferred); when chosenEdge
    // is non-null the iv branch ran, so a σ is always available here.
    // Derivation of the 6·σ√τ form: thresholds.js EDGE_IMPLAUSIBLE_SIGMA_MULT.
    const implausibleSigma = sigmaBlendVal ?? sigmaIvVal ?? iv;
    const implausibleCeiling = edgeImplausibleThreshold(implausibleSigma, T);
    if (
      qualityFlag == null &&
      chosenEdge != null &&
      Math.abs(chosenEdge) > implausibleCeiling
    ) {
      qualityFlag = 'edge_implausible';
      rationale =
        `edge_implausible: |edge|=${(Math.abs(chosenEdge) * 100).toFixed(1)}pp exceeds ` +
        `${(implausibleCeiling * 100).toFixed(1)}pp ceiling (max(${(EDGE_IMPLAUSIBLE_FLOOR_PP * 100).toFixed(0)}pp, ` +
        `${EDGE_IMPLAUSIBLE_SIGMA_MULT}·σ√τ)) with ${minutesToClose.toFixed(1)}min to close ` +
        `— data fault or model saturation, not a tradeable edge`;
    }

    let fusedTierStr = chosenEdge != null ? fusedTier(Math.abs(chosenEdge)) : 'NO_EDGE';
    let tierInt = confidenceTierInt(fusedTierStr);

    // Graduated tier ceiling by minutes-to-close (replaces the old hard
    // minMinutesToClose guard 2026-05-22). The ladder encodes empirical
    // calibration realism: as T shrinks, the engine's prob estimate
    // becomes less reliable relative to Kalshi's order-flow-aware price.
    // Demotion routes through the same downgradeFusedTier helper the FRED
    // path uses, so the per-row push picks up the new tier + confidence
    // without extra wiring. The SPECULATIVE floor (default 2min) covers
    // the literal TWAP averaging window where the probability math is
    // genuinely undefined and gets tagged with quality_flag.
    if (config.tierCeilingByMinutes != null) {
      const ladder = config.tierCeilingByMinutes;
      let ceiling = null;
      if (ladder.SPECULATIVE != null && minutesToClose < ladder.SPECULATIVE) ceiling = 'NO_EDGE';
      else if (ladder.MODERATE != null && minutesToClose < ladder.MODERATE) ceiling = 'SPECULATIVE';
      else if (ladder.STRONG != null && minutesToClose < ladder.STRONG) ceiling = 'MODERATE';
      if (ceiling != null) {
        const TIER_ORDER = { NO_EDGE: 0, SPECULATIVE: 1, MODERATE: 2, STRONG: 3 };
        const before = fusedTierStr;
        if ((TIER_ORDER[fusedTierStr] ?? 0) > (TIER_ORDER[ceiling] ?? 0)) {
          const notches = (TIER_ORDER[before] ?? 0) - (TIER_ORDER[ceiling] ?? 0);
          fusedTierStr = ceiling;
          tierInt = confidenceTierInt(fusedTierStr);
          for (let i = 0; i < notches; i++) confidence = downgradeLegacyConfidence(confidence);
          if (fusedTierStr === 'NO_EDGE') {
            direction = 'PASS';
            confidence = 'skip';
            if (qualityFlag == null) qualityFlag = 'twap_settle_window';
          }
          const ceilingLabel = ceiling === 'NO_EDGE' ? 'PASS' : ceiling;
          rationale = (rationale ?? '') + ` (tier capped at ${ceilingLabel} — ${minutesToClose.toFixed(1)}min to close)`;
        }
      }
    }

    // FRED Phase 5 — demote tier/confidence one notch when realtime spot
    // diverges from FRED daily close beyond the threshold. SPECULATIVE
    // collapses to NO_EDGE (suppress) and direction reverts to PASS so the
    // actionable filter drops it.
    if (divergenceWarning) {
      fusedTierStr = downgradeFusedTier(fusedTierStr);
      tierInt = confidenceTierInt(fusedTierStr);
      confidence = downgradeLegacyConfidence(confidence);
      if (fusedTierStr === 'NO_EDGE') direction = 'PASS';
      const caveat = ` (caveat: ${spotWarningReason ?? 'realtime spot feed suspect'} — tier demoted)`;
      rationale = (rationale ?? '') + caveat;
    }

    // Hard-suppress normalization (2026-06-10). Any flag in HARD_SUPPRESS_FLAGS
    // means the row is non-tradeable; force PASS/skip so a consumer that doesn't
    // filter quality_flag can't surface a phantom BUY. No-op for flags whose
    // guard already set PASS — just closes the gap for kalshi_stale /
    // edge_implausible, which set only the flag above.
    if (HARD_SUPPRESS_FLAGS.has(qualityFlag) && (direction !== 'PASS' || confidence === 'watch')) {
      direction = 'PASS';
      confidence = 'skip';
    }

    // Loop-engine rule consumption (LOOP_ENGINE_RULES §PR6). Applied LAST, so a
    // rule can only ever narrow what the engine was already going to publish —
    // it can suppress or demote, never create or upgrade. No-op unless the kill
    // switch is on AND an active rule matches every key of its condition.
    // Every application is tagged in the rationale with the rule ids.
    const ruleVerdict = applyEngineRules({
      commodity: config.commodity,
      dow: now.getUTCDay(),
      hourUtc: now.getUTCHours(),
      impliedProb: kalshiProb,
      // The direction computed above, pre-rules -- lets a rule target one side
      // of a price band (see PREDICATE_KEYS note on 'direction').
      direction,
    });
    if (ruleVerdict.matched.length > 0) {
      if (ruleVerdict.suppress) {
        direction = 'PASS';
        confidence = 'skip';
        fusedTierStr = 'NO_EDGE';
        tierInt = confidenceTierInt(fusedTierStr);
      } else if (ruleVerdict.downgrade) {
        fusedTierStr = downgradeFusedTier(fusedTierStr);
        tierInt = confidenceTierInt(fusedTierStr);
        confidence = downgradeLegacyConfidence(confidence);
        if (fusedTierStr === 'NO_EDGE') direction = 'PASS';
      }
      rationale = `${rationale ?? ''} ${ruleVerdict.note}`.trim();
    }

    rows.push({
      snapshot_at: now.toISOString(),
      kalshi_quoted_at: kalshiQuotedAtIso,
      commodity: config.commodity,
      event_ticker: event.eventTicker,
      event_close_at: new Date(closeMs).toISOString(),
      strike: kSpot,
      // kalshi_yes column is NOT NULL — persist 0 when there is no usable
      // price; quality_flag='kalshi_no_book' (set above) tells the site reader
      // to suppress the row even though it exists for audit.
      kalshi_yes: kalshiProb ?? 0,
      kalshi_yes_bid: market.yesBid ?? null,
      kalshi_yes_ask: market.yesAsk ?? null,
      kalshi_volume_24h: Math.round(market.volume24h ?? 0),
      kalshi_open_int: Math.round(market.openInterest ?? 0),
      options_iv: iv ?? null,
      options_prob: optProb ?? null,
      edge_pp: edge ?? null,                  // V1 frozen for backtest A/B
      fused_edge_pp: chosenEdge ?? null,       // V2 active when useV2Cutover=true; drives Discord routing + fusedTier
      // What the trade nets after BOTH costs. `fused_edge_pp` stays the gross
      // model-vs-market gap so the backtest A/B keeps its basis; this is the
      // figure the tier is computed from wherever chargeFees is on.
      net_edge_pp: netEdgePp,
      direction,
      confidence,
      fused_confidence: fusedTierStr,
      rationale,
      quality_flag: qualityFlag,
      spot_price: spotPrice,
      spot_source: spot.source,
      underlying_etf: config.underlyingEtf,
      underlying_price: etfPrice,
      fred_divergence_bp: fredDivergenceBp,
      divergence_warning: divergenceWarning,
      // V2 physical-measure writes. model_version says which model owns the
      // chosen direction/confidence for THIS row (v2_physical once the
      // commodity's useV2Cutover is on and the physical inputs resolved;
      // v1_riskneutral otherwise). mu_used/mu_source record the mu that
      // actually drove prob_physical — on the warm TWAP path that is the
      // short-horizon momentum mu, not the 60d drift estimator.
      prob_physical: probPhysical,
      physical_edge_pp: physicalEdge,
      // Derived model output, same OPRA license class as prob_physical /
      // options_prob — publishable. Non-null on warm v2 rows once a map exists.
      calibrated_prob: calibratedProb,
      calibration_map_id: calibrationMapId,
      mu_used: rowMuUsed,
      mu_source: rowMuSource,
      mu_confidence: muConfidence,
      sigma_blend: sigmaBlendVal,
      sigma_iv: sigmaIvVal,
      sigma_rv20: sigmaRv20Val,
      sigma_source: sigmaSource,
      quote_age_seconds: quoteAgeSeconds,
      model_version: activeModelVersion,
    });
  }

  // ---- Event-level smile-vs-Kalshi sanity check (2026-05-22) ----
  // If our prob curve across strikes doesn't even rank-correlate with
  // Kalshi's, that's a fundamental model failure for this event — not a
  // tradeable edge. Spearman is robust to scale/curvature differences;
  // we only fail when the SHAPE disagrees. Threshold tuned conservatively
  // so smile + Kalshi can disagree on levels (a real edge) without
  // tripping the suppress.
  let smileKalshiCorr = null;
  if (config.smileKalshiCorrCheck === true) {
    const usable = rows.filter(
      (r) =>
        r.options_prob != null &&
        r.kalshi_yes != null &&
        r.kalshi_yes > 0.05 &&
        r.kalshi_yes < 0.95 &&
        r.quality_flag == null,
    );
    if (usable.length >= 4) {
      smileKalshiCorr = spearmanCorr(
        usable.map((r) => r.options_prob),
        usable.map((r) => r.kalshi_yes),
      );
      if (Number.isFinite(smileKalshiCorr) && smileKalshiCorr < 0.5) {
        for (const r of rows) {
          r.quality_flag = r.quality_flag ?? 'smile_kalshi_diverged';
          r.direction = 'PASS';
          r.confidence = 'skip';
          r.fused_confidence = 'NO_EDGE';
          r.rationale =
            (r.rationale ?? '') +
            ` (event-level: engine-prob vs Kalshi-prob Spearman ${smileKalshiCorr.toFixed(2)} — surface diverges, all signals suppressed)`;
        }
      } else if (Number.isFinite(smileKalshiCorr) && smileKalshiCorr < 0.7) {
        for (const r of rows) {
          if (r.fused_confidence === 'STRONG' || r.fused_confidence === 'MODERATE' || r.fused_confidence === 'SPECULATIVE') {
            r.fused_confidence = downgradeFusedTier(r.fused_confidence);
            r.confidence = downgradeLegacyConfidence(r.confidence);
            if (r.fused_confidence === 'NO_EDGE') {
              r.direction = 'PASS';
              r.confidence = 'skip';
            }
            r.rationale =
              (r.rationale ?? '') +
              ` (event-level: engine-prob vs Kalshi-prob Spearman ${smileKalshiCorr.toFixed(2)} — surface partly diverged, tier demoted)`;
          }
        }
      }
    }
  }

  // ---- Snapshot guards (handoff: SILVER_EDGE_GUARDS_2026-05-15) ----
  // Per-row IV cap first (so one bad strike doesn't kill the snapshot).
  const ivCapped = rows.filter((r) => r.options_iv == null || r.options_iv <= IV_HARD_CAP);
  const ivDropped = rows.length - ivCapped.length;
  if (ivDropped > 0) {
    console.warn(
      `[${config.commodity}] iv_cap dropped ${ivDropped} row(s) with options_iv > ${IV_HARD_CAP}`,
    );
  }

  maybeResetSessionFlags(now);
  const validation = validateSnapshot(ivCapped, {
    commodity: config.commodity,
    spotSource: spot.source,
  });
  if (!validation.ok) {
    console.warn(
      `[${config.commodity}] snapshot guard rejected (${validation.reason}): ${JSON.stringify(validation.detail)}`,
    );
    // Fire telemetry async; do not await — the engine moves on to the next tick.
    recordGuardRejection(config.commodity, validation.reason, validation.detail).catch(() => {});
    return null;
  }
  // First clean write of the session — unlatch Guard B so mid-session
  // prev_close_bridge fallbacks are tolerated.
  firstSnapshotWritten.set(config.commodity, true);
  recordGuardOk(config.commodity).catch(() => {});

  const filteredRows = ivCapped;
  // V2 cutover: meta.topEdge reads from fused_edge_pp (= V2 when useV2Cutover
  // is on, = V1 when off or when V2 fell back). Discord routing keys off
  // meta.topTier, which in turn keys off this; we want the active edge.
  const actionable = filteredRows.filter((r) => r.fused_edge_pp != null && (r.direction === 'BUY YES' || r.direction === 'BUY NO'));
  let topEdge = null;
  if (actionable.length > 0) {
    topEdge = actionable.reduce((best, cur) => (Math.abs(cur.fused_edge_pp) > Math.abs(best.fused_edge_pp) ? cur : best));
  }

  // Dealer gamma — uses the same ETF chain + spot + T already in scope. UNIQUE
  // (commodity, snapshot_date) on commodity_gamma_snapshots means intraday
  // ticks update the same row; tomorrow gets a new one.
  const gamma = computeDealerGamma({
    contracts: chain.contracts,
    etfSpot: etfPrice,
    T,
    riskFreeRate: RISK_FREE_RATE,
    dividendYield: config.dividendYield ?? DIVIDEND_YIELD,
  });

  // FRED divergence demotes meta.topTier the same way per-row tiers were
  // demoted, so Discord routing + downstream consumers see the suppressed
  // confidence rather than the raw edge_pp tier.
  const rawTopTier = topEdge ? fusedTier(Math.abs(topEdge.fused_edge_pp)) : 'NO_EDGE';
  const finalTopTier = divergenceWarning ? downgradeFusedTier(rawTopTier) : rawTopTier;

  return {
    meta: {
      commodity: config.commodity,
      eventTicker: event.eventTicker,
      eventCloseAt: new Date(closeMs).toISOString(),
      spotPrice,
      etfPrice,
      atmIv: smile.atmIv,
      generatedAt: now.toISOString(),
      hoursToClose: (closeMs - now.getTime()) / 3.6e6,
      strikeCount: filteredRows.length,
      topEdge,
      topTier: finalTopTier,
      topTierInt: confidenceTierInt(finalTopTier),
      spotLabel: config.spotLabel,
      // Does calibration OWN the decision for this commodity right now? The
      // alert tier ceiling keys on this, not on the presence of a
      // calibrated_prob — shadow rows carry one while decisions still run on
      // the raw model, and lifting the ceiling then would resume STRONG alerts
      // on uncalibrated edges (§4.5 read literally would do exactly that).
      calibrationActive: isCalibrationActive(config.commodity),
      gamma,
      fredDivergenceBp,
      fredObservationDate,
      divergenceWarning,
      smileKalshiCorr,
      shortHorizon: shStats == null
        ? { source: eventColdBuffer ? 'cold_buffer' : 'disabled', alpha: alphaShortHorizon }
        : {
            source: shStats.source,
            sigma_annual: shStats.sigma_annual,
            mu_annual: shStats.mu_annual,
            nTicks: shStats.nTicks,
            lookbackActualMin: shStats.lookbackActualMin,
            alpha: alphaShortHorizon,
          },
    },
    rows: filteredRows,
  };
}

export const __test__ = {
  buildIvSmile,
  postSpreadSideGate,
  resolveYesFloor,
  resolveTwapMu,
  kalshiYesImpliedProb,
  classifyKalshiView,
  passesLiquidityGate,
  validateSnapshot,
  smileCoherenceCheck,
  spearmanCorr,
  IV_HARD_CAP,
  MIN_STRIKES_PER_SNAPSHOT,
  // Test seam: lets unit tests force the first-snapshot flag.
  _firstSnapshotWritten: firstSnapshotWritten,
};
