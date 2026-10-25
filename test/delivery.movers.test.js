// #market-movers v2 embed (DISCORD_CLEANUP_AUTOPILOT_2026-10-25 F3):
// ONE embed, ≤8 lines, each line a link to our page, brand-safe.

import { describe, it, expect } from 'vitest';
import { buildMoversEmbed, MOVERS_TITLE_URL, KALSHI_REFERRAL_URL } from '../src/delivery/discord.js';
import { assertBrandSafe } from '../src/lib/lint-strings.js';

const URL_ = 'https://predictionmarketspicks.com/nba?utm_source=discord&utm_medium=feed&utm_campaign=market-movers';
const line = (text, url = URL_) => ({ text, url });

describe('buildMoversEmbed', () => {
  it('builds one embed whose lines are links to our pages', () => {
    const p = buildMoversEmbed([line('Toronto vs Minnesota — Toronto 50¢ (▲9 in 24h)')]);
    expect(p.embeds).toHaveLength(1);
    expect(p.embeds[0].description).toBe(`[Toronto vs Minnesota — Toronto 50¢ (▲9 in 24h)](${URL_})`);
    expect(p.embeds[0].url).toBe(MOVERS_TITLE_URL);
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(p)).not.toContain(KALSHI_REFERRAL_URL);
    expect(() => assertBrandSafe(p)).not.toThrow();
  });

  it('caps at 8 lines', () => {
    const p = buildMoversEmbed(Array.from({ length: 12 }, (_, i) => line(`Market ${i} — ${i}¢ (▲5 in 24h)`)));
    expect(p.embeds[0].description.split('\n')).toHaveLength(8);
  });

  it('drops a banned-word line instead of sinking the post', () => {
    const p = buildMoversEmbed([line('Best bet on Fed cut — 40¢ (▲6 in 24h)'), line('Fed funds rate — 30¢ (▲5 in 24h)')]);
    expect(p.embeds[0].description.split('\n')).toHaveLength(1);
    expect(() => assertBrandSafe(p)).not.toThrow();
  });

  it('returns null when nothing survives', () => {
    expect(buildMoversEmbed([])).toBeNull();
    expect(buildMoversEmbed([line('bet bet — 1¢ (▲9 in 24h)')])).toBeNull();
  });

  it('strips markdown brackets and @everyone from Kalshi titles', () => {
    const p = buildMoversEmbed([line('[Fed] @everyone — 40¢ (▲6 in 24h)')]);
    expect(p.embeds[0].description).not.toMatch(/\[Fed\]/);
    expect(p.embeds[0].description).not.toContain('@everyone');
  });
});
