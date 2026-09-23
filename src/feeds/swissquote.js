// Gold / silver SPOT from Swissquote's public quote feed — the replacement for
// Pythnet XAU/USD + XAG/USD, which went dead 2026-09-22 ~13:18 UTC.
//
// ── WHY THIS AND NOT PYTH ────────────────────────────────────────────────────
// Kalshi settles KXGOLDD / KXGOLD15M on `Metal.Index.1OZGOLD/USD` (Pyth Pro id
// 3712) and KXSILVERD / KXSILVER15M on `Metal.Index.SILVER/USD` (id 3154):
// Douro Labs' proprietary 24/7 index feeds, `is_gated: true`
// (app.pyth.com/api/price-feeds/Metal.Index.1OZGOLD%2FUSD). They are not readable
// without a paid Pyth Pro key, and every free Pyth path is now closed: Hermes
// 401 (2026-08-26), Benchmarks 401, and the Pythnet XAU/XAG accounts stopped
// updating (api2 serves a day-old price; rpcpool 403s). NOTE the Pythnet feed we
// read was XAU/USD — itself a PROXY for the index Kalshi names, not the index.
//
// So every free option is a proxy, and the job is to pick the best-measured one:
//   - Swissquote public spot: three live servers, sub-second, two-sided, 24/5.
//   - Yahoo GC=F / SI=F: ~10 min delayed AND futures (≈ +$34 over spot on gold,
//     2026-09-23) — wrong instrument for a 15-minute strike. Rejected.
//   - Databento GLD/SLV: OPRA-derived ETF price, market hours only, licensed
//     internal-only. A cross-check at best. Rejected as primary.
// Evidence for FX-spot-class prices vs Kalshi's own settlement prints is in
// pmp-ingestion/handoffs/METALS_SPOT_SWISSQUOTE_2026-09-23.md, and the
// `metals_spot_marks` table + check-metals-spot-proxy keep measuring it live.
//
// ── WHAT A PRINT IS ──────────────────────────────────────────────────────────
// The endpoint returns one entry per Swissquote server (3 seen), each with
// several spread profiles. Per server we take the TIGHTEST profile's mid; the
// price is the MEDIAN across fresh servers. Servers that disagree by more than
// DISAGREE_SPREADS × the tightest spread are refused — a single bad server can
// move a median of three only if two agree with it.
// `confidence` = half the tightest spread, so pyth.js's existing 1% wide-print
// rejection applies unchanged. `publishTimeMs` = the newest server timestamp,
// never later than now. A closed market (weekends; the daily break) keeps the
// last print with its REAL timestamp and trading:false — exactly what the
// Pythnet transport returned — so each engine's maxSpotAgeMs gate decides
// usability per snapshot, as it always has.

const BASE = process.env.SWISSQUOTE_QUOTES_BASE || 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument';
const FRESH_MS = 60_000; // a server quote older than this is not "trading"
const DISAGREE_SPREADS = 4;

const INSTRUMENTS = {
  'XAU/USD': 'XAU/USD',
  'XAG/USD': 'XAG/USD',
};

export function hasSwissquoteFeed(symbol) {
  return symbol in INSTRUMENTS;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Pure: Swissquote payload → { price, confidence, publishTimeMs, trading, servers }. Exported for tests. */
export function parseSwissquote(payload, nowMs = Date.now()) {
  if (!Array.isArray(payload) || payload.length === 0) throw new Error('swissquote: empty payload');
  const servers = [];
  for (const e of payload) {
    const ts = Number(e?.ts);
    const profiles = Array.isArray(e?.spreadProfilePrices) ? e.spreadProfilePrices : [];
    let best = null;
    for (const p of profiles) {
      const bid = Number(p?.bid);
      const ask = Number(p?.ask);
      if (!(bid > 0) || !(ask > 0) || ask < bid) continue; // one-sided or crossed = absent
      if (!best || ask - bid < best.ask - best.bid) best = { bid, ask };
    }
    if (best && Number.isFinite(ts)) servers.push({ ts, mid: (best.bid + best.ask) / 2, spread: best.ask - best.bid });
  }
  if (servers.length === 0) throw new Error('swissquote: no two-sided quote on any server');

  const fresh = servers.filter((s) => nowMs - s.ts <= FRESH_MS);
  const pool = fresh.length ? fresh : servers; // closed market: last prints, trading:false
  const price = median(pool.map((s) => s.mid));
  const tight = Math.min(...pool.map((s) => s.spread));
  const dispersion = Math.max(...pool.map((s) => s.mid)) - Math.min(...pool.map((s) => s.mid));
  if (pool.length > 1 && dispersion > Math.max(tight, 1e-9) * DISAGREE_SPREADS) {
    throw new Error(`swissquote: servers disagree (${dispersion.toFixed(4)} > ${DISAGREE_SPREADS}× spread ${tight.toFixed(4)})`);
  }
  return {
    price,
    confidence: tight / 2,
    publishTimeMs: Math.min(nowMs, Math.max(...pool.map((s) => s.ts))),
    trading: fresh.length > 0,
    servers: pool.length,
  };
}

export async function fetchSwissquoteSpot(symbol) {
  const inst = INSTRUMENTS[symbol];
  if (!inst) throw new Error(`swissquote: no instrument for ${symbol}`);
  const res = await fetch(`${BASE}/${inst}`, {
    headers: { 'User-Agent': 'pmp-ingestion/0.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`swissquote ${symbol} HTTP ${res.status}`);
  return parseSwissquote(await res.json());
}
