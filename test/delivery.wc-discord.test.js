// PR 4 — Discord embed shape + brand-safety lock for WC mispricing alerts.
// Locks: link convention (Kalshi sign-up referral, not deep-link), banned-
// word filter passes on representative payloads, color/tier mapping, no
// commas in odds output.

import { describe, it, expect } from 'vitest';
import { buildWcMispricingEmbed } from '../src/delivery/wc-discord.js';
import { KALSHI_REFERRAL_URL } from '../src/delivery/discord.js';
import { assertBrandSafe } from '../src/lib/lint-strings.js';

function strongRow(overrides = {}) {
  return {
    entity_id: 'team:france',
    kind: 'champion',
    display_platform: 'kalshi',
    sim_pct: 28.0,
    market_pct: 18,
    edge_pp: 10.0,
    tier: 'STRONG',
    market_volume_24h: 12000,
    metadata: { market_ticker_or_id: 'KXMENWORLDCUP-26-FRA' },
    ...overrides,
  };
}

describe('buildWcMispricingEmbed', () => {
  it('builds a brand-safe STRONG champion embed', () => {
    const payload = buildWcMispricingEmbed(strongRow());
    expect(() => assertBrandSafe(payload)).not.toThrow();
    expect(payload.embeds[0].title).toMatch(/WC 2026: France/);
    expect(payload.embeds[0].title).toMatch(/STRONG/);
  });

  it('builds a brand-safe MODERATE negative-edge embed (NO underpriced)', () => {
    const payload = buildWcMispricingEmbed(strongRow({ tier: 'MODERATE', sim_pct: 22, market_pct: 28, edge_pp: -6 }));
    expect(() => assertBrandSafe(payload)).not.toThrow();
    expect(payload.embeds[0].description).toMatch(/NO/);
  });

  it('embeds the Kalshi sign-up referral URL, not a per-market deep-link', () => {
    const payload = buildWcMispricingEmbed(strongRow());
    expect(payload.embeds[0].url).toBe(KALSHI_REFERRAL_URL);
  });

  it('uses oracle-gold color for STRONG and indigo for MODERATE', () => {
    expect(buildWcMispricingEmbed(strongRow()).embeds[0].color).toBe(0xc9a243);
    expect(buildWcMispricingEmbed(strongRow({ tier: 'MODERATE', edge_pp: 6 })).embeds[0].color).toBe(0x1b1340);
  });

  it('does not produce comma-separated odds (American odds rule)', () => {
    const payload = buildWcMispricingEmbed(strongRow());
    const blob = JSON.stringify(payload);
    expect(blob).not.toMatch(/[+-]\d{1,3},\d{3}/);
  });

  it('match entity_ids resolve to a "France vs Senegal" title', () => {
    const payload = buildWcMispricingEmbed(
      strongRow({ entity_id: 'match:I-MD1-FRA-SEN', kind: 'match_winner_home' }),
    );
    expect(payload.embeds[0].title).toMatch(/France vs Senegal/);
  });

  it('renders Polymarket label + price when display_platform is polymarket', () => {
    const payload = buildWcMispricingEmbed(strongRow({ display_platform: 'polymarket' }));
    const fields = payload.embeds[0].fields;
    expect(fields[0].name).toMatch(/Polymarket/);
  });

  it('uses copy that survives the word-swap lint (no bet/wager/sportsbook)', () => {
    // Negative edge, NO underpriced — banned-word risk surface
    const payload = buildWcMispricingEmbed(strongRow({ tier: 'MODERATE', edge_pp: -7, sim_pct: 11, market_pct: 18 }));
    expect(() => assertBrandSafe(payload)).not.toThrow();
  });
});
