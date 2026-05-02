// Cross-platform arb comparator.
//
// Reads YES probabilities for each mapping from the Kalshi quote map (mid =
// (yesBid + yesAsk) / 2, fallback last_price) and the Polymarket quote map
// (mid = (bid + ask) / 2, fallback last). Computes spread in pp, classifies
// per arb-thresholds, and writes to arb_alerts via delivery/supabase.
//
// Per-pair throttle (ARB_MIN_INTERVAL_PER_PAIR_MS) and spread-delta dedup
// (ARB_DEDUP_SPREAD_PP) keep the table from filling with no-op rows during
// quote chatter. Tier flips bypass the dedup so subscribers see them.

import { ARB_MAPPINGS } from './arb-mappings.js';
import {
  arbTier,
  arbConfidenceTierInt,
  ARB_DEDUP_SPREAD_PP,
  ARB_MIN_INTERVAL_PER_PAIR_MS,
} from './arb-thresholds.js';

// Per-pair last-write state for dedup. Keyed by pair_slug.
const lastWrite = new Map();

function pickKalshiYes(quote) {
  if (!quote) return null;
  if (quote.yesBid != null && quote.yesAsk != null) {
    return (quote.yesBid + quote.yesAsk) / 2;
  }
  if (quote.price != null) return quote.price;
  if (quote.yesBid != null) return quote.yesBid;
  if (quote.yesAsk != null) return quote.yesAsk;
  return null;
}

function pickPolyYes(quote) {
  if (!quote) return null;
  if (quote.mid != null) return quote.mid;
  if (quote.bid != null && quote.ask != null) return (quote.bid + quote.ask) / 2;
  if (quote.last != null) return quote.last;
  return null;
}

// Inputs are deps so this module is pure-function-testable. Production calls
// pass real `getKalshiQuote` and `getPolymarketYesQuote`.
export function buildComparison(mapping, kalshiQuote, polyQuote) {
  const kalshiYes = pickKalshiYes(kalshiQuote);
  const polyYes = pickPolyYes(polyQuote);
  if (kalshiYes == null || polyYes == null) {
    return { ok: false, reason: 'missing_price' };
  }
  const spread = kalshiYes - polyYes; // signed
  const spreadAbs = Math.abs(spread);
  const tier = arbTier(spreadAbs);
  return {
    ok: true,
    pair_slug: mapping.pair_slug,
    market_a: mapping.kalshi.ticker,
    platform_a: 'kalshi',
    price_a: Number(kalshiYes.toFixed(4)),
    market_b: mapping.polymarket.conditionId,
    platform_b: 'polymarket',
    price_b: Number(polyYes.toFixed(4)),
    spread_pp: Number((spread * 100).toFixed(2)),
    direction: spread > 0 ? 'A_OVER_B' : 'B_OVER_A',
    confidence: tier,
    confidence_tier: arbConfidenceTierInt(tier),
  };
}

// Returns an array of comparator rows that crossed thresholds AND aren't
// suppressed by per-pair dedup. Caller handles the actual write.
export function evaluateAll({ getKalshiQuote, getPolymarketYesQuote, now = Date.now() }) {
  const writes = [];
  for (const mapping of ARB_MAPPINGS) {
    const kQuote = getKalshiQuote(mapping.kalshi.ticker);
    const pQuote = getPolymarketYesQuote(mapping.polymarket.yesTokenId);
    const cmp = buildComparison(mapping, kQuote, pQuote);
    if (!cmp.ok) continue;
    if (cmp.confidence === 'NO_EDGE') continue;

    const last = lastWrite.get(cmp.pair_slug);
    if (last) {
      const ageMs = now - last.ts;
      const tierChanged = last.confidence !== cmp.confidence;
      const spreadDeltaPp = Math.abs(cmp.spread_pp - last.spread_pp) / 100;
      if (
        ageMs < ARB_MIN_INTERVAL_PER_PAIR_MS &&
        !tierChanged &&
        spreadDeltaPp < ARB_DEDUP_SPREAD_PP
      ) {
        continue;
      }
    }

    lastWrite.set(cmp.pair_slug, {
      ts: now,
      confidence: cmp.confidence,
      spread_pp: cmp.spread_pp,
    });
    writes.push(cmp);
  }
  return writes;
}

// Test helper — drop dedup state between cases.
export function _resetDedupState() {
  lastWrite.clear();
}
