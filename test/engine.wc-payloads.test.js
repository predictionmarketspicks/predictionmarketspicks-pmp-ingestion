// PR 5 — pure builders for the WC widget_payloads writer.
// runWcPayloadsOnce() is exercised by the /dev/wc-payloads handler
// post-deploy; this file locks the envelope shape and ordering rules.

import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/engine/wc-payloads.js';

const {
  buildWorldCup2026Envelope,
  buildWcMispricingsEnvelope,
  entityLabel,
  kindLabel,
  pickChampionRow,
} = __test__;

describe('pickChampionRow', () => {
  it('prefers Kalshi when Kalshi has volume', () => {
    const rows = [
      { platform: 'kalshi', volume_24h: 100 },
      { platform: 'polymarket', volume_24h: 9999 },
      { platform: 'draftkings' },
    ];
    expect(pickChampionRow(rows).platform).toBe('kalshi');
  });

  it('falls through to Polymarket when Kalshi has no volume', () => {
    const rows = [
      { platform: 'kalshi', volume_24h: 0 },
      { platform: 'polymarket', volume_24h: 5000 },
    ];
    expect(pickChampionRow(rows).platform).toBe('polymarket');
  });

  it('ignores DraftKings and keeps the Kalshi skeleton row when Kalshi + Poly have no volume', () => {
    const rows = [
      { platform: 'kalshi', volume_24h: 0 },
      { platform: 'polymarket', volume_24h: 0 },
      { platform: 'draftkings' },
    ];
    // DraftKings outrights were dropped from the WC writer (2026-05-28); the
    // zero-volume Kalshi skeleton row wins so the team still shows pre-volume.
    expect(pickChampionRow(rows).platform).toBe('kalshi');
  });

  it('returns the lone platform row even with zero volume', () => {
    const rows = [{ platform: 'kalshi', volume_24h: 0 }];
    expect(pickChampionRow(rows).platform).toBe('kalshi');
  });

  it('returns null for empty input', () => {
    expect(pickChampionRow([])).toBeNull();
    expect(pickChampionRow(null)).toBeNull();
  });
});

describe('buildWorldCup2026Envelope', () => {
  const simRows = [
    { entity_id: 'team:france', kind: 'champion', sim_pct: 15.2, sim_ran_at: '2026-04-15T00:00:00Z' },
    { entity_id: 'team:spain', kind: 'champion', sim_pct: 18.6, sim_ran_at: '2026-04-15T00:00:00Z' },
    { entity_id: 'team:england', kind: 'champion', sim_pct: 12.8, sim_ran_at: '2026-04-15T00:00:00Z' },
    // non-champion sim rows must be ignored
    { entity_id: 'team:france', kind: 'reach_qf', sim_pct: 56.5 },
    // non-team entity must be ignored
    { entity_id: 'match:I-MD1-FRA-SEN', kind: 'champion', sim_pct: 0 },
  ];

  it('emits one team row per champion-sim entity, sorted by probability desc', () => {
    const env = buildWorldCup2026Envelope({ simRows, marketRows: [] });
    expect(env.data.teams).toHaveLength(3);
    expect(env.data.teams[0].outcome).toBe('Spain');
    expect(env.data.teams[1].outcome).toBe('France');
    expect(env.data.teams[2].outcome).toBe('England');
    expect(env.data.topTeam.outcome).toBe('Spain');
  });

  it('uses market price when available and sim probability when absent', () => {
    const marketRows = [
      {
        entity_id: 'team:france',
        kind: 'champion',
        platform: 'kalshi',
        ticker_or_id: 'KXMENWORLDCUP-26-FRA',
        yes_price_cents: 18,
        volume_24h: 5000,
        url: 'https://kalshi.com/x',
        snapshot_at: '2026-05-06T00:00:00Z',
      },
    ];
    const env = buildWorldCup2026Envelope({ simRows, marketRows });
    const france = env.data.teams.find((t) => t.outcome === 'France');
    expect(france.source).toBe('kalshi');
    expect(france.probability).toBeCloseTo(0.18);
    expect(france.url).toBe('https://kalshi.com/x');

    const spain = env.data.teams.find((t) => t.outcome === 'Spain');
    expect(spain.source).toBe('sim'); // no market row
    expect(spain.probability).toBeCloseTo(0.186);
  });

  it('emits per-platform _raw rows so getWCPredictionMarketOdds can dedup', () => {
    const marketRows = [
      { entity_id: 'team:france', kind: 'champion', platform: 'kalshi', yes_price_cents: 18, volume_24h: 5000, snapshot_at: '2026-05-06T00:00:00Z', url: null },
      { entity_id: 'team:france', kind: 'champion', platform: 'polymarket', yes_price_cents: 19, volume_24h: 12000, snapshot_at: '2026-05-06T00:00:00Z', url: null },
    ];
    const env = buildWorldCup2026Envelope({ simRows, marketRows });
    const franceRaw = env.data._raw.filter((r) => r.outcome === 'France');
    expect(franceRaw).toHaveLength(2);
    expect(franceRaw.map((r) => r.source).sort()).toEqual(['kalshi', 'polymarket']);
  });

  it('caps the teams list at 10 even with more entities', () => {
    const big = Array.from({ length: 15 }, (_, i) => ({
      entity_id: `team:team-${i}`,
      kind: 'champion',
      sim_pct: 10 - i * 0.1,
    }));
    const env = buildWorldCup2026Envelope({ simRows: big, marketRows: [] });
    expect(env.data.teams).toHaveLength(10);
  });

  it('marks envelope stale when no teams', () => {
    const env = buildWorldCup2026Envelope({ simRows: [], marketRows: [] });
    expect(env.stale).toBe(true);
    expect(env.data.teams).toHaveLength(0);
    expect(env.data.topTeam).toBeNull();
  });
});

describe('entityLabel', () => {
  it('formats team:slug', () => {
    expect(entityLabel('team:france')).toBe('France');
    expect(entityLabel('team:united-states')).toBe('United States');
  });

  it('formats match:G-MDn-HHH-AAA', () => {
    expect(entityLabel('match:I-MD1-FRA-SEN')).toBe('France vs Senegal (MD1)');
  });

  it('formats player:slug', () => {
    expect(entityLabel('player:kylian-mbappe')).toBe('Kylian Mbappe');
  });

  it('passes unrecognized strings through', () => {
    expect(entityLabel('weird:thing')).toBe('weird:thing');
    expect(entityLabel('')).toBe('');
  });
});

describe('kindLabel', () => {
  it('maps known kinds to human labels', () => {
    expect(kindLabel('champion')).toBe('Champion');
    expect(kindLabel('match_o25')).toBe('Over 2.5 Goals');
    expect(kindLabel('reach_qf')).toBe('Reach Quarter-Final');
  });

  it('passes unknown kinds through', () => {
    expect(kindLabel('made_up_kind')).toBe('made_up_kind');
  });
});

describe('buildWcMispricingsEnvelope', () => {
  const rows = [
    {
      entity_id: 'team:france',
      kind: 'champion',
      display_platform: 'kalshi',
      sim_pct: 15.2,
      market_pct: 5.0,
      edge_pp: 10.2,
      tier: 'STRONG',
      market_volume_24h: 12500,
      computed_at: '2026-05-06T01:00:00Z',
    },
    {
      entity_id: 'match:I-MD1-FRA-SEN',
      kind: 'match_winner_home',
      display_platform: 'polymarket',
      sim_pct: 54.8,
      market_pct: 45.0,
      edge_pp: 9.8,
      tier: 'STRONG',
      market_volume_24h: 8000,
      computed_at: '2026-05-06T01:00:00Z',
    },
  ];

  it('builds one card per row with pretty labels', () => {
    const env = buildWcMispricingsEnvelope({ rows });
    expect(env.data.cards).toHaveLength(2);

    const fra = env.data.cards[0];
    expect(fra.entity_label).toBe('France');
    expect(fra.kind_label).toBe('Champion');
    expect(fra.display_platform).toBe('kalshi');
    expect(fra.edge_pp).toBe(10.2);

    const m = env.data.cards[1];
    expect(m.entity_label).toBe('France vs Senegal (MD1)');
    expect(m.kind_label).toBe('Match Winner (Home)');
  });

  it('marks envelope stale when no rows', () => {
    const env = buildWcMispricingsEnvelope({ rows: [] });
    expect(env.stale).toBe(true);
    expect(env.data.cards).toHaveLength(0);
    expect(env.data.strong_count).toBe(0);
  });

  it('preserves null market_volume_24h', () => {
    const env = buildWcMispricingsEnvelope({
      rows: [{ ...rows[0], market_volume_24h: null }],
    });
    expect(env.data.cards[0].market_volume_24h).toBeNull();
  });
});
