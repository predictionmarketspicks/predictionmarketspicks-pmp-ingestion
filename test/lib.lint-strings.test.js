// Brand word-swap guard tests. CLAUDE.md is the source of truth for the
// banned-word list. This suite is what guarantees Discord embeds + Realtime
// payloads can never ship copy that mentions bet/wager/sportsbook etc.

import { describe, it, expect } from 'vitest';
import {
  findBannedWord,
  lintPayload,
  assertBrandSafe,
  BannedWordError,
} from '../src/lib/lint-strings.js';
import { buildSilverEmbed } from '../src/delivery/discord.js';

describe('findBannedWord', () => {
  it('catches the banned vocabulary', () => {
    expect(findBannedWord('place a bet')).toBe('bet');
    expect(findBannedWord('wager on the outcome')).toBe('wager');
    expect(findBannedWord('a popular sportsbook')).toBe('sportsbook');
    expect(findBannedWord('bookmaker odds')).toBe('bookmaker');
    expect(findBannedWord('the bookie said')).toBe('bookie');
    expect(findBannedWord('online gambling')).toBe('gambling');
    expect(findBannedWord('one bettor')).toBe('bettor');
  });

  it('case-insensitive', () => {
    expect(findBannedWord('A SPORTSBOOK favorite')).toBe('SPORTSBOOK');
  });

  it('respects word boundaries (does not flag substrings)', () => {
    expect(findBannedWord('the alphabetic order')).toBe(null);
    expect(findBannedWord('rebetting the clock')).toBe(null); // contiguous letters, no boundary
    // Note: underscore is a JS word char, so `bookmaker_id` does NOT match \b.
    // Surface column-name conflicts via review, not lint.
  });

  it('passes the approved vocabulary', () => {
    expect(findBannedWord('take a position on this contract')).toBe(null);
    expect(findBannedWord('the trader bought yes')).toBe(null);
    expect(findBannedWord('prediction market is pricing this at 67%')).toBe(null);
    expect(findBannedWord('BUY YES $35.99')).toBe(null);
  });
});

describe('lintPayload', () => {
  it('walks nested objects and arrays', () => {
    const r = lintPayload({
      a: 'fine',
      b: { c: ['ok', 'still ok', 'place your bet here'] },
    });
    expect(r.ok).toBe(false);
    expect(r.offender).toBe('bet');
    expect(r.path).toContain('.b.c[2]');
  });

  it('passes a clean payload', () => {
    expect(lintPayload({ a: 'oracle pick', b: ['BUY YES', 35.99] }).ok).toBe(true);
  });
});

describe('assertBrandSafe', () => {
  it('throws BannedWordError on violation', () => {
    expect(() => assertBrandSafe({ description: 'place a bet on red' })).toThrow(BannedWordError);
  });
});

describe('Discord silver embed brand-safety', () => {
  // Synthetic snapshot — exercises the same code path runtime would hit.
  const meta = {
    eventTicker: 'KXSILVERW-26MAY0817',
    spotPrice: 35.42,
    etfPrice: 32.15,
    generatedAt: '2026-05-02T18:55:00.000Z',
    hoursToClose: 70.5,
    strikeCount: 28,
    topTier: 'STRONG',
  };
  const topEdge = {
    direction: 'BUY YES',
    strike: 35.99,
    edge_pp: 0.142,
    kalshi_yes: 0.31,
    options_prob: 0.452,
    rationale:
      'Options imply 45% chance silver above $35.99, market prices it at 31%. YES is underpriced by 14.2pp.',
  };

  it('builds a brand-safe embed', () => {
    const payload = buildSilverEmbed(meta, topEdge);
    expect(() => assertBrandSafe(payload)).not.toThrow();
  });

  it('embeds the Kalshi sign-up referral URL, not a per-market deep-link', () => {
    const payload = buildSilverEmbed(meta, topEdge);
    expect(payload.embeds[0].url).toBe(
      'https://kalshi.com/sign-up/?referral=b07a96ab-4b91-4bdc-8285-5ae1927b7000',
    );
  });

  it('does not call toLocaleString on odds (American odds, no commas)', () => {
    const payload = buildSilverEmbed(meta, topEdge);
    const blob = JSON.stringify(payload);
    expect(blob).not.toMatch(/\+\d{1,3},\d{3}/);
    expect(blob).not.toMatch(/-\d{1,3},\d{3}/);
  });
});
