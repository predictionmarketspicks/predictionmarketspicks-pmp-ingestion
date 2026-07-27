// Discord bot delivery for engine-fired alerts.
// Uses the existing PMP Discord bot (DISCORD_BOT_TOKEN — same secret the
// Supabase Edge Function scanners use), POSTs to v10 channels/{id}/messages.
//
// Channel routing (IDs from docs/discord-reference.md):
//   STRONG  (≥12pp)    → #oracle-picks   1487857828084584528
//   MODERATE (7-12pp)  → #premium-alerts 1487857830391451750
//   SPECULATIVE (4-7pp) → #commodity-edge 1499364066706198542
//   Movers (gain/loss)  → #market-movers  1487857819482063049
//
// Embed link convention (CLAUDE.md, locked May 2 2026): title clicks go to the
// Kalshi sign-up referral URL, NOT a per-market deep-link.
//
// Brand-safety guard: every outbound payload runs through assertBrandSafe().
// A banned-word match throws BannedWordError before any HTTP fire.

import { sanitize } from '../lib/sanitize.js';
import { assertBrandSafe } from '../lib/lint-strings.js';

const KALSHI_REFERRAL_URL =
  'https://kalshi.com/sign-up/?referral=b07a96ab-4b91-4bdc-8285-5ae1927b7000';

const CHANNEL_ID = {
  STRONG: '1487857828084584528',
  MODERATE: '1487857830391451750',
  SPECULATIVE: '1499364066706198542',
  MOVERS: '1487857819482063049',
  BOT_LOGS: '1487857846111567952',
};

const GAIN_GREEN = 0x2d5a3d; // brand --gain
const LOSS_RED = 0x8b2e2e; // brand --loss

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

function probToAmericanOdds(prob) {
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null;
  if (prob >= 0.5) return -Math.round((prob / (1 - prob)) * 100);
  return Math.round(100 / prob - 100);
}

export function buildCommodityEmbed(meta, topEdge) {
  const tier = meta.topTier;
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

  const fields = [
    {
      name: 'Market price',
      value: sanitize(`${(topEdge.kalshi_yes * 100).toFixed(0)}% ${oddsStr ? `(${oddsStr})` : ''}`.trim(), 80),
      inline: true,
    },
    {
      name: 'Options model',
      // Show the prob that actually drove this alert: physical when the row's
      // model_version says V2 owns direction/confidence, legacy otherwise.
      value: sanitize(
        `${((topEdge.model_version === 'v2_physical' && topEdge.prob_physical != null
          ? topEdge.prob_physical
          : topEdge.options_prob) * 100).toFixed(0)}%`,
        80,
      ),
      inline: true,
    },
    {
      name: `Spot (${meta.spotLabel})`,
      value: sanitize(`$${meta.spotPrice.toFixed(2)}`, 80),
      inline: true,
    },
  ];

  return {
    embeds: [
      {
        title: sanitize(titleParts.join(' • '), 256),
        url: KALSHI_REFERRAL_URL,
        color: COLOR_BY_TIER[tier] ?? 0xc9a243,
        description: sanitize(topEdge.rationale || '', 800),
        fields,
        footer: {
          text: sanitize(
            `${meta.eventTicker} • closes in ${meta.hoursToClose.toFixed(1)}h • ${meta.strikeCount} strikes scanned`,
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
  return true;
}

export async function postCommodityAlert(meta) {
  const top = meta.topEdge;
  if (!top) return false;
  const tier = meta.topTier;
  if (tier === 'NO_EDGE') return false;
  const channelId = CHANNEL_ID[tier];
  if (!channelId) return false;

  const payload = buildCommodityEmbed(meta, top);
  assertBrandSafe(payload);
  return postToChannel(channelId, payload);
}

// Phase 1 back-compat shims so any caller still importing the silver-named
// helpers keeps working. Delete once nothing references them.
export const postSilverAlert = postCommodityAlert;
export const buildSilverEmbed = buildCommodityEmbed;

// ---------- market movers (Phase 3) ----------
//
// Gainers + losers post: a single Discord message with up to 10 embeds, posted
// to #market-movers. Mirrors the discord-market-movers Edge Function output
// during the soak window so readers see no diff at handoff.

export function buildMoverEmbed(c, isGainer) {
  const arrow = isGainer ? '🟢▲' : '🔴▼';
  const color = isGainer ? GAIN_GREEN : LOSS_RED;
  const absDelta = Math.abs(c.price_change_24h);
  return {
    title: sanitize(c.title, 240),
    url: KALSHI_REFERRAL_URL,
    color,
    fields: [
      { name: 'Series', value: sanitize(c.seriesOrSlug, 80), inline: true },
      { name: 'Yes Price', value: `${c.yes_price}¢`, inline: true },
      { name: 'Δ 24h', value: `${arrow} ${absDelta}pp`, inline: true },
      {
        name: 'Volume 24h',
        value: Math.round(c.volume_24h).toLocaleString('en-US'),
        inline: true,
      },
      { name: 'Ticker', value: `\`${sanitize(c.ticker, 60)}\``, inline: true },
      { name: 'Category', value: sanitize(c.category, 40), inline: true },
    ],
    footer: { text: 'Market Movers · The 7 Oracles' },
    timestamp: new Date().toISOString(),
  };
}

export async function postMoversAlert({ gainers, losers }) {
  const embeds = [
    ...gainers.map((c) => buildMoverEmbed(c, true)),
    ...losers.map((c) => buildMoverEmbed(c, false)),
  ].slice(0, 10);
  if (embeds.length === 0) return false;
  const payload = { embeds, allowed_mentions: { parse: [] } };
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
