// Black-Scholes pricing + Brent's-method implied-vol back-solver.
// JS port of commodity_edge/src/blackscholes.py — math identical, no scipy.
//
// Used as the FALLBACK layer in Phase 1: Massive's REST snapshot returns
// implied_volatility + greeks server-side on the Options Advanced tier, so
// most strikes go through Massive directly. We back-solve here when Massive
// returns null (deep ITM with no live two-sided quote) or as a divergence
// sanity check (flag rows where our IV vs Massive's diverges by >10pp).
//
// Risk-neutral P(S_T > K) = N(d2). Same warning as the Python original:
// risk-neutral ≠ real-world; deep OTM tails carry a risk-premium gap.

// ---------- normal CDF / PDF (Abramowitz & Stegun 26.2.17 — ~1e-7 accurate) ----------

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function erf(x) {
  // Numerical Recipes / A&S 7.1.26 — adequate for our IV range.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ---------- core BS ----------

function d1d2(S, K, T, r, q, sigma) {
  if (T <= 0 || sigma <= 0) {
    const inf = S > K ? Infinity : -Infinity;
    return [inf, inf];
  }
  const volT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / volT;
  const d2 = d1 - volT;
  return [d1, d2];
}

export function bsPrice(S, K, T, r, q, sigma, type) {
  if (T <= 0) {
    return Math.max(0, type === 'call' ? S - K : K - S);
  }
  const [d1, d2] = d1d2(S, K, T, r, q, sigma);
  if (type === 'call') {
    return S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  }
  return K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
}

// Δ_call = exp(-q*T) * N(d1); Δ_put = exp(-q*T) * (N(d1) - 1). Needed when
// the chain arrives without server-side greeks (Databento OPRA records carry
// raw quotes, not solved Δ — Massive's Options Advanced shortcut doesn't apply
// here). At T=0 or sigma=0 the option is pure intrinsic, so Δ is ±1 if ITM
// and 0 if OTM. dq=0 collapses to the cash-equity case.
export function bsDelta(S, K, T, r, q, sigma, type) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const itm = type === 'call' ? S > K : S < K;
    if (!itm) return 0;
    return type === 'call' ? 1 : -1;
  }
  const [d1] = d1d2(S, K, T, r, q, sigma);
  const nd1 = normCdf(d1);
  const dq = Math.exp(-q * T);
  return type === 'call' ? dq * nd1 : dq * (nd1 - 1);
}

export function bsGamma(S, K, T, r, q, sigma) {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;
  const [d1] = d1d2(S, K, T, r, q, sigma);
  return (Math.exp(-q * T) * normPdf(d1)) / (S * sigma * Math.sqrt(T));
}

// Risk-neutral probability spot > K at expiry under GBM with drift (r - q).
export function probAboveStrike(S, K, T, r, q, sigma) {
  if (T <= 0) return S > K ? 1 : 0;
  if (sigma <= 0) {
    const fwd = S * Math.exp((r - q) * T);
    return fwd > K ? 1 : 0;
  }
  const [, d2] = d1d2(S, K, T, r, q, sigma);
  return normCdf(d2);
}

// Physical-measure P(S_T > K). Same BS d2 form, but uses an empirically
// estimated drift μ instead of risk-neutral (r-q). For binary forecast
// applications (does spot exceed strike?), the physical measure is the
// correct one — risk-neutral is a pricing artifact carrying the market's
// risk premium.
//
// μ_physical comes from src/engine/drift.js — a Bayesian blend of rolling
// realized log-return and (Phase 2) futures-curve slope. Round-trips with
// probAboveStrike when μ = r − q.
export function probAboveStrikePhysical(S, K, T, mu, sigma) {
  if (T <= 0) return S > K ? 1 : 0;
  if (sigma <= 0) {
    const fwd = S * Math.exp(mu * T);
    return fwd > K ? 1 : 0;
  }
  const volT = sigma * Math.sqrt(T);
  const d2 = (Math.log(S / K) + (mu - 0.5 * sigma * sigma) * T) / volT;
  return normCdf(d2);
}

// ---------- Brent's method root finder ----------
// Standard implementation — converges cubically near the root. ~50 lines vs.
// pulling a dependency. Tolerance and maxIter match the Python defaults.

export function brentq(f, lo, hi, { xtol = 1e-6, maxIter = 100 } = {}) {
  let a = lo;
  let b = hi;
  let fa = f(a);
  let fb = f(b);
  if (fa * fb > 0) throw new Error('brentq: no sign change in initial bracket');
  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }
  let c = a;
  let fc = fa;
  let mflag = true;
  let s = b;
  let d;
  for (let i = 0; i < maxIter; i++) {
    if (fa !== fc && fb !== fc) {
      // inverse quadratic
      s =
        (a * fb * fc) / ((fa - fb) * (fa - fc)) +
        (b * fa * fc) / ((fb - fa) * (fb - fc)) +
        (c * fa * fb) / ((fc - fa) * (fc - fb));
    } else {
      // secant
      s = b - fb * ((b - a) / (fb - fa));
    }
    const cond1 = !((s > (3 * a + b) / 4 && s < b) || (s < (3 * a + b) / 4 && s > b));
    const cond2 = mflag && Math.abs(s - b) >= Math.abs(b - c) / 2;
    const cond3 = !mflag && Math.abs(s - b) >= Math.abs(c - d) / 2;
    const cond4 = mflag && Math.abs(b - c) < xtol;
    const cond5 = !mflag && Math.abs(c - d) < xtol;
    if (cond1 || cond2 || cond3 || cond4 || cond5) {
      s = (a + b) / 2;
      mflag = true;
    } else {
      mflag = false;
    }
    const fs = f(s);
    d = c;
    c = b;
    fc = fb;
    if (fa * fs < 0) {
      b = s;
      fb = fs;
    } else {
      a = s;
      fa = fs;
    }
    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a];
      [fa, fb] = [fb, fa];
    }
    if (Math.abs(fb) < xtol || Math.abs(b - a) < xtol) return b;
  }
  throw new Error('brentq: did not converge');
}

// ---------- IV back-solver ----------

export function impliedVol(marketPrice, S, K, T, r, q, type, { lo = 1e-4, hi = 5 } = {}) {
  if (marketPrice == null || marketPrice <= 0 || T <= 0) {
    return { iv: null, converged: false, method: 'intrinsic', note: 'non-positive price or expiry' };
  }
  const intrinsic =
    Math.max(0, type === 'call' ? S - K : K - S) * Math.exp(-q * T);
  const upperBound = type === 'call' ? S * Math.exp(-q * T) : K * Math.exp(-r * T);
  if (marketPrice < intrinsic - 1e-6) {
    return { iv: null, converged: false, method: 'no_arb_violation', note: `price ${marketPrice} < intrinsic ${intrinsic}` };
  }
  if (marketPrice > upperBound + 1e-6) {
    return { iv: null, converged: false, method: 'no_arb_violation', note: `price ${marketPrice} > upper ${upperBound}` };
  }
  if (marketPrice <= intrinsic + 1e-4) {
    return { iv: 1e-4, converged: true, method: 'intrinsic', note: 'price at intrinsic' };
  }
  const f = (sigma) => bsPrice(S, K, T, r, q, sigma, type) - marketPrice;
  let upper = hi;
  let fLo = f(lo);
  let fHi = f(upper);
  if (fLo * fHi > 0) {
    let widened = false;
    for (const candidate of [10, 20]) {
      fHi = f(candidate);
      if (fLo * fHi <= 0) {
        upper = candidate;
        widened = true;
        break;
      }
    }
    if (!widened) {
      return { iv: null, converged: false, method: 'brent', note: `no sign change in [${lo}, ${upper}]` };
    }
  }
  try {
    const sigma = brentq(f, lo, upper);
    return { iv: sigma, converged: true, method: 'brent' };
  } catch (e) {
    return { iv: null, converged: false, method: 'brent', note: e.message };
  }
}

// Year fraction (Act/365). Inputs are epoch seconds.
export function yearFraction(nowEpochS, expiryEpochS) {
  return Math.max(0, (expiryEpochS - nowEpochS) / (365 * 24 * 3600));
}

// ---------- TWAP-aware probability (KXBTCD + future TWAP-settled markets) ----------
//
// Two distinct effects that point-in-time BS gets wrong on sub-hour TWAP-
// settled markets:
//
//   1. **Settlement is an average, not a point.** KXBTCD settles on a
//      60-second TWAP of CF Benchmarks BRTI over the minute leading up to
//      the hour. For geometric Brownian motion the log of the geometric
//      average over [T-τ, T] is Normal with mean Y_0 + (μ-σ²/2)(T-τ/2) and
//      variance σ²(T - 2τ/3). Outside the window (T ≫ τ) this is a tiny
//      correction; inside the window it changes the answer materially.
//      Closed-form derivation in the rationale block above.
//
//   2. **The smile IV understates realized vol at sub-hour scales.** OPRA
//      smiles are calibrated to weekly+ expiries. BTC's empirical 5-minute
//      realized vol is 2-3× the IV-implied σ — observed live 2026-05-22
//      when the engine's smile-σ at T=7min implied $138 (1-sigma) while
//      BTC was actually traversing $300-800 in that window. The short-
//      horizon multiplier linearly inflates σ from 1× at T = capHours down
//      to `scale` × at T → 0. Empirical fit on BTC suggests scale ≈ 3.0–3.5.
//
// Caller passes physical drift μ (caller decides risk-neutral vs physical).
// Tau in seconds; rest in year-fraction units.
export function probAboveTwap(S, K, T, mu, sigma, twapWindowSec, shortHorizonScale = 1, capHours = 1) {
  if (T <= 0) return S > K ? 1 : 0;
  const tauYr = (twapWindowSec ?? 0) / (365 * 24 * 3600);
  // Effective drift period — the average is over [T-τ, T], so the mean is
  // accumulated to T - τ/2 (midpoint of the averaging window).
  const driftT = Math.max(T - tauYr / 2, 0);
  // Effective variance of ln(geometric-average) over the window:
  //   Var = σ² × (T - 2τ/3) for T ≥ τ.
  // For T < τ (already inside the window) only the remaining T/3 of variance
  // is contributed by future ticks — clamp conservatively.
  const varT = Math.max(T - (2 / 3) * tauYr, T / 3);
  const sigmaEff = effectiveVolShortHorizon(T, sigma, shortHorizonScale, capHours);
  if (sigmaEff <= 0) {
    const fwd = S * Math.exp(mu * driftT);
    return fwd > K ? 1 : 0;
  }
  const volT = sigmaEff * Math.sqrt(varT);
  const d2 = (Math.log(S / K) + (mu - 0.5 * sigmaEff * sigmaEff) * driftT) / volT;
  return normCdf(d2);
}

// Short-horizon vol inflation. Returns sigma unchanged at T ≥ capHours;
// scales linearly up to `scale × sigma` as T → 0. Used by probAboveTwap to
// repair the IV→realized-vol gap that BS inherits when smiles calibrated to
// weekly expiries are evaluated at minute-scale T.
export function effectiveVolShortHorizon(T, sigma, scale = 1, capHours = 1) {
  if (!Number.isFinite(scale) || scale <= 1 || T <= 0 || sigma <= 0) return sigma;
  const Thours = T * 365 * 24;
  if (Thours >= capHours) return sigma;
  const frac = Thours / capHours;
  const boost = scale - (scale - 1) * frac;
  return sigma * boost;
}
