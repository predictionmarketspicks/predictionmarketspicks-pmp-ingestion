// Discord bot delivery for commodity edge alerts.
// Uses the existing PMP Discord bot (DISCORD_BOT_TOKEN — same secret the
// Supabase Edge Function scanners use), POSTs to v10 channels/{id}/messages.
//
// Channel routing (Phase 1, silver-only, IDs from docs/discord-reference.md):
//   STRONG  (≥12pp)    → #oracle-picks   1487857828084584528
//   MODERATE (7-12pp)  → #premium-alerts 1487857830391451750
//   SPECULATIVE (4-7pp) → #commodity-edge 1499364066706198542
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

// Stable channel IDs — single source of truth is docs/discord-reference.md.
// Hardcoding (vs env vars) matches the existing Edge Function pattern and
// keeps deploy friction to one secret (DISCORD_BOT_TOKEN).
const CHANNEL_ID = {
  STRONG: '1487857828084584528', // #oracle-picks
  MODERATE: '1487857830391451750', // #premium-alerts
  SPECULATIVE: '1499364066706198542', // #commodity-edge
};

const COLOR_BY_TIER = {
  STRONG: 0xc9a243, // oracle-gold
  MODERATE: 0x1b1340, // indigo
  SPECULATIVE: 0x7a6e5d, // khaki
};

function probToAmericanOdds(prob) {
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null;
  if (prob >= 0.5) return -Math.round((prob / (1 - prob)) * 100);
  return Math.round(100 / prob - 100);
}

function buildSilverEmbed(meta, topEdge) {
  const tier = meta.topTier;
  const direction = topEdge.direction;
  const edgePct = (topEdge.edge_pp * 100).toFixed(1);
  const sign = topEdge.edge_pp > 0 ? '+' : '−';
  const oddsRaw = probToAmericanOdds(
    direction === 'BUY YES' ? topEdge.kalshi_yes : 1 - topEdge.kalshi_yes,
  );
  const oddsStr = oddsRaw == null ? '' : oddsRaw > 0 ? `+${oddsRaw}` : `${oddsRaw}`;

  const titleParts = [
    'Silver Edge',
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
      value: sanitize(`${(topEdge.options_prob * 100).toFixed(0)}%`, 80),
      inline: true,
    },
    {
      name: 'Spot (Pyth XAG/USD)',
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

// Returns true on successful delivery, false on skip (no token / NO_EDGE),
// throws on HTTP failure or brand-safety violation.
export async function postSilverAlert(meta) {
  const top = meta.topEdge;
  if (!top) return false;
  const tier = meta.topTier;
  if (tier === 'NO_EDGE') return false;
  const channelId = CHANNEL_ID[tier];
  if (!channelId) return false;

  const payload = buildSilverEmbed(meta, top);
  // Hard-stop if any banned word slipped through.
  assertBrandSafe(payload);
  return postToChannel(channelId, payload);
}

export { buildSilverEmbed, KALSHI_REFERRAL_URL, CHANNEL_ID };
