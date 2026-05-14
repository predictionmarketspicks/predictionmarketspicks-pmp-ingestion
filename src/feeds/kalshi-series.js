// Kalshi /series metadata — resolves which futures contract a Kalshi event
// settles against. Used by the oil engine to drive contract-aware spot
// selection (Part B of handoffs/OIL_EDGE_WTI_ROLLOVER_FIX_2026-05-13.md).
//
// Two extraction strategies in order:
//   1. settlement_sources[].name regex — for series where Kalshi puts the
//      contract code directly in the source name (e.g. "NYMEX WTI Crude Oil
//      Futures, JUN26 contract"). settlement_sources[].effective_at picks
//      the active row vs the reference timestamp.
//   2. product_metadata.important_info.markdown parse — for KXWTI specifically
//      (verified 2026-05-13: settlement_sources is just [{name: "ICE"}], the
//      contract code lives in the rollover-window markdown). Strategy:
//        - First chunk before "Effective" = current contract (effective -∞)
//        - Each subsequent chunk parses its leading "<Day,> Month Nth, YYYY"
//          date as the effective timestamp for the next contract code that
//          appears in that chunk
//        - Pick the latest (effective ≤ referenceTs) pair
//
// Caching: 1h in-process TTL. settlement_sources / rollover markdown change
// at most twice/month so a 1h cache trades trivial staleness for far fewer
// Kalshi REST hits.

const KALSHI_API_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // seriesTicker → { fetchedAt, series }

const MONTH_NAME_TO_NUM = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const FULL_MONTH_TO_NUM = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

async function fetchSeries(seriesTicker) {
  const res = await fetch(`${KALSHI_API_BASE}/series/${seriesTicker}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'pmp-ingestion/0.1' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`kalshi series ${res.status} ${seriesTicker}`);
  const j = await res.json();
  return j?.series ?? null;
}

async function getSeries(seriesTicker) {
  const hit = cache.get(seriesTicker);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.series;
  const series = await fetchSeries(seriesTicker);
  cache.set(seriesTicker, { fetchedAt: Date.now(), series });
  return series;
}

// Parse "NYMEX WTI Crude Oil Futures, JUN26 contract" → 'JUN26'.
function parseContractCode(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\b([A-Z]{3})(\d{2})\b/);
  if (!m) return null;
  const code = `${m[1]}${m[2]}`;
  return MONTH_NAME_TO_NUM[m[1]] ? code : null;
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

// "Sunday, May 16th, 2026" / "May 16th, 2026" / "May 16th" → ms (UTC midnight)
// Uses the year from fallbackYearMs when the markdown omits the year.
function parseEffectiveDate(chunkText, fallbackYearMs) {
  if (typeof chunkText !== 'string') return null;
  // Strip the leading comma + optional weekday so the month-name regex anchors
  // cleanly. "Effective Sunday, May 16th, 2026" → ", May 16th, 2026".
  const m = chunkText.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i,
  );
  if (!m) return null;
  const monthNum = FULL_MONTH_TO_NUM[m[1].toLowerCase()];
  if (!monthNum) return null;
  const day = Number.parseInt(m[2], 10);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const yearFromText = m[3] ? Number.parseInt(m[3], 10) : null;
  const fallbackYear = Number.isFinite(fallbackYearMs)
    ? new Date(fallbackYearMs).getUTCFullYear()
    : new Date().getUTCFullYear();
  const year = yearFromText ?? fallbackYear;
  return Date.UTC(year, monthNum - 1, day);
}

// Extract (effectiveMs, contractCode) pairs from the rollover-window markdown.
function extractFromMarkdown(markdown, refMs) {
  if (typeof markdown !== 'string') return [];
  // Split on "Effective" — the first chunk holds the current contract,
  // subsequent chunks each have a date + a future contract code.
  const chunks = markdown.split(/\bEffective\b/i);
  const pairs = [];
  for (let i = 0; i < chunks.length; i++) {
    const code = parseContractCode(chunks[i]);
    if (!code) continue;
    const effMs =
      i === 0
        ? Number.NEGATIVE_INFINITY
        : parseEffectiveDate(chunks[i], refMs);
    if (i > 0 && effMs == null) continue;
    pairs.push({ effMs, code });
  }
  return pairs;
}

function pickActivePair(pairs, refMs) {
  let chosen = null;
  let chosenEff = Number.NEGATIVE_INFINITY;
  for (const p of pairs) {
    const eff = p.effMs ?? Number.NEGATIVE_INFINITY;
    if (eff <= refMs && eff >= chosenEff) {
      chosen = p;
      chosenEff = eff;
    }
  }
  return chosen;
}

// Strategy 1: settlement_sources[].name + effective_at
function fromSettlementSources(sources, refMs) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  let chosen = null;
  let chosenAtMs = Number.NEGATIVE_INFINITY;
  for (const s of sources) {
    const code = parseContractCode(s?.name);
    if (!code) continue;
    const eff = s.effective_at ? new Date(s.effective_at).getTime() : Number.NEGATIVE_INFINITY;
    if (eff <= refMs && eff >= chosenAtMs) {
      chosen = code;
      chosenAtMs = eff;
    }
  }
  return chosen;
}

// Returns { contract, yyyymm } or null.
export async function getActiveSettleContract(seriesTicker, referenceTs) {
  const series = await getSeries(seriesTicker);
  if (!series) return null;

  const refMs =
    typeof referenceTs === 'string' ? new Date(referenceTs).getTime() : referenceTs;
  const refValid = Number.isFinite(refMs);
  const refForLogic = refValid ? refMs : Date.now();

  // Strategy 1 — settlement_sources contract code (other commodity series may use this)
  let code = fromSettlementSources(series.settlement_sources, refForLogic);

  // Strategy 2 — KXWTI rollover-window markdown
  if (!code) {
    const md = series?.product_metadata?.important_info?.markdown;
    const pairs = extractFromMarkdown(md, refForLogic);
    const active = pickActivePair(pairs, refForLogic);
    if (active) code = active.code;
  }

  if (!code) return null;
  const yyyymm = contractToYyyymm(code);
  if (!yyyymm) return null;
  return { contract: code, yyyymm };
}

export const __test__ = {
  parseContractCode,
  contractToYyyymm,
  parseEffectiveDate,
  extractFromMarkdown,
  pickActivePair,
  fromSettlementSources,
};
