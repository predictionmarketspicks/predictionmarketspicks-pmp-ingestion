// Kalshi /series metadata — resolves which futures contract a Kalshi event
// settles against. Used by the oil engine to drive contract-aware spot
// selection (Part B of handoffs/OIL_EDGE_WTI_ROLLOVER_FIX_2026-05-13.md).
//
// Kalshi publishes per-series `settlement_sources` with effective_at + name
// entries. For KXWTI the name looks like
//   "NYMEX WTI Crude Oil Futures, JUN26 contract"
// We extract the {MMM}{YY} contract code and convert to yyyymm so the
// Yahoo specific-month ticker (CLM26.NYM etc.) can be derived.
//
// Caching: 1h in-process TTL. settlement_sources change at most twice/month
// so a 1h cache trades trivial staleness for far fewer Kalshi REST hits.

const KALSHI_API_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // seriesTicker → { fetchedAt, sources }

const MONTH_NAME_TO_NUM = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

async function fetchSeries(seriesTicker) {
  const res = await fetch(`${KALSHI_API_BASE}/series/${seriesTicker}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'pmp-ingestion/0.1' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`kalshi series ${res.status} ${seriesTicker}`);
  const j = await res.json();
  const sources = j?.series?.settlement_sources ?? [];
  return Array.isArray(sources) ? sources : [];
}

async function getSettlementSources(seriesTicker) {
  const hit = cache.get(seriesTicker);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.sources;
  const sources = await fetchSeries(seriesTicker);
  cache.set(seriesTicker, { fetchedAt: Date.now(), sources });
  return sources;
}

// Parse "NYMEX WTI Crude Oil Futures, JUN26 contract" → 'JUN26'.
function parseContractCode(name) {
  if (typeof name !== 'string') return null;
  const m = name.match(/\b([A-Z]{3})(\d{2})\b/);
  return m ? `${m[1]}${m[2]}` : null;
}

// 'JUN26' → '202606'
function contractToYyyymm(code) {
  if (!code || code.length !== 5) return null;
  const monthName = code.slice(0, 3);
  const yy = code.slice(3, 5);
  const monthNum = MONTH_NAME_TO_NUM[monthName];
  if (!monthNum || !/^\d{2}$/.test(yy)) return null;
  const yyyy = `20${yy}`;
  return `${yyyy}${String(monthNum).padStart(2, '0')}`;
}

// Pick the source whose effective_at is the latest <= referenceTs. If no
// source has an effective_at, take the first. Returns null if no source
// has a parseable contract code.
export async function getActiveSettleContract(seriesTicker, referenceTs) {
  const sources = await getSettlementSources(seriesTicker);
  if (sources.length === 0) return null;

  const refMs =
    typeof referenceTs === 'string' ? new Date(referenceTs).getTime() : referenceTs;
  const refValid = Number.isFinite(refMs);

  let chosen = null;
  let chosenAtMs = -Infinity;
  for (const s of sources) {
    const eff = s.effective_at ? new Date(s.effective_at).getTime() : NaN;
    if (refValid && Number.isFinite(eff)) {
      if (eff <= refMs && eff > chosenAtMs) {
        chosen = s;
        chosenAtMs = eff;
      }
    } else if (!chosen) {
      chosen = s;
    }
  }
  if (!chosen) return null;

  const code = parseContractCode(chosen.name);
  if (!code) return null;
  const yyyymm = contractToYyyymm(code);
  if (!yyyymm) return null;
  return { contract: code, yyyymm };
}

export const __test__ = { parseContractCode, contractToYyyymm };
