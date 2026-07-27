// alert-feed.js — edge_alerts publisher for the Fly engine (Node/ESM).
//
// Commodity edges dual-write into the durable feed (edge_alerts) right after the
// Discord post fires. Self-isolating: a feed-write failure is logged, never
// thrown — it must never block the Discord post or the engine tick (mirror of
// insertCommodityEdgeIntraday's isolation).
//
// Self-contained mirror of supabase/functions/_shared/alert-feed.ts (Deno) and
// engine/lib/edge-alert-feed.ts (batch engine). Sanitize + word-swap + vendor
// scrub are inlined; keep the three in sync on any content-rule change.
//
// Content rules: OPRA derived-only (only the derived TradeTicket-equivalent set
// — side, Kalshi price, model prob, edge pp, tier, resolve time — never raw
// bid/ask/mid/NBBO/strike-price/IV); word-swap on title + thesis; vendor scrub;
// sanitize control chars; price_cents clamped 1..99; text length-capped.

import { getClient } from './supabase.js';

// Only these four commodity feeds are valid edge_alerts.feed values.
const COMMODITY_FEEDS = new Set(['bitcoin', 'silver', 'gold', 'oil']);

const TITLE_PREFIX = {
  silver: 'Silver Edge',
  gold: 'Gold Edge',
  oil: 'Oil Edge',
  bitcoin: 'Bitcoin Edge',
};

const WORD_SWAP = [
  [/\bbettors\b/gi, 'traders'],
  [/\bbettor\b/gi, 'trader'],
  [/\bbetting\b/gi, 'trading'],
  [/\bbets\b/gi, 'trades'],
  [/\bbet\b/gi, 'trade'],
  [/\bsportsbooks\b/gi, 'prediction markets'],
  [/\bsportsbook\b/gi, 'prediction market'],
  [/\bwagers\b/gi, 'positions'],
  [/\bwagering\b/gi, 'positioning'],
  [/\bwagered\b/gi, 'positioned'],
  [/\bwager\b/gi, 'position'],
  [/\bgambling\b/gi, 'trading'],
  [/\bgamblers\b/gi, 'traders'],
  [/\bgambler\b/gi, 'trader'],
  [/\bgambles\b/gi, 'trades'],
  [/\bgambled\b/gi, 'traded'],
  [/\bgamble\b/gi, 'trade'],
];

const VENDOR_RE = /\b(databento|opra|tradier|massive|polygon\.io)\b/gi;
const DELAY_RE = /\b15[-\s]?min(?:ute)?s?\s+delayed\b/gi;

function wordSwap(text) {
  let out = text;
  for (const [re, to] of WORD_SWAP) out = out.replace(re, to);
  return out;
}

function scrubVendors(text) {
  return text
    .replace(VENDOR_RE, 'our data')
    .replace(DELAY_RE, 'real-time analysis')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeText(text, maxLen) {
  return String(text ?? '')
    .replace(/@(everyone|here)/g, '@​$1')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .slice(0, maxLen);
}

function clean(text, maxLen) {
  return sanitizeText(scrubVendors(wordSwap(text)), maxLen);
}

function clampCents(c) {
  if (c == null || !Number.isFinite(c)) return null;
  return Math.min(99, Math.max(1, Math.round(c)));
}

// ¼-Kelly stake per $100 (mirror of _shared/trade-ticket.ts quarterKellyPer100).
function quarterKellyPer100(modelProb, priceDecimal) {
  if (!(modelProb > 0) || modelProb >= 1) return 0;
  if (!(priceDecimal > 0) || priceDecimal >= 1) return 0;
  const b = (1 - priceDecimal) / priceDecimal;
  const fullKelly = (b * modelProb - (1 - modelProb)) / b;
  if (fullKelly <= 0) return 0;
  return Math.round(fullKelly * 0.25 * 100 * 100) / 100;
}

// Map a commodity snapshot meta (from commodity-base) + its Discord dedup key
// into an edge_alerts row. Returns null when the snapshot is not publishable.
function commodityMetaToRow(meta, alertKey) {
  const top = meta?.topEdge;
  if (!top || !meta.eventTicker || !alertKey) return null;
  const feed = meta.commodity;
  if (!COMMODITY_FEEDS.has(feed)) return null;
  const tier = meta.topTier;
  if (tier !== 'STRONG' && tier !== 'MODERATE' && tier !== 'SPECULATIVE') return null;

  const side = top.direction === 'BUY YES' ? 'YES' : 'NO';
  const yesProb = Number(top.kalshi_yes) || 0;
  const priceCents = clampCents((side === 'YES' ? yesProb : 1 - yesProb) * 100);
  // Model prob = the one that drove direction/tier: physical under V2
  // (model_version='v2_physical'), legacy risk-neutral otherwise.
  const activeProb =
    top.model_version === 'v2_physical' && top.prob_physical != null
      ? top.prob_physical
      : top.options_prob;
  const optProb = activeProb == null ? null : Number(activeProb);
  const modelProb = optProb == null ? null : side === 'YES' ? optProb : 1 - optProb;
  const activeEdge = top.fused_edge_pp != null ? top.fused_edge_pp : top.edge_pp;
  const edgePp = activeEdge == null ? null : parseFloat((Math.abs(activeEdge) * 100).toFixed(1));

  const prefix = TITLE_PREFIX[feed] || `${feed} Edge`;
  const modelStr = modelProb == null ? '' : ` model ${Math.round(modelProb * 100)}%,`;
  const title = `${prefix} ${side} $${Number(top.strike).toFixed(2)} — market ${priceCents ?? '—'}¢,${modelStr} edge ${edgePp ?? 0}pp`;

  const quarterKelly = modelProb != null && priceCents != null
    ? quarterKellyPer100(modelProb, priceCents / 100)
    : 0;

  return {
    created_at: new Date().toISOString(),
    feed,
    alert_type: 'commodity_edge',
    tier,
    platform: 'Kalshi',
    event_ticker: meta.eventTicker,
    market_ticker: null,
    title: clean(title, 200),
    side,
    price_cents: priceCents,
    model_prob: modelProb,
    edge_pp: activeEdge == null ? null : parseFloat((Math.abs(activeEdge) * 100).toFixed(1)),
    thesis: top.rationale ? clean(top.rationale, 280) : null,
    resolves_at: meta.eventCloseAt ?? null,
    meta: {
      commodity: feed,
      spot_price: meta.spotPrice ?? null,
      hours_to_close: meta.hoursToClose != null ? Math.round(meta.hoursToClose) : null,
      quarter_kelly: quarterKelly,
    },
    alert_key: alertKey,
  };
}

// Publish a commodity edge into edge_alerts. Never throws — returns true on a
// successful upsert, false otherwise. Call it only for a publishable snapshot
// (top edge present, tier != NO_EDGE) using the same alert_key the Discord
// dedup already computed.
export async function publishCommodityEdgeAlert(meta, alertKey) {
  try {
    const row = commodityMetaToRow(meta, alertKey);
    if (!row) return false;
    const sb = getClient();
    const { error } = await sb
      .from('edge_alerts')
      .upsert(row, { onConflict: 'alert_key' });
    if (error) {
      console.error('[edge-alerts] commodity publish failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[edge-alerts] commodity publish exception:', err?.message || err);
    return false;
  }
}
