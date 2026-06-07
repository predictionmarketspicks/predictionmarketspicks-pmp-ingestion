// PR 4 — pure compute logic for the WC mispricing engine.
// Network/DB-dependent paths (runWcMispricingsOnce) are exercised by the
// /dev/wc-mispricings handler post-deploy; this file locks the math + tier
// ladder + display precedence + alert key shape.

import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/engine/wc-mispricings.js';

const {
  selectDisplayPlatform,
  computeMispricing,
  computeAllMispricings,
  tierFor,
  prettyEntity,
  wcMispricingAlertKey,
} = __test__;

describe('tierFor', () => {
  it('STRONG at >= 8pp', () => {
    expect(tierFor(8.0)).toBe('STRONG');
    expect(tierFor(15.3)).toBe('STRONG');
  });
  it('MODERATE at >= 5pp and < 8pp', () => {
    expect(tierFor(5.0)).toBe('MODERATE');
    expect(tierFor(7.99)).toBe('MODERATE');
  });
  it('SPECULATIVE at >= 3pp and < 5pp', () => {
    expect(tierFor(3.0)).toBe('SPECULATIVE');
    expect(tierFor(4.9)).toBe('SPECULATIVE');
  });
  it('null below 3pp', () => {
    expect(tierFor(2.99)).toBeNull();
    expect(tierFor(0)).toBeNull();
    expect(tierFor(-Infinity)).toBeNull();
  });
});

describe('selectDisplayPlatform', () => {
  const fresh = { as_of_age_seconds: 60 };
  const stale = { as_of_age_seconds: 99999 };

  it('picks Kalshi when volume + age clear', () => {
    const rows = [
      { platform: 'kalshi', volume_24h: 5000, ...fresh },
      { platform: 'polymarket', volume_24h: 9000, ...fresh },
    ];
    expect(selectDisplayPlatform(rows).platform).toBe('kalshi');
  });

  it('falls through to Polymarket when Kalshi volume too low', () => {
    const rows = [
      { platform: 'kalshi', volume_24h: 50, ...fresh }, // below KALSHI_MIN_VOL=100
      { platform: 'polymarket', volume_24h: 9000, ...fresh },
    ];
    expect(selectDisplayPlatform(rows).platform).toBe('polymarket');
  });

  it('falls through to Polymarket when Kalshi is stale', () => {
    const rows = [
      { platform: 'kalshi', volume_24h: 5000, ...stale },
      { platform: 'polymarket', volume_24h: 9000, ...fresh },
    ];
    expect(selectDisplayPlatform(rows).platform).toBe('polymarket');
  });

  it('returns null when Polymarket volume too low (DraftKings fallback removed 2026-06-07)', () => {
    const rows = [
      { platform: 'polymarket', volume_24h: 100, ...fresh },
    ];
    expect(selectDisplayPlatform(rows)).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(selectDisplayPlatform([])).toBeNull();
    expect(selectDisplayPlatform(null)).toBeNull();
  });
});

describe('computeMispricing', () => {
  const sim = {
    entity_id: 'team:france',
    kind: 'champion',
    sim_run_id: 'wc-2026-test',
    sim_pct: 28.0,
    sim_ran_at: '2026-05-06T06:00:00Z',
  };

  it('STRONG when sim is 10pp higher than market', () => {
    const marketPick = {
      platform: 'kalshi',
      row: { yes_price_cents: 18, volume_24h: 12000, ticker_or_id: 'KXMENWORLDCUP-26-FRA', url: 'x', snapshot_at: 'now' },
    };
    const r = computeMispricing({ sim, marketPick });
    expect(r.tier).toBe('STRONG');
    expect(r.edge_pp).toBe(10.0);
    expect(r.display_platform).toBe('kalshi');
    expect(r.market_pct).toBe(18);
    expect(r.sim_pct).toBe(28.0);
  });

  it('MODERATE on a 6pp negative edge (market overpriced)', () => {
    const marketPick = {
      platform: 'polymarket',
      row: { yes_price_cents: 34, volume_24h: 5000, ticker_or_id: 'cond-1', url: 'x', snapshot_at: 'now' },
    };
    const r = computeMispricing({ sim, marketPick });
    expect(r.tier).toBe('MODERATE');
    expect(r.edge_pp).toBe(-6.0);
  });

  it('returns null when liquidity is below ALERT_MIN_VOL_24H even if tier qualifies', () => {
    const marketPick = {
      platform: 'kalshi',
      row: { yes_price_cents: 18, volume_24h: 50, ticker_or_id: 'x', url: 'x', snapshot_at: 'now' },
    };
    expect(computeMispricing({ sim, marketPick })).toBeNull();
  });

  it('returns null below the SPEC threshold', () => {
    const marketPick = {
      platform: 'kalshi',
      row: { yes_price_cents: 27, volume_24h: 12000, ticker_or_id: 'x', url: 'x', snapshot_at: 'now' },
    };
    expect(computeMispricing({ sim, marketPick })).toBeNull();
  });

  it('returns null on missing inputs', () => {
    expect(computeMispricing({ sim: null, marketPick: { row: {} } })).toBeNull();
    expect(computeMispricing({ sim, marketPick: null })).toBeNull();
  });

  it('preserves traceability metadata', () => {
    const marketPick = {
      platform: 'kalshi',
      row: { yes_price_cents: 18, volume_24h: 12000, ticker_or_id: 'KXMENWORLDCUP-26-FRA', url: 'https://kalshi.com/m/x', snapshot_at: '2026-05-06T07:30:00Z' },
    };
    const r = computeMispricing({ sim, marketPick });
    expect(r.metadata.sim_run_id).toBe('wc-2026-test');
    expect(r.metadata.market_ticker_or_id).toBe('KXMENWORLDCUP-26-FRA');
    expect(r.metadata.market_snapshot_at).toBe('2026-05-06T07:30:00Z');
  });
});

describe('computeAllMispricings', () => {
  it('joins on (entity_id, kind), picks display platform, drops unmatched + sub-tier rows', () => {
    const simRows = [
      { entity_id: 'team:france', kind: 'champion', sim_run_id: 'r1', sim_pct: 28.0, sim_ran_at: 't' },
      { entity_id: 'team:spain', kind: 'champion', sim_run_id: 'r1', sim_pct: 18.0, sim_ran_at: 't' },
      { entity_id: 'team:zzz', kind: 'champion', sim_run_id: 'r1', sim_pct: 10, sim_ran_at: 't' }, // no market row
    ];
    const marketRows = [
      // France: Kalshi underpriced 18 → STRONG +10
      { entity_id: 'team:france', kind: 'champion', platform: 'kalshi', yes_price_cents: 18, volume_24h: 12000, as_of_age_seconds: 60, ticker_or_id: 'KXMENWORLDCUP-26-FRA', url: 'x', snapshot_at: 't' },
      // Spain: Kalshi at 17, sim 18 → 1pp, sub-tier (filtered)
      { entity_id: 'team:spain', kind: 'champion', platform: 'kalshi', yes_price_cents: 17, volume_24h: 12000, as_of_age_seconds: 60, ticker_or_id: 'KXMENWORLDCUP-26-ESP', url: 'x', snapshot_at: 't' },
    ];
    const out = computeAllMispricings({ simRows, marketRows });
    expect(out.length).toBe(1);
    expect(out[0].entity_id).toBe('team:france');
    expect(out[0].tier).toBe('STRONG');
  });
});

describe('prettyEntity', () => {
  it('team slug → display name', () => {
    expect(prettyEntity('team:france')).toBe('France');
    expect(prettyEntity('team:united-states')).toBe('United States');
  });
  it('match id → "Home vs Away (MDn)"', () => {
    expect(prettyEntity('match:I-MD1-FRA-SEN')).toBe('France vs Senegal (MD1)');
  });
  it('player slug → titleized', () => {
    expect(prettyEntity('player:kylian-mbappe')).toBe('Kylian Mbappe');
  });
  it('falls through unrecognized teams to slug', () => {
    expect(prettyEntity('team:atlantis')).toBe('atlantis');
  });
  it('handles empty input', () => {
    expect(prettyEntity('')).toBe('');
    expect(prettyEntity(null)).toBe('');
  });
});

describe('wcMispricingAlertKey', () => {
  it('keys positive vs negative edges separately', () => {
    const pos = wcMispricingAlertKey({ entity_id: 'team:france', kind: 'champion', tier: 'STRONG', edge_pp: 10 });
    const neg = wcMispricingAlertKey({ entity_id: 'team:france', kind: 'champion', tier: 'STRONG', edge_pp: -10 });
    expect(pos).not.toBe(neg);
    expect(pos).toBe('wc_mispricing:team:france:champion:STRONG:positive');
    expect(neg).toBe('wc_mispricing:team:france:champion:STRONG:negative');
  });

  it('keys tier upgrades separately so MODERATE → STRONG re-alerts', () => {
    const a = wcMispricingAlertKey({ entity_id: 'team:france', kind: 'champion', tier: 'MODERATE', edge_pp: 6 });
    const b = wcMispricingAlertKey({ entity_id: 'team:france', kind: 'champion', tier: 'STRONG', edge_pp: 9 });
    expect(a).not.toBe(b);
  });
});
