// Multi-commodity Discord embed tests. Phase 1 shipped silver-only; Phase 2A
// parameterizes by meta.commodity so adding a commodity needs no edit in
// delivery/discord.js. Brand-safety still asserts on every payload.

import { describe, it, expect } from 'vitest';
import {
  buildCommodityEmbed,
  buildSilverEmbed,
  KALSHI_REFERRAL_URL,
} from '../src/delivery/discord.js';
import { assertBrandSafe } from '../src/lib/lint-strings.js';

function makeMeta(commodity, overrides = {}) {
  return {
    commodity,
    eventTicker: `KX${commodity.toUpperCase()}-26MAY0817`,
    spotPrice: 35.42,
    etfPrice: 32.15,
    spotLabel: `Pyth ${commodity}`,
    generatedAt: '2026-05-02T18:55:00.000Z',
    hoursToClose: 70.5,
    strikeCount: 28,
    topTier: 'STRONG',
    ...overrides,
  };
}

const TOP_EDGE = {
  direction: 'BUY YES',
  strike: 35.99,
  edge_pp: 0.142,
  kalshi_yes: 0.31,
  options_prob: 0.452,
  rationale:
    'Options imply 45% chance silver above $35.99, market prices it at 31%. YES is underpriced by 14.2pp.',
};

describe('buildCommodityEmbed', () => {
  it('builds a brand-safe silver embed', () => {
    const payload = buildCommodityEmbed(makeMeta('silver'), TOP_EDGE);
    expect(() => assertBrandSafe(payload)).not.toThrow();
    expect(payload.embeds[0].title).toMatch(/^Silver Edge/);
  });

  it('builds a brand-safe gold embed', () => {
    const payload = buildCommodityEmbed(makeMeta('gold'), TOP_EDGE);
    expect(() => assertBrandSafe(payload)).not.toThrow();
    expect(payload.embeds[0].title).toMatch(/^Gold Edge/);
  });

  it('builds a brand-safe oil embed', () => {
    const payload = buildCommodityEmbed(makeMeta('oil'), TOP_EDGE);
    expect(() => assertBrandSafe(payload)).not.toThrow();
    expect(payload.embeds[0].title).toMatch(/^Oil Edge/);
  });

  it('builds a brand-safe copper embed', () => {
    const payload = buildCommodityEmbed(makeMeta('copper'), TOP_EDGE);
    expect(() => assertBrandSafe(payload)).not.toThrow();
    expect(payload.embeds[0].title).toMatch(/^Copper Edge/);
  });

  it('embeds the Kalshi sign-up referral URL, not a per-market deep-link', () => {
    const payload = buildCommodityEmbed(makeMeta('gold'), TOP_EDGE);
    expect(payload.embeds[0].url).toBe(KALSHI_REFERRAL_URL);
  });

  it('does not call toLocaleString on odds (no commas in numbers)', () => {
    const payload = buildCommodityEmbed(makeMeta('silver'), TOP_EDGE);
    const blob = JSON.stringify(payload);
    expect(blob).not.toMatch(/[+-]\d{1,3},\d{3}/);
  });

  it('back-compat: buildSilverEmbed still exported', () => {
    const payload = buildSilverEmbed(makeMeta('silver'), TOP_EDGE);
    expect(payload.embeds[0].title).toMatch(/^Silver Edge/);
  });

  it('shows the spot label from meta in the spot field name', () => {
    const payload = buildCommodityEmbed(
      makeMeta('gold', { spotLabel: 'Pyth XAU/USD' }),
      TOP_EDGE,
    );
    const spotField = payload.embeds[0].fields.find((f) => f.name.includes('Spot'));
    expect(spotField.name).toContain('Pyth XAU/USD');
  });
});
