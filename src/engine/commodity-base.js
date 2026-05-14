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

import { probAboveStrike, yearFraction } from './options.js';
import { computeDealerGamma } from './gamma.js';
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
import { getChain, fetchPrevClose } from '../feeds/massive.js';
import { getPrice } from '../feeds/pyth.js';
import { getOilSpot, getUsoChain, getContractSpot } from '../feeds/yahoo-oil.js';
import { getFredDailyClose } from '../feeds/fred.js';
import { fetchEvent, getNextEvent } from '../feeds/kalshi-event.js';
import { getActiveSettleContract } from '../feeds/kalshi-series.js';

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
  };
}

// ---------- public API ----------

export async function discoverEvent(config) {
  const ev = await getNextEvent(config.seriesTicker);
  if (!ev) return null;
  return fetchEvent(ev.event_ticker);
}

// Returns { meta, rows } shaped for the supabase writer. Returns null if any
// upstream feed has no data yet (cold-start race) or a fail-open guard fires.
export async function computeSnapshot(config, event, { now = new Date() } = {}) {
  // Oil sources spot + chain from Yahoo (free, 15-min delayed) instead of
  // pyth + massive. Same downstream shape; only the input feeds differ.
  const useYahoo = config.useYahooOil === true;

  // Contract-aware spot (Part B of OIL_EDGE_WTI_ROLLOVER_FIX_2026-05-13).
  // When config.useContractAwareSpot is true and the commodity is oil,
  // resolve the active settle contract from Kalshi /series and pull the
  // matching specific-month Yahoo ticker (CLM26.NYM, CLN26.NYM, ...).
  // Falls back to CL=F continuous on any resolution failure.
  let spot = null;
  if (useYahoo && config.useContractAwareSpot === true) {
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
    spot = useYahoo ? getOilSpot() : getPrice(config.pythSymbol);
  }

  const chain = useYahoo ? getUsoChain() : getChain(config.underlyingEtf);
  if (!spot) {
    console.warn(
      `[${config.commodity}] no spot price (${useYahoo ? 'yahoo CL=F' : `pyth ${config.pythSymbol}`}) — skipping snapshot`,
    );
    return null;
  }
  if (!chain || !chain.contracts || chain.contracts.length === 0) {
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
  if (!etfPrice || etfPrice <= 0 || spotPrice <= 0) return null;

  const ratio = etfPrice / spotPrice;
  const closeMs = new Date(event.closeTime).getTime();
  const T = yearFraction(now.getTime() / 1000, closeMs / 1000);
  if (T <= 0) return null;

  const smile = buildIvSmile(chain.contracts, etfPrice);

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

    let optProb = null;
    if (iv != null && iv > 0 && T > 0) {
      optProb = probAboveStrike(spotPrice, kSpot, T, RISK_FREE_RATE, DIVIDEND_YIELD, iv);
    }

    const kalshiProb = kalshiYesImpliedProb(market);
    const kalshiView = classifyKalshiView(market);

    let edge = null;
    if (optProb != null && kalshiProb > 0) edge = optProb - kalshiProb;

    let direction = 'PASS';
    let confidence = 'skip';
    let rationale = null;

    if (edge == null) {
      rationale = `Missing IV (could not interpolate from ${config.underlyingEtf} chain)`;
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
      direction,
      confidence,
      rationale,
      spot_price: spotPrice,
      spot_source: spot.source,
      underlying_etf: config.underlyingEtf,
      underlying_price: etfPrice,
      fred_divergence_bp: fredDivergenceBp,
      divergence_warning: divergenceWarning,
    });
  }

  const actionable = rows.filter((r) => r.edge_pp != null && (r.direction === 'BUY YES' || r.direction === 'BUY NO'));
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
      strikeCount: rows.length,
      topEdge,
      topTier: finalTopTier,
      topTierInt: confidenceTierInt(finalTopTier),
      spotLabel: config.spotLabel,
      gamma,
      fredDivergenceBp,
      fredObservationDate,
      divergenceWarning,
    },
    rows,
  };
}

export const __test__ = {
  buildIvSmile,
  kalshiYesImpliedProb,
  classifyKalshiView,
};
