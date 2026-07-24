// Market Positioning Layer — Phase 1 compute driver.
// handoffs/MARKET_POSITIONING_LAYER_2026-07-12.md §4, §8
//
// Turns the open-interest + volume we already snapshot into a positioning
// signal (conviction / crowding / churn / unwind), mirroring the commodity
// COT + dealer-gamma modifier pattern but for Kalshi macro/politics/sports.
//
// The actual math (daily rollup, z-scores, state ladder, [0.6,1.4] modifier)
// lives in the compute_market_positioning() Postgres function — this module is
// just the fire-and-forget driver hooked into the macro snapshot tick, so the
// z-score history reads from the same rows the macro engine just wrote. No
// extra Kalshi calls in Phase 1 (OI/volume already came down with the snapshot).
//
// Sub-signal C (order-book imbalance) is Phase 2 — book_imbalance stays NULL.

import { computeMarketPositioning } from '../delivery/supabase.js';
import { recordTick, registerFeed, setFeedStatus } from '../observability/health.js';

const state = {
  runs: 0,
  rowsWritten: 0,
  lastRunAt: null,
  lastErrorAt: null,
  lastError: null,
};

registerFeed('positioning_engine');

// Called after each macro snapshot write. Never throws — a failed positioning
// pass must not take down the primary snapshot loop (mirrors the tail-edge
// fire-and-forget contract in macro.js).
export async function runPositioningOnce() {
  state.runs += 1;
  state.lastRunAt = new Date().toISOString();
  try {
    const { count } = await computeMarketPositioning();
    state.rowsWritten += count;
    if (count === 0) {
      // Loud on silent no-op: open markets → 0 positioning rows means the
      // macro snapshot for today is missing or empty. Surfaced via /health.
      state.lastError = 'compute_market_positioning wrote 0 rows';
      state.lastErrorAt = state.lastRunAt;
      setFeedStatus('positioning_engine', { connected: false, lastError: state.lastError });
      console.warn('[positioning] compute wrote 0 rows — macro snapshot likely empty');
      return { rowsWritten: 0 };
    }
    recordTick('positioning_engine');
    console.log(`[positioning] compute wrote ${count} rows`);
    return { rowsWritten: count };
  } catch (err) {
    state.lastErrorAt = new Date().toISOString();
    state.lastError = (err?.message || String(err)).slice(0, 240);
    setFeedStatus('positioning_engine', { connected: false, lastError: state.lastError });
    console.error('[positioning] compute failed', err?.message || err);
    return { rowsWritten: 0 };
  }
}

export function getPositioningState() {
  return { ...state };
}
