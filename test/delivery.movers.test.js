// Movers Discord embed shape + brand-safety. Mirrors the Edge Function output
// so the soak window doesn't show readers a different format.

import { describe, it, expect } from 'vitest';
import { buildMoverEmbed } from '../src/delivery/discord.js';
import { assertBrandSafe } from '../src/lib/lint-strings.js';

const BASE = {
  source: 'kalshi',
  seriesOrSlug: 'KXFED',
  ticker: 'KXFED-26MAY-CUT25',
  title: 'Will the Fed cut by 25bp in May?',
  yes_price: 42,
  volume_24h: 12_500,
  price_change_24h: 6,
  category: 'Economics',
};

describe('buildMoverEmbed', () => {
  it('builds a brand-safe gainer embed', () => {
    const e = buildMoverEmbed(BASE, true);
    expect(e.color).toBe(0x2d5a3d);
    expect(e.fields.find((f) => f.name === 'Δ 24h').value).toContain('🟢▲');
    expect(e.fields.find((f) => f.name === 'Yes Price').value).toBe('42¢');
    expect(e.fields.find((f) => f.name === 'Series').value).toBe('KXFED');
    expect(() => assertBrandSafe({ embeds: [e] })).not.toThrow();
  });

  it('builds a brand-safe loser embed with red color and ▼ arrow', () => {
    const e = buildMoverEmbed({ ...BASE, price_change_24h: -8 }, false);
    expect(e.color).toBe(0x8b2e2e);
    expect(e.fields.find((f) => f.name === 'Δ 24h').value).toContain('🔴▼');
    expect(() => assertBrandSafe({ embeds: [e] })).not.toThrow();
  });

  it('formats volume with US thousand separators', () => {
    const e = buildMoverEmbed({ ...BASE, volume_24h: 1_234_567.89 }, true);
    expect(e.fields.find((f) => f.name === 'Volume 24h').value).toBe('1,234,568');
  });

  it('rejects banned-word titles via assertBrandSafe', () => {
    const e = buildMoverEmbed({ ...BASE, title: 'Best bet on Fed cut' }, true);
    expect(() => assertBrandSafe({ embeds: [e] })).toThrow();
  });
});
