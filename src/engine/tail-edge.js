// Live Longshot Scanner — tail_candidates writer (Phase 2).
//
// Spec: handoffs/TAIL_EDGE_SCANNER_2026-05-10.md §Architecture / §Signal logic.
//
// Pure derivers + one write call. The macro and polymarket-snapshot engines
// call deriveAndWrite*() after their primary snapshot write succeeds, so a
// tail-side failure can never block the canonical snapshot. Each row in this
// table is one observation of a market sitting in the tail (price ≤0.10 OR
// ≥0.90) with enough event-level liquidity to fill. The tail-edge-compute
// edge fn reads the rolling window of these observations to score persistence.
//
// Filter constants live here, not in lib/tail — those are tier-scoring
// concerns; these are ingest concerns. If the cutoffs change, update this file
// and add a note to the handoff.

import { insertTailCandidates } from '../delivery/supabase.js';

export const PRICE_LOW = 0.10;
export const PRICE_HIGH = 0.90;
export const VOLUME_MIN_24H = 10_000;   // matches handoff §1 Filter
export const SPREAD_MAX = 0.04;          // 4 cents — same as handoff

// ─── Polymarket ───────────────────────────────────────────────────────────────
//
// Row shape (from feeds/polymarket-gamma.js → normalizeMarket):
//   condition_id, slug, question, category, tags,
//   best_bid, best_ask, last_trade_price, volume_24h_usdc,
//   volume_total_usdc, liquidity_usdc, open_interest_usdc, outcomes
//
// outcomes shape: [{outcome: 'Yes'|'No', price: 0..1, token_id}, ...] for
// binary markets. Multi-outcome markets are skipped — handoff §Open Questions
// defers them to a follow-up.
export function derivePolymarketTailCandidates(row, observedAt) {
  if (!row || typeof row !== 'object') return [];
  const volume_24h = toFiniteNumber(row.volume_24h_usdc);
  if (volume_24h === null || volume_24h < VOLUME_MIN_24H) return [];
  if (!Array.isArray(row.outcomes) || row.outcomes.length !== 2) return [];
  if (typeof row.slug !== 'string' || row.slug.length === 0) return [];

  const yesOutcome = row.outcomes.find(
    (o) => typeof o?.outcome === 'string' && o.outcome.toLowerCase() === 'yes',
  );
  if (!yesOutcome) return [];
  const yesPrice = toFiniteNumber(yesOutcome.price);
  if (yesPrice === null || yesPrice <= 0 || yesPrice >= 1) return [];

  const bid = toFiniteNumber(row.best_bid);
  const ask = toFiniteNumber(row.best_ask);
  // Gamma best_bid/best_ask are YES-axis. Tight YES book implies a tight NO
  // book; gate both sides on the same spread for v1.
  const spread = bid !== null && ask !== null ? Math.abs(ask - bid) : null;
  if (spread !== null && spread > SPREAD_MAX) return [];

  const parent_volume = toFiniteNumber(row.liquidity_usdc);
  const market_title = typeof row.question === 'string' ? row.question : row.slug;

  const out = [];
  if (yesPrice <= PRICE_LOW) {
    out.push({
      platform: 'polymarket',
      market_ticker: row.slug,
      event_ticker: row.slug,           // Polymarket binary: event == market
      market_title,
      side: 'yes',
      price: roundPrice(yesPrice),
      volume_24h,
      bid: bid !== null && yesPrice <= PRICE_LOW ? roundPrice(bid) : null,
      ask: ask !== null && yesPrice <= PRICE_LOW ? roundPrice(ask) : null,
      parent_volume,
      observed_at: observedAt,
    });
  }
  if (yesPrice >= PRICE_HIGH) {
    out.push({
      platform: 'polymarket',
      market_ticker: row.slug,
      event_ticker: row.slug,
      market_title,
      side: 'no',
      price: roundPrice(1 - yesPrice),
      volume_24h,
      // best_bid/best_ask are YES-side. NO-side prices are 1 - (yes_ask/bid)
      // but we don't have a NO order book directly. Leave bid/ask null for
      // NO observations; the edge fn doesn't use them for persistence.
      bid: null,
      ask: null,
      parent_volume,
      observed_at: observedAt,
    });
  }
  return out;
}

// ─── Kalshi ───────────────────────────────────────────────────────────────────
//
// Row shape (from feeds/kalshi-macro.js → fetchAllMacroMarkets):
//   series_ticker, category, event_ticker, ticker, title, strike,
//   yes_bid_cents, yes_ask_cents, last_price_cents, prev_yes_ask_cents,
//   prev_yes_bid_cents, prev_price_cents, volume_24h, open_interest,
//   implied_pct, close_time
//
// KXMVE* sports parlay junk is already dropped upstream — defensive check kept.
export function deriveKalshiTailCandidates(row, observedAt) {
  if (!row || typeof row !== 'object') return [];
  if (typeof row.ticker !== 'string' || row.ticker.length === 0) return [];
  if (row.ticker.startsWith('KXMVE')) return [];

  const volume_24h = toFiniteNumber(row.volume_24h);
  if (volume_24h === null || volume_24h < VOLUME_MIN_24H) return [];

  const bidCents = toFiniteNumber(row.yes_bid_cents);
  const askCents = toFiniteNumber(row.yes_ask_cents);
  const lastCents = toFiniteNumber(row.last_price_cents);
  // Prefer ask (where you'd buy YES) → last → bid. Mirrors the field-fallback
  // order in tweet-daily-pick and discord-market-movers.
  const yesCents = askCents ?? lastCents ?? bidCents;
  if (yesCents === null || yesCents <= 0 || yesCents >= 100) return [];

  // Spread in cents — SPREAD_MAX is 0.04 = 4 cents.
  const spreadCents = bidCents !== null && askCents !== null ? Math.abs(askCents - bidCents) : null;
  if (spreadCents !== null && spreadCents > SPREAD_MAX * 100) return [];

  const yesPrice = roundPrice(yesCents / 100);
  const bidPrice = bidCents !== null ? roundPrice(bidCents / 100) : null;
  const askPrice = askCents !== null ? roundPrice(askCents / 100) : null;

  const market_title = typeof row.title === 'string' ? row.title : row.ticker;
  const event_ticker = typeof row.event_ticker === 'string' ? row.event_ticker : row.ticker;

  const out = [];
  if (yesPrice <= PRICE_LOW) {
    out.push({
      platform: 'kalshi',
      market_ticker: row.ticker,
      event_ticker,
      market_title,
      side: 'yes',
      price: yesPrice,
      volume_24h,
      bid: bidPrice,
      ask: askPrice,
      parent_volume: null,
      observed_at: observedAt,
    });
  }
  if (yesPrice >= PRICE_HIGH) {
    out.push({
      platform: 'kalshi',
      market_ticker: row.ticker,
      event_ticker,
      market_title,
      side: 'no',
      price: roundPrice(1 - yesPrice),
      volume_24h,
      bid: null,
      ask: null,
      parent_volume: null,
      observed_at: observedAt,
    });
  }
  return out;
}

// ─── Batch writer ─────────────────────────────────────────────────────────────
//
// Caller supplies the snapshot batch + the deriver. We collect candidates and
// hand them to insertTailCandidates in one batched call. Failures log + return
// {count:0, error} — the snapshot engine already finished its primary write
// before invoking us, so a tail-side failure must never escalate.
export async function writeTailCandidatesFromBatch(rows, derive, label) {
  if (!Array.isArray(rows) || rows.length === 0) return { count: 0 };
  const observedAt = new Date().toISOString();
  const candidates = [];
  for (const row of rows) {
    const derived = derive(row, observedAt);
    if (Array.isArray(derived)) {
      for (const c of derived) candidates.push(c);
    }
  }
  if (candidates.length === 0) return { count: 0 };
  try {
    const { count } = await insertTailCandidates(candidates);
    console.log(
      `[tail-edge:${label}] wrote ${count} tail_candidates from ${rows.length} markets`,
    );
    return { count };
  } catch (err) {
    console.warn(
      `[tail-edge:${label}] insertTailCandidates failed:`,
      err?.message || String(err),
    );
    return { count: 0, error: err?.message || String(err) };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toFiniteNumber(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function roundPrice(v) {
  // NUMERIC(5,4) — 4 decimal places, range (0,1).
  return Math.max(0.0001, Math.min(0.9999, Number(v.toFixed(4))));
}

export const __test__ = { toFiniteNumber, roundPrice };
