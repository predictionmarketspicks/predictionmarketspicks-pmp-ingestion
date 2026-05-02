// Market-movers selection logic.
//
// Pure functions — no I/O. Takes a list of Candidate (from feeds/movers.js),
// applies filters, ranks by score, returns top-N gainers + losers. Mirrors the
// behavior of supabase/functions/discord-market-movers/index.ts so the engine
// can take over Phase 3's cadence without changing what readers see.
//
// Scoring formula: |Δ24h| × log10(max(volume_24h, 10)). Same formula the Edge
// Function uses — biggest mover wins, ties broken by liquidity. log10 keeps
// volume from dominating the rank for thin markets that happen to be churny.

export const VOL_MIN = 500;
export const DELTA_MIN_PP = 3;
export const PRICE_MIN_C = 5;
export const PRICE_MAX_C = 95;
export const TOP_N_PER_DIRECTION = 5;

export function score(c) {
  return Math.abs(c.price_change_24h) * Math.log10(Math.max(c.volume_24h, 10));
}

export function applyFilters(candidates, { sportsRestricted = false, isTest = false } = {}) {
  return candidates.filter((c) => {
    if (sportsRestricted && c.ticker.startsWith('KXNFL')) return false;
    if (c.yes_price < PRICE_MIN_C || c.yes_price > PRICE_MAX_C) return false;
    if (!isTest && c.volume_24h < VOL_MIN) return false;
    if (!isTest && Math.abs(c.price_change_24h) < DELTA_MIN_PP) return false;
    return true;
  });
}

export function selectTop(candidates, { isTest = false } = {}) {
  const gainers = candidates
    .filter((c) => c.price_change_24h > 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, isTest ? 2 : TOP_N_PER_DIRECTION);

  const losers = candidates
    .filter((c) => c.price_change_24h < 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, isTest ? 1 : TOP_N_PER_DIRECTION);

  return { gainers, losers };
}

// posted_alerts key shape — must match the Edge Function so the engine + Edge
// Function dedup against each other during the soak.
export function alertKey(c) {
  const norm = c.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 60);
  return `market_movers:${norm}`;
}

export function moverTier(absDelta) {
  if (absDelta >= 8) return 3;
  if (absDelta >= 5) return 2;
  return 1;
}
