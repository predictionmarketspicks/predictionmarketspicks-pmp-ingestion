// Discord bot delivery for engine-fired alerts.
// Uses the existing PMP Discord bot (DISCORD_BOT_TOKEN — same secret the
// Supabase Edge Function scanners use), POSTs to v10 channels/{id}/messages.
//
// Channel routing (IDs from docs/discord-reference.md):
//   STRONG  (≥12pp)     → #oracle-picks 1487857828084584528  (conviction only)
//   MODERATE (7-12pp)   → #edge-feed     1487857830391451750
//   SPECULATIVE (4-7pp) → #edge-feed     1487857830391451750  (consolidated 2026-08-01)
//   Movers (gain/loss)  → #market-movers  1487857819482063049
//
// Embed link convention (superseded 2026-10-25, DISCORD_CLEANUP_AUTOPILOT F8):
// title clicks go to OUR page for the signal (commodity → its tool page,
// movers → the closest category page) with utm_source=discord&utm_medium=feed.
// Kalshi isn't crediting the referral, and the rule is keep traffic on site.
//
// #edge-feed / #oracle-picks commodity alerts go through the shared daily
// budget (discord-budget.js — the same contract as the site's postWithBudget).
//
// Brand-safety guard: every outbound payload runs through assertBrandSafe().
// A banned-word match throws BannedWordError before any HTTP fire.

import { sanitize } from '../lib/sanitize.js';
import { assertBrandSafe } from '../lib/lint-strings.js';
import { applyCalibrationTierCeiling } from './tier-ceiling.js';
import { settleTimeEt } from './alert-key.js';
import { entryRangeText } from '../engine/max-entry.js';
import { getClient } from './supabase.js';
import {
  commodityGate,
  commoditySubjectKey,
  fetchBudgetRemaining,
  fetchUnderlyingKeysToday,
  logCommodityPost,
} from './discord-budget.js';
import { etDateKey } from '../lib/et-time.js';

const KALSHI_REFERRAL_URL =
  'https://kalshi.com/sign-up/?referral=b07a96ab-4b91-4bdc-8285-5ae1927b7000';

const CHANNEL_ID = {
  STRONG: '1487857828084584528',
  MODERATE: '1487857830391451750',   // #edge-feed
  SPECULATIVE: '1487857830391451750', // #edge-feed (was #commodity-edge) — §4.2 SoT: STRONG→#oracle-picks, everything else→#edge-feed
  MOVERS: '1487857819482063049',
  BOT_LOGS: '1487857846111567952',
};

const GAIN_GREEN = 0x2d5a3d; // brand --gain

const COLOR_BY_TIER = {
  STRONG: 0xc9a243, // oracle-gold
  MODERATE: 0x1b1340, // indigo
  SPECULATIVE: 0x7a6e5d, // khaki
};

// Per-commodity title prefix. spotLabel comes from meta (set by commodity-base
// from COMMODITIES[commodity].spotLabel) so adding a commodity needs no edit
// here.
const TITLE_PREFIX = {
  silver: 'Silver Edge',
  gold: 'Gold Edge',
  oil: 'Oil Edge',
  bitcoin: 'Bitcoin Edge',
  copper: 'Copper Edge',
};

const SITE = 'https://predictionmarketspicks.com';
const COMMODITY_UTM = 'utm_source=discord&utm_medium=feed&utm_campaign=commodity';
const TOOL_PAGE = {
  silver: '/tools/silver-edge',
  gold: '/tools/gold-edge',
  oil: '/tools/oil-edge',
  bitcoin: '/tools/bitcoin-edge',
};

export function commodityPageUrl(commodity) {
  return `${SITE}${TOOL_PAGE[commodity] ?? '/commodity-markets'}?${COMMODITY_UTM}`;
}

function probToAmericanOdds(prob) {
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null;
  if (prob >= 0.5) return -Math.round((prob / (1 - prob)) * 100);
  return Math.round(100 / prob - 100);
}

export function buildCommodityEmbed(meta, topEdge) {
  // V2.1 stopgap: uncalibrated bitcoin cannot render as STRONG (§2.4).
  // Applied here AND in postCommodityAlert so the embed's tier label can
  // never disagree with the channel it routes to.
  const tier = applyCalibrationTierCeiling(meta.commodity, meta.topTier, meta);
  const direction = topEdge.direction;
  const edgePct = (topEdge.edge_pp * 100).toFixed(1);
  const sign = topEdge.edge_pp > 0 ? '+' : '−';
  const oddsRaw = probToAmericanOdds(
    direction === 'BUY YES' ? topEdge.kalshi_yes : 1 - topEdge.kalshi_yes,
  );
  const oddsStr = oddsRaw == null ? '' : oddsRaw > 0 ? `+${oddsRaw}` : `${oddsRaw}`;

  const prefix = TITLE_PREFIX[meta.commodity] || `${meta.commodity} Edge`;
  const titleParts = [
    prefix,
    `${direction} $${topEdge.strike.toFixed(2)}`,
    `${sign}${Math.abs(Number(edgePct))}pp`,
    tier,
  ];

  // The prob that actually drove this alert: physical when the row's
  // model_version says V2 owns direction/confidence, legacy otherwise.
  const modelProb = topEdge.model_version === 'v2_physical' && topEdge.prob_physical != null
    ? topEdge.prob_physical
    : topEdge.options_prob;
  const modelPct = (modelProb * 100).toFixed(0);
  const marketPct = (topEdge.kalshi_yes * 100).toFixed(0);
  const sideWord = direction === 'BUY NO' ? 'NO' : 'YES';
  // Derived values only (OPRA rule): our model %, the Kalshi market %, the edge.
  // The engine's rationale string is NOT published — its caveats carry internal
  // plumbing (feed names, rule ids, gate reasons).
  const description =
    `Our model ${modelPct}% vs market ${marketPct}% that ${meta.commodity} is above ` +
    `$${topEdge.strike.toFixed(2)} at settle · ${sideWord} underpriced by ${Math.abs(Number(edgePct)).toFixed(1)} pts`;

  const fields = [
    {
      name: 'Market price',
      value: sanitize(`${(topEdge.kalshi_yes * 100).toFixed(0)}% ${oddsStr ? `(${oddsStr})` : ''}`.trim(), 80),
      inline: true,
    },
    {
      name: 'Our model',
      value: sanitize(`${modelPct}%`, 80),
      inline: true,
    },
    // Max entry (2026-10-23): the range this engine's own rule still passes in.
    ...(() => {
      const side = direction === 'BUY NO' ? 'NO' : 'YES';
      const yes = Number(topEdge.kalshi_yes);
      const cur = Number.isFinite(yes) ? Math.round((side === 'YES' ? yes : 1 - yes) * 100) : null;
      const text = topEdge.max_entry_cents != null
        ? entryRangeText(side, { maxCents: topEdge.max_entry_cents, minCents: topEdge.min_entry_cents ?? null }, cur)
        : null;
      return text ? [{ name: 'Entry range', value: sanitize(text, 120), inline: false }] : [];
    })(),
    // meta.publicPrice, NOT meta.spotPrice: for metals that is Kalshi's locked
    // reference (the vendor quote never goes public); null → the field is omitted.
    // Label is plain `Spot` — meta.spotLabel is internal plumbing (it printed
    // "Yahoo CL=F (contract-aware CLM26.NYM primary, …)" on public cards).
    ...(meta.publicPrice != null && Number.isFinite(meta.publicPrice)
      ? [{
          name: 'Spot',
          value: sanitize(`$${meta.publicPrice.toFixed(2)}`, 80),
          inline: true,
        }]
      : []),
  ];

  return {
    embeds: [
      {
        title: sanitize(titleParts.join(' • '), 256),
        url: commodityPageUrl(meta.commodity),
        color: COLOR_BY_TIER[tier] ?? 0xc9a243,
        description: sanitize(description, 800),
        fields,
        footer: {
          text: sanitize(
            [
              meta.eventTicker,
              settleTimeEt(meta.eventCloseAt) ? `settles ${settleTimeEt(meta.eventCloseAt)}` : null,
              `closes in ${meta.hoursToClose.toFixed(1)}h`,
              `${meta.strikeCount} strikes scanned`,
            ].filter(Boolean).join(' • '),
            120,
          ),
        },
        timestamp: meta.generatedAt,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

async function postToChannel(channelId, payload) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[discord] DISCORD_BOT_TOKEN not set — skipping post');
    return false;
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`discord ${res.status}: ${body.slice(0, 200)}`);
  }
  // Truthy either way; carries the message id when Discord returns one.
  const msg = await res.json().catch(() => null);
  return { id: msg?.id ?? null };
}

// In-process "never the same strike + direction twice in a session" guard.
// Backs up the discord_posts_log check when the ledger is unreadable.
const _sessionSent = new Set();
let _sessionDate = null;

function supabaseOrNull() {
  try {
    return getClient();
  } catch {
    return null;
  }
}

// Returns true only when the alert was actually sent. A gated alert returns
// false, so callers skip their posted_alerts write and the alert is
// re-evaluated (and usually re-gated) on the next snapshot.
// opts.sb / opts.post / opts.now are test seams.
export async function postCommodityAlert(meta, { sb, post = postToChannel, now = new Date() } = {}) {
  const top = meta.topEdge;
  if (!top) return false;
  // Ceiling before channel routing — a ceilinged alert belongs in #edge-feed,
  // not #oracle-picks (§2.4).
  const tier = applyCalibrationTierCeiling(meta.commodity, meta.topTier, meta);
  if (tier === 'NO_EDGE') return false;
  const channelId = CHANNEL_ID[tier];
  if (!channelId) return false;

  const payload = buildCommodityEmbed(meta, top);
  assertBrandSafe(payload);

  const today = etDateKey(now);
  if (_sessionDate !== today) {
    _sessionSent.clear();
    _sessionDate = today;
  }
  const client = sb === undefined ? supabaseOrNull() : sb;
  const [budgetLeft, todayKeys] = client
    ? await Promise.all([
        fetchBudgetRemaining(client, channelId),
        fetchUnderlyingKeysToday(client, meta.commodity, now),
      ])
    : [null, null];
  const subjectKey = commoditySubjectKey(meta.commodity, top);
  const gate = commodityGate({ meta, edge: top, todayKeys, budgetLeft, sessionKeys: _sessionSent, now });
  if (!gate.ok) {
    console.log(`[discord] ${meta.commodity} alert held (${gate.reason}) ${subjectKey} ${tier}`);
    return false;
  }

  const msg = await post(channelId, payload);
  if (!msg) return false;
  _sessionSent.add(`${today}|${subjectKey}`);
  if (client) {
    await logCommodityPost(client, {
      channelId,
      tier,
      title: payload.embeds[0].title,
      messageId: msg?.id ?? null,
      subjectKey,
    });
  }
  return true;
}

// Test-only: reset the in-process session guard.
export function _resetCommoditySession() {
  _sessionSent.clear();
  _sessionDate = null;
}

// Phase 1 back-compat shims so any caller still importing the silver-named
// helpers keeps working. Delete once nothing references them.
export const postSilverAlert = postCommodityAlert;
export const buildSilverEmbed = (meta, topEdge) => buildCommodityEmbed({ commodity: 'silver', ...meta }, topEdge);

// ---------- market movers (v2, 2026-10-25 F3) ----------
//
// ONE embed, ≤8 lines, one line per event, each line a link to our closest
// page. Lines are pre-built by engine/movers.js (moverLineText + moverPageUrl).
// A line that trips the brand-safety lint (a Kalshi title with a banned word)
// is dropped on its own instead of sinking the whole post.

export const MOVERS_TITLE_URL =
  'https://predictionmarketspicks.com/kalshi?utm_source=discord&utm_medium=feed&utm_campaign=market-movers';

export function buildMoversEmbed(lines, { now = new Date() } = {}) {
  const safe = [];
  for (const l of lines ?? []) {
    const text = sanitize(l.text, 180).replace(/[\[\]]/g, '');
    if (!text) continue;
    try {
      assertBrandSafe({ text });
    } catch {
      console.warn(`[movers] line dropped by brand-safety lint: ${text}`);
      continue;
    }
    safe.push(l.url ? `[${text}](${l.url})` : text);
    if (safe.length >= 8) break;
  }
  if (safe.length === 0) return null;
  return {
    embeds: [
      {
        title: 'Market Movers · last 24h on Kalshi',
        url: MOVERS_TITLE_URL,
        color: GAIN_GREEN,
        description: safe.join('\n'),
        footer: { text: 'The 7 Oracles · posts 10 AM + 6 PM ET' },
        timestamp: now.toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export async function postMoversAlert(lines) {
  const payload = buildMoversEmbed(lines);
  if (!payload) return false;
  assertBrandSafe(payload);
  return postToChannel(CHANNEL_ID.MOVERS, payload);
}

// Plain-text alert to #bot-logs for engine infra messages (quota guards,
// failed feeds, etc). No embed, no brand-safety lint — this channel is
// internal and may legitimately surface third-party words.
export async function postBotLog(content) {
  const text = sanitize(String(content || ''), 1900);
  if (!text) return false;
  return postToChannel(CHANNEL_ID.BOT_LOGS, {
    content: text,
    allowed_mentions: { parse: [] },
  });
}

// Embed variant for engines (flow-alerts) that build their own rich payloads.
// content is optional. Sanitization applies to title/description/footer
// because Discord renders embed text from user input.
export async function postBotLogEmbed(embed, { content = '' } = {}) {
  if (!embed) return false;
  const safe = {
    ...embed,
    title: embed.title ? sanitize(String(embed.title), 256) : embed.title,
    description: embed.description ? sanitize(String(embed.description), 4000) : embed.description,
    footer: embed.footer?.text
      ? { ...embed.footer, text: sanitize(String(embed.footer.text), 2000) }
      : embed.footer,
  };
  return postToChannel(CHANNEL_ID.BOT_LOGS, {
    content: content ? sanitize(String(content), 1900) : '',
    embeds: [safe],
    allowed_mentions: { parse: [] },
  });
}

export { KALSHI_REFERRAL_URL, CHANNEL_ID };
