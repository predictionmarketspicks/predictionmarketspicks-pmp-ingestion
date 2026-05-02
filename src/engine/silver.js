// Silver Edge engine — combines Pyth XAG/USD spot + Massive SLV chain +
// Kalshi KXSILVERW into a snapshot, computes edge per strike, returns rows
// shaped for commodity_edge_signals.
//
// Pricing rule (commodity engine, locked in CLAUDE.md):
//   prefer mid for tight two-sided books
//   fall back to last only with volume confirmation AND in-window
//
// Methodology mirrors commodity_edge/src/edge.py — only the data sources differ
// (Massive REST instead of yfinance, in-memory Kalshi quotes instead of REST).

import { probAboveStrike, yearFraction } from './options.js';
import {
  MIN_EDGE_PP,
  MIN_VOL_FOR_LIVE_PRICE,
  RISK_FREE_RATE,
  DIVIDEND_YIELD,
  fusedTier,
  confidenceTierInt,
} from './thresholds.js';
import { getQuote } from '../feeds/kalshi.js';
import { getChain, fetchPrevClose } from '../feeds/massive.js';
import { getPrice } from '../feeds/pyth.js';
import { fetchEvent, getNextEvent } from '../feeds/kalshi-event.js';

const SILVER_SERIES = 'KXSILVERW';
const SILVER_UNDERLYING_ETF = 'SLV';
const SILVER_PYTH_SYMBOL = 'XAG/USD';

// ---------- Kalshi probability inference ----------
// Direct port of KalshiMarket.yes_implied_prob in commodity_edge/src/kalshi.py.

function kalshiYesImpliedProb(market) {
  const { yesBid, yesAsk, lastPrice, volume24h } = market;
  const hasBook = (yesBid ?? 0) > 0 && (yesAsk ?? 0) > 0;
  if (hasBook) {
    const spread = yesAsk - yesBid;
    const mid = (yesBid + yesAsk) / 2;
    if (spread <= 0.1) return mid;
    // Wide book — trust last_price only if recent volume confirms it AND it sits
    // inside the (tolerance-padded) bid-ask window.
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

// Liquidity flag — gates direction/confidence assignment.
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
// Massive Options Advanced returns implied_volatility per contract. We pick the
// strike closest to spot (in ETF $ space) on the OTM side and interpolate.
// Falls back to the closest-to-spot ATM IV when the smile is sparse.

function buildIvSmile(contracts, etfSpot) {
  const lo = etfSpot * 0.75;
  const hi = etfSpot * 1.25;
  // Clean: in-window, plausible IV, OTM side only.
  const clean = [];
  for (const c of contracts) {
    if (c.iv == null || c.strike == null) continue;
    if (c.strike < lo || c.strike > hi) continue;
    if (c.iv < 0.1 || c.iv > 1.5) continue;
    if (c.strike >= etfSpot && c.contractType === 'call') clean.push([c.strike, c.iv]);
    else if (c.strike < etfSpot && c.contractType === 'put') clean.push([c.strike, c.iv]);
  }
  clean.sort((a, b) => a[0] - b[0]);

  // ATM IV: closest-to-spot strike, prefer OTM side (matches Python).
  let atmIv = null;
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
    if (best) atmIv = best.iv;
  }

  function ivAt(targetStrikeEtf) {
    if (clean.length === 0) return atmIv;
    // np.interp-style clamped linear interpolation.
    if (targetStrikeEtf <= clean[0][0]) return clean[0][1];
    if (targetStrikeEtf >= clean[clean.length - 1][0]) return clean[clean.length - 1][1];
    for (let i = 1; i < clean.length; i++) {
      if (clean[i][0] >= targetStrikeEtf) {
        const [x0, y0] = clean[i - 1];
        const [x1, y1] = clean[i];
        const t = (targetStrikeEtf - x0) / (x1 - x0);
        return y0 + (y1 - y0) * t;
      }
    }
    return atmIv;
  }

  return { atmIv, ivAt };
}

// ---------- live-quote merge ----------
// Use REST snapshot as the baseline (always gives floor_strike + close_time)
// and overlay live WS quotes when present. Live quotes are fresher; REST gives
// us the universe of strikes.

function mergeLiveQuote(market) {
  const live = getQuote(market.ticker);
  if (!live) return market;
  return {
    ...market,
    yesBid: live.yesBid ?? market.yesBid,
    yesAsk: live.yesAsk ?? market.yesAsk,
    lastPrice: live.price ?? market.lastPrice,
    volume24h: market.volume24h, // 24h vol is REST-only; WS sends total vol_fp
    openInterest: live.openInt ?? market.openInterest,
  };
}

// ---------- main ----------

export async function discoverSilverEvent() {
  const ev = await getNextEvent(SILVER_SERIES);
  if (!ev) return null;
  return fetchEvent(ev.event_ticker);
}

// Returns { meta, rows } shaped for the supabase writer. Returns null if any
// upstream feed has no data yet (cold-start race).
export async function computeSilverSnapshot(event, { now = new Date() } = {}) {
  const pyth = getPrice(SILVER_PYTH_SYMBOL);
  const chain = getChain(SILVER_UNDERLYING_ETF);
  if (!pyth || !chain || !chain.contracts || chain.contracts.length === 0) {
    return null;
  }

  const spotPrice = pyth.price;
  // Massive Options Advanced returns underlying_asset.price live; on the bridge
  // week (15-min delayed) and off-hours, that field is missing — fall back to
  // the previous-day SLV close via /v2/aggs/ticker/SLV/prev.
  let etfPrice =
    chain.contracts.find((c) => c.underlyingPrice != null)?.underlyingPrice || null;
  if (!etfPrice) {
    try {
      etfPrice = await fetchPrevClose(SILVER_UNDERLYING_ETF);
    } catch (err) {
      console.warn(`[silver] SLV spot fallback failed: ${err?.message || err}`);
      return null;
    }
  }
  if (!etfPrice || etfPrice <= 0 || spotPrice <= 0) return null;

  const ratio = etfPrice / spotPrice;
  const closeMs = new Date(event.closeTime).getTime();
  const T = yearFraction(now.getTime() / 1000, closeMs / 1000);
  if (T <= 0) return null; // event already closed

  const smile = buildIvSmile(chain.contracts, etfPrice);

  const rows = [];
  for (const rawMarket of event.markets) {
    if (rawMarket.floorStrike == null) continue;
    const market = mergeLiveQuote(rawMarket);
    const kSpot = market.floorStrike;
    const kEtf = kSpot * ratio;
    const iv = smile.ivAt(kEtf);

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
      rationale = `Missing IV (could not interpolate from ${SILVER_UNDERLYING_ETF} chain)`;
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
      rationale = `Options imply ${optPct}% chance silver above $${kSpot.toFixed(2)}, market prices it at ${kpPct}%. ${dirYes ? 'YES' : 'NO'} is underpriced by ${edgePct}pp.`;
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
    }

    const fusedTierStr = edge != null ? fusedTier(Math.abs(edge)) : 'NO_EDGE';
    const tierInt = confidenceTierInt(fusedTierStr);

    rows.push({
      // Direct insert into commodity_edge_signals.
      snapshot_at: now.toISOString(),
      commodity: 'silver',
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
      spot_source: pyth.source,
      underlying_etf: SILVER_UNDERLYING_ETF,
      underlying_price: etfPrice,
      // Fused fields stay NULL — populated by the nightly Python job once it
      // ports to writing snapshot_type='daily' rows. Engine doesn't run COT/gamma.
    });
  }

  // Pick the top edge for Discord and ops logging.
  const actionable = rows.filter((r) => r.edge_pp != null && (r.direction === 'BUY YES' || r.direction === 'BUY NO'));
  let topEdge = null;
  if (actionable.length > 0) {
    topEdge = actionable.reduce((best, cur) => (Math.abs(cur.edge_pp) > Math.abs(best.edge_pp) ? cur : best));
  }

  return {
    meta: {
      commodity: 'silver',
      eventTicker: event.eventTicker,
      eventCloseAt: new Date(closeMs).toISOString(),
      spotPrice,
      etfPrice,
      atmIv: smile.atmIv,
      generatedAt: now.toISOString(),
      hoursToClose: (closeMs - now.getTime()) / 3.6e6,
      strikeCount: rows.length,
      topEdge,
      topTier: topEdge ? fusedTier(Math.abs(topEdge.edge_pp)) : 'NO_EDGE',
      topTierInt: topEdge ? confidenceTierInt(fusedTier(Math.abs(topEdge.edge_pp))) : 0,
    },
    rows,
  };
}

export {
  SILVER_SERIES,
  SILVER_UNDERLYING_ETF,
  SILVER_PYTH_SYMBOL,
};
