// The one place that decides which bitcoin number is which.
//
// TWO SPOTS, AND CONFLATING THEM IS A LICENSING INCIDENT.
//
//   ref — what we PRICE on. CF Benchmarks BRTI when fresh (the index Kalshi
//         actually settles on), else the exchange basket. ⛔ OPRA-class: it may
//         reach the model and the internal `ref_spot` column, and nothing else.
//   pub — what we PUBLISH. The free exchange basket (public keyless endpoints, no
//         licence). This is `spot_price` / `spot` on every row and payload.
//
// Kalshi's Data Terms of Use prohibit publicly displaying licensed content, and CF
// Benchmarks is a regulated benchmark administrator, so the default treats raw
// index values exactly like OPRA options data: internal calculation only. Saying
// "priced on the CF Benchmarks BRTI feed via Kalshi's API" in copy is a statement
// about our METHOD, not redistribution, and is fine.
//
// `BTC_PUBLIC_SPOT=ref` collapses the whole two-column dance the day Kalshi
// confirms display is permitted. Until then it stays `basket`.
// handoffs/BRTI_CF_BENCHMARKS_FEED_2026-09-08.md §3 + E1.2.
//
// ⛔ THE BASKET STAYS RUNNING, ALWAYS. It is the public spot under the default AND
// the fallback rung when the socket drops. A fallback that only runs during an
// outage is the one that fails during an outage; this one runs every tick.
import { getBrtiSpot } from './brti-spot.js';
import { getCfIndex, CF_MAX_AGE_MS } from './cfbenchmarks.js';

/** The basket polls every 10 s; 5 minutes is the engine's existing tolerance. */
const BASKET_MAX_AGE_MS = 5 * 60_000;

/**
 * Rounding applied when the index is the only thing left AND display rights have
 * not been granted. $10 on a ~$78k index is ~0.013% — useless as a redistributed
 * benchmark, still honest as a displayed spot, and clearly labelled by its source
 * tag so nobody mistakes it for the index itself.
 */
const PUBLIC_ROUNDING_USD = 10;

/**
 * @returns {null | { ref: object, pub: object, refSource: string, pubSource: string,
 *                    refAgeS: number, pubAgeS: number }}
 *   null only when BOTH feeds are dead — the caller must then refuse to price,
 *   never substitute a stale number.
 */
export function getBtcSpot({ now = Date.now(), publicMode = process.env.BTC_PUBLIC_SPOT || 'basket' } = {}) {
  const cf = getCfIndex('BRTI');
  const cfFresh = cf != null && now - cf.publishTimeMs <= CF_MAX_AGE_MS;

  const bk = getBrtiSpot();
  const bkFresh = bk != null && now - bk.publishTimeMs <= BASKET_MAX_AGE_MS;

  // What we price on: the settlement index when we have it, the basket otherwise.
  const ref = cfFresh ? cf : bkFresh ? bk : null;
  if (!ref) return null;

  // What we publish. Order matters: an explicit `ref` mode first, then the basket,
  // then a rounded index as the last resort so the tool degrades to a coarse public
  // number rather than going dark.
  const pub =
    publicMode === 'ref' && cfFresh
      ? cf
      : bkFresh
        ? bk
        : {
            ...cf,
            price: Math.round(cf.price / PUBLIC_ROUNDING_USD) * PUBLIC_ROUNDING_USD,
            source: 'cf_benchmarks_brti_rounded',
          };

  return {
    ref,
    pub,
    refSource: ref.source,
    pubSource: pub.source,
    refAgeS: Number(((now - ref.publishTimeMs) / 1000).toFixed(1)),
    pubAgeS: Number(((now - pub.publishTimeMs) / 1000).toFixed(1)),
  };
}
