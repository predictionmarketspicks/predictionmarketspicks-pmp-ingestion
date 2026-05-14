// CME WTI contract-month rollover guard. Mirrors the table in the Vercel
// app at lib/tools/oil-edge.ts — when Kalshi's settle source has already
// flipped to the next contract month but Yahoo CL=F continuous still reads
// the prior month, the comparator produces basis-mismatch artifacts dressed
// as edges. Suppress Discord posts (and revalidation) across the window.
//
// Permanent fix: drive engine spot off Kalshi series.settlement_sources
// with specific-month Yahoo tickers (CLM26.NYM etc.) — once that ships,
// delete this module + the import in src/index.js.
//
// Keep the windows table in sync with lib/tools/oil-edge.ts in the Vercel
// repo until the structural fix lands.

const WTI_ROLLOVER_WINDOWS = [
  {
    // JUN26 → JUL26: Kalshi rolls Sat 5/16 00:00 UTC; per Kalshi disclaimer
    // JUN26 LTD = Mon 5/18; CL=F continuous flips overnight to JUL26
    // (effective Tue 5/19). Guard through end of Tue 5/19 NYMEX session.
    from: '2026-05-16T00:00:00Z',
    to: '2026-05-19T19:00:00Z',
    fromContract: 'JUN26',
    toContract: 'JUL26',
  },
];

export function findActiveRollover(eventCloseAt) {
  if (!eventCloseAt) return null;
  const t = new Date(eventCloseAt).getTime();
  if (!Number.isFinite(t)) return null;
  for (const w of WTI_ROLLOVER_WINDOWS) {
    if (t >= new Date(w.from).getTime() && t < new Date(w.to).getTime()) {
      return w;
    }
  }
  return null;
}
