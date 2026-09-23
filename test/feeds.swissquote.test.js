// Swissquote gold/silver spot — the Pythnet replacement (2026-09-23).
// Fixture shape is the live payload captured 2026-09-23 (3 servers, several
// spread profiles each); prices rounded, structure verbatim.

import { describe, it, expect } from 'vitest';
import { parseSwissquote, hasSwissquoteFeed } from '../src/feeds/swissquote.js';

const NOW = 1_790_180_000_000;
const server = (ts, profiles) => ({ topo: { platform: 'x', server: 'y' }, ts, spreadProfilePrices: profiles });
const LIVE = [
  server(NOW - 800, [
    { spreadProfile: 'premium', bid: 4286.171, ask: 4286.829 },
    { spreadProfile: 'prime', bid: 4286.181, ask: 4286.819 },
    { spreadProfile: 'elite', bid: 4286.248, ask: 4286.752 },
  ]),
  server(NOW - 800, [
    { spreadProfile: 'standard', bid: 4286.155, ask: 4286.845 },
    { spreadProfile: 'prime', bid: 4286.183, ask: 4286.818 },
  ]),
  server(NOW - 800, [
    { spreadProfile: 'prime', bid: 4286.183, ask: 4286.817 },
    { spreadProfile: 'elite', bid: 4286.248, ask: 4286.752 },
  ]),
];

describe('parseSwissquote', () => {
  it('median of the tightest-profile mid per server; half-spread as confidence', () => {
    const p = parseSwissquote(LIVE, NOW);
    expect(p.price).toBeCloseTo(4286.5, 3);
    expect(p.confidence).toBeCloseTo(0.252, 3);
    expect(p.trading).toBe(true);
    expect(p.servers).toBe(3);
    expect(p.publishTimeMs).toBe(NOW - 800);
  });

  it('a closed market keeps the last print with its REAL timestamp and trading:false', () => {
    const stale = LIVE.map((s) => ({ ...s, ts: NOW - 36 * 3600_000 }));
    const p = parseSwissquote(stale, NOW);
    expect(p.trading).toBe(false);
    expect(p.publishTimeMs).toBe(NOW - 36 * 3600_000); // the engine's maxSpotAgeMs gate decides
  });

  it('refuses when servers disagree beyond a few spreads — never averages a bad print in', () => {
    const bad = [...LIVE.slice(0, 2), server(NOW - 800, [{ spreadProfile: 'prime', bid: 4296.2, ask: 4296.8 }]), server(NOW - 800, [{ spreadProfile: 'prime', bid: 4276.2, ask: 4276.8 }])]
    expect(() => parseSwissquote(bad, NOW)).toThrow(/disagree/);
  });

  it('ignores one-sided or crossed quotes (a zero is absence, not a price)', () => {
    const p = parseSwissquote([server(NOW - 500, [{ bid: 0, ask: 4286.8 }, { bid: 4286.9, ask: 4286.1 }, { bid: 4286.2, ask: 4286.8 }])], NOW);
    expect(p.price).toBeCloseTo(4286.5, 3);
    expect(() => parseSwissquote([server(NOW, [{ bid: 0, ask: 1 }])], NOW)).toThrow(/no two-sided/);
    expect(() => parseSwissquote([], NOW)).toThrow(/empty/);
  });

  it('only fresh servers vote when some are stale', () => {
    const mixed = [server(NOW - 500, [{ bid: 4286.2, ask: 4286.8 }]), server(NOW - 3600_000, [{ bid: 4250.2, ask: 4250.8 }])];
    expect(parseSwissquote(mixed, NOW).price).toBeCloseTo(4286.5, 3);
  });

  it('a server clock ahead of ours never produces a future timestamp', () => {
    expect(parseSwissquote([server(NOW + 5000, [{ bid: 4286.2, ask: 4286.8 }])], NOW).publishTimeMs).toBe(NOW);
  });
});

describe('routing', () => {
  it('gold and silver route to Swissquote; nothing else does', () => {
    expect(hasSwissquoteFeed('XAU/USD')).toBe(true);
    expect(hasSwissquoteFeed('XAG/USD')).toBe(true);
    expect(hasSwissquoteFeed('BTC/USD')).toBe(false);
    expect(hasSwissquoteFeed('WTI/USD')).toBe(false);
  });
});
