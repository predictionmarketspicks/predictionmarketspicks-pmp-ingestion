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
    publicPrice: 35.4,
    etfPrice: 32.15,
    spotLabel: `Kalshi 15-min reference`,
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

  it('builds a brand-safe bitcoin embed', () => {
    const payload = buildCommodityEmbed(makeMeta('bitcoin'), TOP_EDGE);
    expect(() => assertBrandSafe(payload)).not.toThrow();
    expect(payload.embeds[0].title).toMatch(/^Bitcoin Edge/);
  });

  it('title links the commodity tool page with discord UTMs, never the Kalshi referral (F8)', () => {
    const payload = buildCommodityEmbed(makeMeta('gold'), TOP_EDGE);
    expect(payload.embeds[0].url).toBe(
      'https://predictionmarketspicks.com/tools/gold-edge?utm_source=discord&utm_medium=feed&utm_campaign=commodity',
    );
    expect(JSON.stringify(payload)).not.toContain(KALSHI_REFERRAL_URL);
    expect(buildCommodityEmbed(makeMeta('copper'), TOP_EDGE).embeds[0].url).toMatch(
      /\/commodity-markets\?utm_source=discord/,
    );
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

  it('labels the spot field plain `Spot` — the internal spotLabel never prints (F4)', () => {
    const label = 'Yahoo CL=F (contract-aware CLM26.NYM primary, CL=F continuous fallback)';
    const payload = buildCommodityEmbed(makeMeta('oil', { spotLabel: label }), TOP_EDGE);
    const spotField = payload.embeds[0].fields.find((f) => f.name.includes('Spot'));
    expect(spotField.name).toBe('Spot');
    expect(JSON.stringify(payload)).not.toMatch(/Yahoo|CLM26|CL=F/);
  });

  it('labels the model field `Our model`, never `Options model` (F4)', () => {
    const payload = buildCommodityEmbed(makeMeta('gold'), TOP_EDGE);
    const names = payload.embeds[0].fields.map((f) => f.name);
    expect(names).toContain('Our model');
    expect(names).not.toContain('Options model');
    expect(payload.embeds[0].fields.find((f) => f.name === 'Our model').value).toBe('45%');
  });

  it('publishes only derived values: description is model % vs market % + edge, never the raw rationale', () => {
    const edge = {
      ...TOP_EDGE,
      rationale: 'Model implies 45% (caveat: thin options volume on contributing strikes — IV may be unreliable) rule:R12',
    };
    const payload = buildCommodityEmbed(makeMeta('gold'), edge);
    const d = payload.embeds[0].description;
    expect(d).toBe('Our model 45% vs market 31% that gold is above $35.99 at settle · YES underpriced by 14.2 pts');
    const blob = JSON.stringify(payload);
    expect(blob).not.toMatch(/\bIV\b|implied vol|options chain|bid|ask|NBBO|Databento|OPRA|Tradier|Massive|Yahoo|Pyth/i);
    expect(blob).not.toContain('rule:R12');
  });

  it('prints the PUBLIC price, never the engine spot (vendor quote / licensed index)', () => {
    const payload = buildCommodityEmbed(makeMeta('gold', { spotPrice: 4289.08, publicPrice: 4285.46 }), TOP_EDGE);
    const spotField = payload.embeds[0].fields.find((f) => f.name.includes('Spot'));
    expect(spotField.value).toBe('$4285.46');
    expect(JSON.stringify(payload)).not.toContain('4289.08');
  });

  it('omits the spot field when there is no public price (no open window)', () => {
    const payload = buildCommodityEmbed(makeMeta('gold', { spotPrice: 4289.08, publicPrice: null }), TOP_EDGE);
    expect(payload.embeds[0].fields.find((f) => f.name.includes('Spot'))).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('4289.08');
  });
});
