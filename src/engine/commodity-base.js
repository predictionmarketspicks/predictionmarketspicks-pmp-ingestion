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
  RISK_FREE_RATE,
  DIVIDEND_YIELD,
  fusedTier,
  confidenceTierInt,
  downgradeFusedTier,
  downgradeLegacyConfidence,
  FRED_DIVERGENCE_BP_THRESHOLD,
  FRED_MAX_AGE_HOURS,
} from './thresholds.js';
import { getQuote } from '../feeds/kalshi.js';
import { getChain, fetchPrevClose } from '../feeds/options-provider.js';
import { getPrice } from '../feeds/pyth.js';
import { getOilSpot, getContractSpot } from '../feeds/yahoo-oil.js';
import { getFredDailyClose } from '../feeds/fred.js';
import { fetchEvent, getNextEvent } from '../feeds/kalshi-event.js';
import { getActiveSettleContract } from '../feeds/kalshi-series.js';
import { isOptionsMarketOpen } from '../feeds/massive.js';
import { recordGuardRejection, recordGuardOk } from '../observability/health.js';

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
  if (lastPrice != null && lastPrice > 0 && lastPrice < 1) return lastPrice;
  return 0;
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
  const clean = [];
  for (const c of contracts) {
    if (c.iv == null || c.strike == null) continue;
    if (c.strike < lo || c.strike > hi) continue;
    if (c.iv < 0.1 || c.iv > 1.5) continue;
    if (c.strike >= etfSpot && c.contractType === 'call') clean.push([c.strike, c.iv, !!c.speculative]);
    else if (c.strike < etfSpot && c.contractType === 'put') clean.push([c.strike, c.iv, !!c.speculative]);
  }
  clean.sort((a, b) => a[0] - b[0]);

  let atmIv = null;
  let atmSpeculative = false;
  if (contracts.length > 0) {
    let best = null;
    let bestDist = Infinity;
    for (const c of contracts) {
      if (c.iv == null || c.strike == null) continue;
      const d = Math.abs(c.strike - etfSpot);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    if (best) {
      atmIv = best.iv;
      atmSpeculative = !!best.speculative;
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
  // Oil sources spot from Yahoo (CL=F / CLM26.NYM — contract-aware WTI)
  // instead of Pyth. Chain always comes from the options provider
  // (Databento default, real-time via the Python sidecar). Hybrid landed
  // 2026-05-16; Yahoo's fragile cookie+crumb chain endpoint is no longer
  // load-bearing.
  const useYahooSpot = config.useYahooSpot === true;

  // Contract-aware spot (Part B of OIL_EDGE_WTI_ROLLOVER_FIX_2026-05-13).
  // When config.useContractAwareSpot is true and the commodity is oil,
  // resolve the active settle contract from Kalshi /series and pull the
  // matching specific-month Yahoo ticker (CLM26.NYM, CLN26.NYM, ...).
  // Falls back to CL=F continuous on any resolution failure.
  let spot = null;
  if (useYahooSpot && config.useContractAwareSpot === true) {
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
            `[${config.commodity}] using contract-aware spot ${settle.contract} (${cSpot.symbol}) = $${cSpot.price.toFixed(2)}`,
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

  if (!spot) {
    spot = useYahooSpot ? getOilSpot() : getPrice(config.pythSymbol);
  }

  const chain = getChain(config.underlyingEtf);
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
      optProb = probAboveStrike(spotPrice, kSpot, T, RISK_FREE_RATE, DIVIDEND_YIELD, iv);
      volEst = estimateVol(iv, config.commodity);
      const sigmaForPhysical = volEst?.sigma_blend ?? iv;
      sigmaBlendVal = volEst?.sigma_blend ?? null;
      sigmaIvVal = volEst?.sigma_iv ?? iv;
      sigmaRv20Val = volEst?.sigma_rv20 ?? null;
      sigmaSource = volEst?.source ?? 'iv_only';
      const muForPhysical = muUsed != null ? muUsed : (RISK_FREE_RATE - DIVIDEND_YIELD);
      probPhysical = probAboveStrikePhysical(spotPrice, kSpot, T, muForPhysical, sigmaForPhysical);
    }

    const kalshiProb = kalshiYesImpliedProb(market);
    const kalshiView = classifyKalshiView(market);

    let edge = null;
    if (optProb != null && kalshiProb > 0) edge = optProb - kalshiProb;
    let physicalEdge = null;
    if (probPhysical != null && kalshiProb > 0) physicalEdge = probPhysical - kalshiProb;

    // Quote age — Kalshi WS frames carry a `ts` (ms epoch) on the merged
    // market object via mergeLiveQuote / kalshi.js applyTickerMsg. Falls
    // back to null when only the REST seed is present (no live frame yet).
    const quoteTsMs = market.quoteTsMs ?? null;
    const quoteAgeSeconds =
      quoteTsMs != null ? Math.max(0, Math.round((now.getTime() - quoteTsMs) / 1000)) : null;

    let direction = 'PASS';
    let confidence = 'skip';
    let rationale = null;

    if (edge == null) {
      // Edge is null for two distinct reasons; before today both collapsed
      // to "Missing IV" which masked the more common cause (no Kalshi bid
      // on a thin strike). kalshiYesImpliedProb returns 0 when there is
      // neither a two-sided book nor a recent in-band last print.
      if (optProb == null) {
        rationale = `Missing IV (could not interpolate from ${config.underlyingEtf} chain)`;
      } else {
        rationale = 'No Kalshi quote (zero bid, no recent print)';
      }
    } else if (Math.abs(edge) < MIN_EDGE_PP) {
      confidence = 'low';
      rationale = `Edge ${(edge * 100).toFixed(1)}pp below ${(MIN_EDGE_PP * 100).toFixed(0)}pp threshold`;
    } else if (kalshiView === 'no_market') {
      rationale = 'No Kalshi market depth — cannot execute';
    } else {
      const dirYes = edge > 0;
      direction = dirYes ? 'BUY YES' : 'BUY NO';
      const optPct = (optProb * 100).toFixed(0);
      const kpPct = (kalshiProb * 100).toFixed(0);
      const edgePct = Math.abs(edge * 100).toFixed(1);
      rationale = `Options imply ${optPct}% chance ${config.commodity} above $${kSpot.toFixed(2)}, market prices it at ${kpPct}%. ${dirYes ? 'YES' : 'NO'} is underpriced by ${edgePct}pp.`;
      const mag = Math.abs(edge);
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
    }

    let fusedTierStr = edge != null ? fusedTier(Math.abs(edge)) : 'NO_EDGE';
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
      kalshi_yes: kalshiProb,
      kalshi_yes_bid: market.yesBid ?? null,
      kalshi_yes_ask: market.yesAsk ?? null,
      kalshi_volume_24h: Math.round(market.volume24h ?? 0),
      kalshi_open_int: Math.round(market.openInterest ?? 0),
      options_iv: iv ?? null,
      options_prob: optProb ?? null,
      edge_pp: edge ?? null,
      fused_edge_pp: edge ?? null,
      direction,
      confidence,
      fused_confidence: fusedTierStr,
      rationale,
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
      model_version: 'v1_riskneutral',
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
  const actionable = filteredRows.filter((r) => r.edge_pp != null && (r.direction === 'BUY YES' || r.direction === 'BUY NO'));
  let topEdge = null;
  if (actionable.length > 0) {
    topEdge = actionable.reduce((best, cur) => (Math.abs(cur.edge_pp) > Math.abs(best.edge_pp) ? cur : best));
  }

  // Dealer gamma — uses the same ETF chain + spot + T already in scope. UNIQUE
  // (commodity, snapshot_date) on commodity_gamma_snapshots means intraday
  // ticks update the same row; tomorrow gets a new one.
  const gamma = computeDealerGamma({
    contracts: chain.contracts,
    etfSpot: etfPrice,
    T,
    riskFreeRate: RISK_FREE_RATE,
    dividendYield: DIVIDEND_YIELD,
  });

  // FRED divergence demotes meta.topTier the same way per-row tiers were
  // demoted, so Discord routing + downstream consumers see the suppressed
  // confidence rather than the raw edge_pp tier.
  const rawTopTier = topEdge ? fusedTier(Math.abs(topEdge.edge_pp)) : 'NO_EDGE';
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
  validateSnapshot,
  smileCoherenceCheck,
  IV_HARD_CAP,
  MIN_STRIKES_PER_SNAPSHOT,
  // Test seam: lets unit tests force the first-snapshot flag.
  _firstSnapshotWritten: firstSnapshotWritten,
};
