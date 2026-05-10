// Dealer-gamma calculator for commodity ETF chains.
//
// JS port of commodity_edge/_legacy/src/gamma.py. Same methodology, same
// thresholds — the legacy Python ran in the retired GH Actions cron and
// stopped writing commodity_gamma_snapshots when that was retired
// 2026-05-04. This re-introduces the writer inside the Fly engine, which
// already pulls the SLV/GLD/USO chain with back-solved IV per strike on
// every market-hours tick.
//
// Convention (mirrors the legacy):
//   contribution_per_strike = OI * bs_gamma * lot_size * spot
//   call leg → -contribution    (assume customers long calls, dealers short)
//   put leg  → +contribution    (assume customers short puts, dealers long)
//   net_dealer_gamma = sum(call_leg + put_leg) across strikes
//
//   gamma_environment:
//     net < -GAMMA_THRESHOLD → AMPLIFYING (modifier 1.20)
//     net >  GAMMA_THRESHOLD → DAMPENING  (modifier 0.85)
//     otherwise              → NEUTRAL    (modifier 1.00)
//
//   gamma_neutral_price: strike where running cumulative dealer gamma flips
//   sign (walked low→high). Falls back to ETF spot if cumulative never crosses.
//
// All inputs are in the underlying ETF's terms (SLV / GLD / USO), matching
// the chain — the readers in /lib/tools/gamma-snapshot.ts and
// /lib/oracle/collect.ts treat spot_price + gamma_neutral_price as the same
// units the writer used (legacy did the same).

import { bsGamma } from './options.js';

const LOT_SIZE = 100;

// Net dealer gamma magnitude (in $/$1-spot-move units after lot_size*spot
// scaling) at which we flip from NEUTRAL into AMPLIFYING or DAMPENING.
// Calibrated for SLV/GLD/USO scale per legacy comment — single-strike ATM
// contributions are typically 1–5M, so net 500k after partial cancellation
// is the inflection.
const GAMMA_THRESHOLD = 500_000.0;

const MODIFIER_AMPLIFYING = 1.2;
const MODIFIER_NEUTRAL = 1.0;
const MODIFIER_DAMPENING = 0.85;

function classify(netGamma) {
  if (netGamma < -GAMMA_THRESHOLD) return ['AMPLIFYING', MODIFIER_AMPLIFYING];
  if (netGamma > GAMMA_THRESHOLD) return ['DAMPENING', MODIFIER_DAMPENING];
  return ['NEUTRAL', MODIFIER_NEUTRAL];
}

// Compute net dealer gamma + neutral-price crossover from an options chain.
//
// Inputs:
//   contracts      — array of { strike, contractType, iv, openInterest } from
//                    the Massive (silver/gold) or Yahoo (oil) chain.
//   etfSpot        — last underlying ETF price (chain.contracts[].underlyingPrice
//                    or fetched fallback). NOT the commodity spot.
//   T              — year fraction to expiry (Act/365).
//   riskFreeRate   — annualized, defaults to 0.045 (legacy).
//   dividendYield  — annualized, defaults to 0 (ETFs don't carry yield in
//                    this model).
//
// Returns:
//   { netDealerGamma, gammaNeutralPrice, gammaEnvironment, signalModifier,
//     strikesContributing }.
//
// Failure modes:
//   - Empty / zero-OI chain → NEUTRAL with net=0, neutral=etfSpot, contrib=0.
//   - Missing IVs at every strike → same outcome.
// Either way the output is safe to upsert; downstream readers already cope
// with NEUTRAL via fallback paths.
export function computeDealerGamma({
  contracts,
  etfSpot,
  T,
  riskFreeRate = 0.045,
  dividendYield = 0.0,
  lotSize = LOT_SIZE,
}) {
  if (!contracts || contracts.length === 0 || !(etfSpot > 0) || !(T > 0)) {
    return {
      netDealerGamma: 0,
      gammaNeutralPrice: etfSpot > 0 ? etfSpot : 0,
      gammaEnvironment: 'NEUTRAL',
      signalModifier: MODIFIER_NEUTRAL,
      strikesContributing: 0,
    };
  }

  const byStrike = new Map();
  let contributing = 0;

  for (const c of contracts) {
    if (c.iv == null || !(c.iv > 0)) continue;
    if (c.strike == null || !(c.strike > 0)) continue;
    if (c.openInterest == null || !(c.openInterest > 0)) continue;
    if (c.contractType !== 'call' && c.contractType !== 'put') continue;

    const g = bsGamma(etfSpot, c.strike, T, riskFreeRate, dividendYield, c.iv);
    if (!Number.isFinite(g) || g === 0) continue;

    const contrib = c.openInterest * g * lotSize * etfSpot;
    const signed = c.contractType === 'call' ? -contrib : +contrib;

    byStrike.set(c.strike, (byStrike.get(c.strike) || 0) + signed);
    contributing += 1;
  }

  let netGamma = 0;
  for (const v of byStrike.values()) netGamma += v;

  // Walk strikes low→high; gamma-neutral price is the first strike where the
  // running cumulative crosses zero. Defaults to ETF spot if it never crosses.
  const sortedStrikes = [...byStrike.keys()].sort((a, b) => a - b);
  let cumulative = 0;
  let gammaNeutral = etfSpot;
  for (const k of sortedStrikes) {
    const prev = cumulative;
    cumulative += byStrike.get(k);
    if ((prev < 0 && cumulative >= 0) || (prev > 0 && cumulative <= 0)) {
      gammaNeutral = k;
      break;
    }
  }

  const [environment, modifier] = classify(netGamma);

  return {
    netDealerGamma: Math.round(netGamma * 100) / 100,
    gammaNeutralPrice: Math.round(gammaNeutral * 10000) / 10000,
    gammaEnvironment: environment,
    signalModifier: modifier,
    strikesContributing: contributing,
  };
}

export const __test__ = {
  GAMMA_THRESHOLD,
  MODIFIER_AMPLIFYING,
  MODIFIER_NEUTRAL,
  MODIFIER_DAMPENING,
};
