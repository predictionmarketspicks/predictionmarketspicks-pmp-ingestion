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

import { probAboveStrike, probAboveStrikePhysical, yearFraction } from './options.js';
import { computeDealerGamma } from './gamma.js';
import { estimateDrift } from './drift.js';
import { warmVolCache, estimateVol } from './vol.js';
import {
  MIN_EDGE_PP,
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
} from './thresholds.js';
import { getQuote } from '../feeds/kalshi.js';
import { getChain, fetchPrevClose } from '../feeds/options-provider.js';
import { getPrice } from '../feeds/pyth.js';
import { getOilSpot, getContractSpot } from '../feeds/yahoo-oil.js';
import { synthesizeWtiSpot } from '../feeds/uso-synthetic.js';
import { getFredDailyClose } from '../feeds/fred.js';
import { fetchEvent, getNextEvent } from '../feeds/kalshi-event.js';
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

// Returns { meta, rows } shaped for the supabase writer. Returns null if any
// upstream feed has no data yet (cold-start race) or a fail-open guard fires.
export async function computeSnapshot(config, event, { now = new Date() } = {}) {
  // Spot source ladder (oil-specific path is the most complex):
  //   silver/gold/bitcoin → Pyth via getPrice(config.pythSymbol)
  //   oil PRIMARY        → USO-synthetic (Databento USO mid × FRED anchor)
  //   oil SECONDARY      → contract-aware Yahoo (CLM26.NYM etc.)
  //   oil TERTIARY       → Yahoo CL=F continuous (getOilSpot)
  // USO-synthetic landed 2026-05-22 as Phase B of the V2 cutover plan;
  // Yahoo paths are preserved as fallbacks so any synthetic failure mode
  // is covered without a deploy. See src/feeds/uso-synthetic.js.
  const useUsoSynthetic = config.useUsoSynthetic === true;
  const useYahooSpot = config.useYahooSpot === true;

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

  // TERTIARY: silver/gold/bitcoin = Pyth; oil = Yahoo CL=F continuous.
  if (!spot) {
    spot = useYahooSpot ? getOilSpot() : getPrice(config.pythSymbol);
    if (spot && useYahooSpot) {
      console.log(`[${config.commodity}] TERTIARY spot ${spot.source} = $${spot.price.toFixed(2)}`);
    }
  }

  if (!spot) {
    console.warn(
      `[${config.commodity}] no spot price (${useYahooSpot ? 'yahoo CL=F' : `pyth ${config.pythSymbol}`}) — skipping snapshot`,
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

  // FRED Phase 5 cross-check — once per snapshot. Compares realtime spot
  // (Pyth or Yahoo) against the FRED daily close. >150bp divergence flags
  // the realtime feed as likely stale; per-row tier/confidence get
  // demoted one notch downstream. Silver/copper opt out via fredSeriesId=null.
  let fredDivergenceBp = null;
  let divergenceWarning = false;
  let fredObservationDate = null;
  if (config.fredSeriesId) {
    const fred = await getFredDailyClose(config.fredSeriesId);
    if (fred && fred.age_hours < FRED_MAX_AGE_HOURS && fred.price > 0) {
      fredDivergenceBp = ((spotPrice - fred.price) / fred.price) * 10000;
      fredObservationDate = fred.observation_date;
      if (Math.abs(fredDivergenceBp) > FRED_DIVERGENCE_BP_THRESHOLD) {
        divergenceWarning = true;
        console.warn(
          `[${config.commodity}] FRED divergence ${fredDivergenceBp.toFixed(0)}bp ` +
          `(spot ${spotPrice.toFixed(2)} vs FRED ${config.fredSeriesId} ` +
          `${fred.price.toFixed(2)} on ${fredObservationDate}) — demoting tier`,
        );
      }
    }
  }

  const rows = [];
  for (const rawMarket of event.markets) {
    if (rawMarket.floorStrike == null) continue;
    const market = mergeLiveQuote(rawMarket);
    const kSpot = market.floorStrike;
    const kEtf = kSpot * ratio;
    const ivResult = smile.ivAt(kEtf);
    const iv = ivResult?.iv ?? null;
    const ivSpeculative = !!ivResult?.speculative;

    let optProb = null;             // v1 risk-neutral
    let probPhysical = null;        // v2 physical-measure
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
      optProb = probAboveStrike(spotPrice, kSpot, T, RISK_FREE_RATE, q, iv);
      volEst = estimateVol(iv, config.commodity);
      const sigmaForPhysical = volEst?.sigma_blend ?? iv;
      sigmaBlendVal = volEst?.sigma_blend ?? null;
      sigmaIvVal = volEst?.sigma_iv ?? iv;
      sigmaRv20Val = volEst?.sigma_rv20 ?? null;
      sigmaSource = volEst?.source ?? 'iv_only';
      const muForPhysical = muUsed != null ? muUsed : (RISK_FREE_RATE - q);
      probPhysical = probAboveStrikePhysical(spotPrice, kSpot, T, muForPhysical, sigmaForPhysical);
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
    const chosenEdge = v2Available ? physicalEdge : edge;
    const chosenProb = v2Available ? probPhysical : optProb;
    const activeModelVersion = v2Available ? 'v2_physical' : 'v1_riskneutral';

    // Quote age — Kalshi WS frames carry a `ts` (ms epoch) on the merged
    // market object via mergeLiveQuote / kalshi.js applyTickerMsg. Falls
    // back to null when only the REST seed is present (no live frame yet).
    const quoteTsMs = market.quoteTsMs ?? null;
    const quoteAgeSeconds =
      quoteTsMs != null ? Math.max(0, Math.round((now.getTime() - quoteTsMs) / 1000)) : null;

    let direction = 'PASS';
    let confidence = 'skip';
    let rationale = null;

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
      confidence = 'low';
      rationale = `Edge ${(chosenEdge * 100).toFixed(1)}pp below ${(MIN_EDGE_PP * 100).toFixed(0)}pp threshold`;
    } else if (kalshiView === 'no_market') {
      rationale = 'No Kalshi market depth — cannot execute';
    } else {
      const dirYes = chosenEdge > 0;
      direction = dirYes ? 'BUY YES' : 'BUY NO';
      const modelPct = (chosenProb * 100).toFixed(0);
      const kpPct = (kalshiProb * 100).toFixed(0);
      const edgePct = Math.abs(chosenEdge * 100).toFixed(1);
      rationale = `Model implies ${modelPct}% chance ${config.commodity} above $${kSpot.toFixed(2)}, market prices it at ${kpPct}%. ${dirYes ? 'YES' : 'NO'} is underpriced by ${edgePct}pp.`;
      const mag = Math.abs(chosenEdge);
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

    let fusedTierStr = chosenEdge != null ? fusedTier(Math.abs(chosenEdge)) : 'NO_EDGE';
    let tierInt = confidenceTierInt(fusedTierStr);

    // FRED Phase 5 — demote tier/confidence one notch when realtime spot
    // diverges from FRED daily close beyond the threshold. SPECULATIVE
    // collapses to NO_EDGE (suppress) and direction reverts to PASS so the
    // actionable filter drops it.
    if (divergenceWarning) {
      fusedTierStr = downgradeFusedTier(fusedTierStr);
      tierInt = confidenceTierInt(fusedTierStr);
      confidence = downgradeLegacyConfidence(confidence);
      if (fusedTierStr === 'NO_EDGE') direction = 'PASS';
      const bp = Math.abs(fredDivergenceBp ?? 0).toFixed(0);
      const caveat = ` (caveat: spot diverges from FRED ${config.fredSeriesId} by ${bp}bp — realtime feed may be stale; tier demoted)`;
      rationale = (rationale ?? '') + caveat;
    }

    rows.push({
      snapshot_at: now.toISOString(),
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
      // V2 physical-measure parallel writes (Phase 1). Direction/confidence
      // still derive from the v1 edge during Phase 1; model_version reflects
      // which model owns the chosen direction/confidence, NOT which prob
      // columns are populated.
      prob_physical: probPhysical,
      physical_edge_pp: physicalEdge,
      mu_used: muUsed,
      mu_source: muSource,
      mu_confidence: muConfidence,
      sigma_blend: sigmaBlendVal,
      sigma_iv: sigmaIvVal,
      sigma_rv20: sigmaRv20Val,
      sigma_source: sigmaSource,
      quote_age_seconds: quoteAgeSeconds,
      model_version: activeModelVersion,
    });
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
      gamma,
      fredDivergenceBp,
      fredObservationDate,
      divergenceWarning,
    },
    rows: filteredRows,
  };
}

export const __test__ = {
  buildIvSmile,
  kalshiYesImpliedProb,
  classifyKalshiView,
  passesLiquidityGate,
  validateSnapshot,
  smileCoherenceCheck,
  IV_HARD_CAP,
  MIN_STRIKES_PER_SNAPSHOT,
  // Test seam: lets unit tests force the first-snapshot flag.
  _firstSnapshotWritten: firstSnapshotWritten,
};
