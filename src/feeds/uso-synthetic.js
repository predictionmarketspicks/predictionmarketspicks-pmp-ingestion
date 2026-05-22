// Synthetic WTI spot — derived from real-time USO ETF mid (already flowing
// from Databento as underlyingPrice on every contract in the chain) and
// anchored daily to FRED's DCOILWTICO official EIA close.
//
// Why this exists: Yahoo CL=F is the only previously-available free real-time
// WTI source and it's ~10-15 min delayed with a fragile cookie+crumb endpoint.
// Databento returns the live USO mid in underlyingPrice on every chain
// contract; we get it for free with the options subscription. Multiplying by
// a daily ratio gives us sub-second WTI spot tracking during the only hours
// we actually write snapshots (OPRA-hours: 9:30 AM–4:00 PM ET).
//
// Roll-day caveat: USO rolls front-month to second-month over 4 trading days
// each month (typically days 8-11). During roll, USO is partially exposed
// to two CL contracts simultaneously and the per-USO WTI ratio drifts. The
// existing FRED divergence gate in commodity-base.js catches this — if the
// synthetic diverges from DCOILWTICO by >150bp the row's tier is demoted
// automatically, no roll-window detection logic needed here.

import { getFredDailyClose } from './fred.js';
import { fetchPrevClose } from './options-provider.js';

const RATIO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const USO_SYMBOL = 'USO';
const FRED_WTI = 'DCOILWTICO';

let _ratioCache = null; // { wtiPerUso, asOf, usoPrevClose, wtiPrevClose, ts }

// Compute (or return cached) wti_per_uso ratio from yesterday's official EIA
// WTI close + yesterday's USO close. Returns null when either feed fails;
// caller falls back to upstream Yahoo CL=F path.
export async function getWtiPerUsoRatio({ now = new Date() } = {}) {
  if (_ratioCache && now.getTime() - _ratioCache.ts < RATIO_CACHE_TTL_MS) {
    return _ratioCache;
  }
  try {
    const [fred, usoPrev] = await Promise.all([
      getFredDailyClose(FRED_WTI),
      fetchPrevClose(USO_SYMBOL),
    ]);
    if (!fred || !(fred.price > 0) || !(usoPrev > 0)) {
      console.warn(
        `[uso-synthetic] insufficient anchor data — fred=${fred?.price} uso=${usoPrev}`,
      );
      return null;
    }
    const wtiPerUso = fred.price / usoPrev;
    _ratioCache = {
      wtiPerUso,
      asOf: fred.observation_date,
      usoPrevClose: usoPrev,
      wtiPrevClose: fred.price,
      ts: now.getTime(),
    };
    console.log(
      `[uso-synthetic] anchor refreshed: WTI ${fred.price.toFixed(2)} / USO ${usoPrev.toFixed(2)} = ${wtiPerUso.toFixed(4)} (as_of ${fred.observation_date})`,
    );
    return _ratioCache;
  } catch (err) {
    console.warn(`[uso-synthetic] ratio fetch failed: ${err?.message || err}`);
    return null;
  }
}

// Synthesize WTI spot from a live USO underlyingPrice quote.
// Returns { price, source, publishTimeMs, anchor } or null on failure.
export async function synthesizeWtiSpot(usoUnderlyingPrice, opts = {}) {
  if (!(usoUnderlyingPrice > 0)) return null;
  const ratio = await getWtiPerUsoRatio(opts);
  if (!ratio) return null;
  return {
    price: usoUnderlyingPrice * ratio.wtiPerUso,
    source: 'uso_synthetic_v1',
    publishTimeMs: opts.publishTimeMs ?? Date.now(),
    anchor: {
      wti_per_uso: ratio.wtiPerUso,
      as_of: ratio.asOf,
      uso_prev_close: ratio.usoPrevClose,
      wti_prev_close: ratio.wtiPrevClose,
    },
  };
}

export function __clearRatioCacheForTest() {
  _ratioCache = null;
}
