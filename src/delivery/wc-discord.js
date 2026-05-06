// World Cup mispricing → Discord delivery.
//
// Channel routing (CHANNEL_ID inherited from delivery/discord.js):
//   STRONG   → #oracle-picks (pro-locked)
//   MODERATE → #premium-alerts (pro-locked)
//   SPEC     → not posted (engine handles the gate; this module ignores SPEC)
//
// Embed link convention (CLAUDE.md May 2 update): title clicks go to the
// Kalshi sign-up referral URL, not a per-market deep-link. Same convention
// as commodity edge + movers.
//
// Word-swap is enforced by assertBrandSafe() — banned words throw before
// any HTTP fire so a copy regression fails the test suite, not production.

import { sanitize } from '../lib/sanitize.js';
import { assertBrandSafe } from '../lib/lint-strings.js';
import { CHANNEL_ID, KALSHI_REFERRAL_URL } from './discord.js';
import { prettyEntity } from '../engine/wc-mispricings.js';

const COLOR_BY_TIER = {
  STRONG: 0xc9a243, // oracle-gold
  MODERATE: 0x1b1340, // indigo
  SPECULATIVE: 0x7a6e5d, // khaki (not posted but kept for completeness)
};

// Map kind → human-readable label for the embed title.
const KIND_LABEL = {
  champion: 'Champion',
  advance: 'Advance to KO',
  group_winner: 'Group Winner',
  match_winner_home: 'Home Win',
  match_winner_draw: 'Draw',
  match_winner_away: 'Away Win',
  match_o25: 'Over 2.5 Goals',
  match_btts: 'Both Teams to Score',
  reach_r16: 'Reach R16',
  reach_qf: 'Reach QF',
  reach_sf: 'Reach SF',
  reach_final: 'Reach Final',
  golden_boot: 'Golden Boot',
  player_anytime_scorer: 'Anytime Scorer',
};

const PLATFORM_LABEL = {
  kalshi: 'Kalshi',
  polymarket: 'Polymarket',
  draftkings: 'DraftKings',
};

function probToAmericanOdds(pct) {
  const p = pct / 100;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  if (p >= 0.5) return -Math.round((p / (1 - p)) * 100);
  return Math.round(100 / p - 100);
}

function fmtOdds(pct) {
  const o = probToAmericanOdds(pct);
  if (o == null) return '';
  return o > 0 ? `+${o}` : `${o}`;
}

export function buildWcMispricingEmbed(row) {
  const sign = row.edge_pp >= 0 ? '+' : '−';
  const absEdge = Math.abs(row.edge_pp).toFixed(1);
  const direction = row.edge_pp >= 0 ? 'YES underpriced' : 'NO underpriced';
  const kindLabel = KIND_LABEL[row.kind] || row.kind;
  const platformLabel = PLATFORM_LABEL[row.display_platform] || row.display_platform;
  const entityLabel = prettyEntity(row.entity_id);

  const titleParts = [
    `WC 2026: ${entityLabel}`,
    kindLabel,
    `${sign}${absEdge}pp`,
    row.tier,
  ];

  const marketOddsStr = fmtOdds(row.market_pct);
  const simOddsStr = fmtOdds(row.sim_pct);

  const fields = [
    {
      name: `${platformLabel} price`,
      value: sanitize(`${Math.round(row.market_pct)}¢ ${marketOddsStr ? `(${marketOddsStr})` : ''}`.trim(), 80),
      inline: true,
    },
    {
      name: 'Our model',
      value: sanitize(`${row.sim_pct.toFixed(1)}% ${simOddsStr ? `(${simOddsStr})` : ''}`.trim(), 80),
      inline: true,
    },
    {
      name: 'Edge',
      value: sanitize(`${sign}${absEdge}pp ${row.tier}`, 80),
      inline: true,
    },
    {
      name: 'Volume 24h',
      value: sanitize(Math.round(row.market_volume_24h).toLocaleString('en-US'), 80),
      inline: true,
    },
  ];

  const description =
    direction === 'YES underpriced'
      ? `Our model has ${entityLabel} at ${row.sim_pct.toFixed(1)}% to ${kindLabel.toLowerCase()}. ${platformLabel} is at ${Math.round(row.market_pct)}¢. Worth a position on YES.`
      : `Our model has ${entityLabel} at ${row.sim_pct.toFixed(1)}% to ${kindLabel.toLowerCase()}. ${platformLabel} is at ${Math.round(row.market_pct)}¢ — overpriced. Worth a position on NO.`;

  return {
    embeds: [
      {
        title: sanitize(titleParts.join(' • '), 256),
        url: KALSHI_REFERRAL_URL,
        color: COLOR_BY_TIER[row.tier] ?? 0xc9a243,
        description: sanitize(description, 800),
        fields,
        footer: {
          text: sanitize(
            `World Cup 2026 • ${platformLabel} • ${row.metadata?.market_ticker_or_id || ''}`.trim(),
            120,
          ),
        },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

async function postToChannel(channelId, payload) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[wc-discord] DISCORD_BOT_TOKEN not set — skipping post');
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

export async function postWcMispricingAlert(row) {
  if (!row || !row.tier) return false;
  if (row.tier === 'SPECULATIVE') return false;
  const channelId = CHANNEL_ID[row.tier];
  if (!channelId) return false;

  const payload = buildWcMispricingEmbed(row);
  assertBrandSafe(payload);
  return postToChannel(channelId, payload);
}
