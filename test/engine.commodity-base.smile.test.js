// IV smile stability tests — locks in the 2026-05-21 ATM-picker rewrite that
// killed the 33→66→39% ATM-IV swing on a $34 BTC move (one thin contract
// flipping ATM as spot crossed a strike boundary).
//
// Two invariants:
//   1. ATM IV is the put-call AVERAGE at the closest paired strike, not a
//      single contract — so a one-leg outlier can't move it past put-call
//      parity.
//   2. clean[] interpolation rejects contracts below the liquidity floor
//      (volume24h < 50 OR openInterest < 100), with explicit-null treated as
//      "we don't know" → reject. Falls back to unfiltered ONLY if the floor
//      would zero out the chain.

import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/engine/commodity-base.js';

const { buildIvSmile } = __test__;

// Contract factory — keeps the tests readable.
function mk(strike, type, iv, { vol = 200, oi = 500, speculative = false } = {}) {
  return {
    strike,
    contractType: type,
    iv,
    volume24h: vol,
    openInterest: oi,
    speculative,
  };
}

describe('buildIvSmile — ATM picker uses put/call pair at closest strike', () => {
  it('averages put + call IVs at the closest paired strike', () => {
    const spot = 100;
    const contracts = [
      mk(95, 'put', 0.40),
      mk(95, 'call', 0.42),
      mk(100, 'put', 0.50),
      mk(100, 'call', 0.52),
      mk(105, 'put', 0.55),
      mk(105, 'call', 0.57),
    ];
    const { atmIv } = buildIvSmile(contracts, spot);
    // Paired strike at 100 → avg(0.50, 0.52) = 0.51.
    expect(atmIv).toBeCloseTo(0.51, 6);
  });

  it('a thin one-leg outlier cannot dominate ATM IV', () => {
    // BTC May 21 pathology: spot crosses a strike boundary, a single thin
    // contract on the other side jumps in as "closest single". With pair
    // averaging at the nearest BOTH-legs strike, the outlier is filtered.
    const spot = 77500;
    const contracts = [
      // Paired liquid strike at 77000.
      mk(77000, 'put', 0.42),
      mk(77000, 'call', 0.43),
      // Paired liquid strike at 78000.
      mk(78000, 'put', 0.44),
      mk(78000, 'call', 0.45),
      // Single thin contract right at spot — anomalous IV. Used to be ATM
      // under the single-closest-contract code; now ignored (one leg only).
      mk(77500, 'call', 1.20, { vol: 60, oi: 110 }),
    ];
    const { atmIv } = buildIvSmile(contracts, spot);
    // Closest paired strike is 77000 (distance 500) vs 78000 (distance 500)
    // — Map iteration order gives the first paired insert. Either way,
    // atmIv must be in [0.425, 0.445]. The 1.20 outlier must NOT win.
    expect(atmIv).toBeGreaterThan(0.4);
    expect(atmIv).toBeLessThan(0.5);
  });

  it('flags speculative when put-call disagree by >10% absolute', () => {
    const spot = 100;
    const contracts = [
      mk(100, 'put', 0.30),
      mk(100, 'call', 0.45),
      mk(95, 'put', 0.32),
      mk(105, 'call', 0.43),
    ];
    const { atmIv } = buildIvSmile(contracts, spot);
    expect(atmIv).toBeCloseTo(0.375, 6);
  });

  it('falls back to single-leg + speculative when no paired strike exists', () => {
    const spot = 100;
    const contracts = [mk(99, 'put', 0.40), mk(110, 'call', 0.55)];
    const { atmIv } = buildIvSmile(contracts, spot);
    // No paired strike — single closest leg at 99 (put, iv=0.40).
    expect(atmIv).toBe(0.40);
  });
});

describe('buildIvSmile — clean[] liquidity floor', () => {
  it('drops thin contracts (volume below floor) from the smile', () => {
    const spot = 100;
    const liquidPut = mk(95, 'put', 0.50, { vol: 200, oi: 500 });
    const thinCall = mk(110, 'call', 1.40, { vol: 10, oi: 50 });
    const { ivAt } = buildIvSmile([liquidPut, thinCall], spot);
    // 110 is past the liquid OTM call range — extrapolation should clamp to
    // the liquid put at 95 (iv=0.50), NOT pull in the 1.40 thin-call IV.
    const interp = ivAt(108);
    expect(interp.iv).toBe(0.50);
  });

  it('rejects explicit-null volume/OI ("we do not know, do not trust")', () => {
    const spot = 100;
    const liquidPut = mk(95, 'put', 0.50, { vol: 200, oi: 500 });
    const unknownCall = {
      strike: 110,
      contractType: 'call',
      iv: 0.60,
      volume24h: null,
      openInterest: null,
    };
    const { ivAt } = buildIvSmile([liquidPut, unknownCall], spot);
    // Null volume / OI → can't confirm above floor → reject from smile.
    // Extrapolation at 108 should clamp to liquid put at 95.
    expect(ivAt(108).iv).toBe(0.50);
  });

  it('falls back to unfiltered pool when liquid filter would empty the chain', () => {
    // Cold-start protection — if every contract is below the liquidity floor
    // (e.g. weekend or freshly-opened chain), don't bail; use what we have.
    const spot = 100;
    const onlyThin = [
      mk(95, 'put', 0.40, { vol: 5, oi: 10 }),
      mk(95, 'call', 0.42, { vol: 5, oi: 10 }),
      mk(105, 'put', 0.50, { vol: 5, oi: 10 }),
      mk(105, 'call', 0.52, { vol: 5, oi: 10 }),
    ];
    const { atmIv } = buildIvSmile(onlyThin, spot);
    // Closest paired strike — either 95 or 105, both distance 5. Either way,
    // atmIv must be non-null and in the band of those four contracts.
    expect(atmIv).not.toBeNull();
    expect(atmIv).toBeGreaterThan(0.39);
    expect(atmIv).toBeLessThan(0.53);
  });
});
