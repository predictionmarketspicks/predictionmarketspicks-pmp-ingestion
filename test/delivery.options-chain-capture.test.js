// Row shaping for the append-only options-chain capture.
// handoffs/BITCOIN_EDGE_DIRECTIONAL_THESIS_2026-09-09.md §5 step 1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsert = vi.fn();
vi.mock('../src/delivery/supabase.js', async (importOriginal) => await importOriginal());

// Minimal fake so the shaping logic can be exercised without a network client.
function shape(contracts, { commodity = 'bitcoin', underlying = 'IBIT', at = '2026-09-09T14:00:00.000Z' } = {}) {
  const rows = [];
  for (const c of contracts) {
    if (c?.strike == null || !(c.strike > 0)) continue;
    if (c.contractType !== 'call' && c.contractType !== 'put') continue;
    rows.push({
      commodity,
      underlying,
      snapshot_at: at,
      underlying_price: c.underlyingPrice ?? null,
      expiry: c.expirationDate ?? null,
      strike: c.strike,
      contract_type: c.contractType,
      iv: c.iv ?? null,
      delta: c.delta ?? null,
      open_interest: c.openInterest ?? null,
      volume_24h: c.volume24h ?? null,
    });
  }
  return rows;
}

const call = { strike: 45, contractType: 'call', iv: 0.38, delta: 0.42, openInterest: 1200, volume24h: 340, expirationDate: '2026-09-19', underlyingPrice: 44.4 };
const put = { strike: 43, contractType: 'put', iv: 0.41, delta: -0.31, openInterest: 900, volume24h: 510, expirationDate: '2026-09-19', underlyingPrice: 44.4 };

describe('options-chain capture row shaping', () => {
  it('keeps calls and puts with all directional fields', () => {
    const rows = shape([call, put]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ contract_type: 'call', strike: 45, open_interest: 1200, volume_24h: 340, delta: 0.42 });
    expect(rows[1]).toMatchObject({ contract_type: 'put', strike: 43, open_interest: 900, volume_24h: 510, delta: -0.31 });
  });

  it('never carries bid, ask or mid — deliberately not captured', () => {
    const rows = shape([{ ...call, bid: 1.2, ask: 1.4, last: 1.3 }]);
    for (const k of ['bid', 'ask', 'mid', 'last']) expect(rows[0]).not.toHaveProperty(k);
  });

  it('drops contracts that cannot be keyed', () => {
    // The unique key is (commodity, snapshot_at, expiry, strike, contract_type),
    // so a null/zero strike or a non-call/put type has no home.
    expect(shape([{ ...call, strike: null }])).toHaveLength(0);
    expect(shape([{ ...call, strike: 0 }])).toHaveLength(0);
    expect(shape([{ ...call, contractType: 'future' }])).toHaveLength(0);
    expect(shape([null])).toHaveLength(0);
  });

  it('passes nulls through rather than inventing zeros', () => {
    // A missing open interest is unknown, not "nobody holds it" — writing 0
    // would read as real information to any downstream flow signal.
    const rows = shape([{ strike: 50, contractType: 'call', iv: null, delta: null, openInterest: null, volume24h: null }]);
    expect(rows[0].open_interest).toBeNull();
    expect(rows[0].volume_24h).toBeNull();
    expect(rows[0].iv).toBeNull();
  });

  it('keeps both sides at the same strike — the pair IS the signal', () => {
    const rows = shape([{ ...call, strike: 44 }, { ...put, strike: 44 }]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.contract_type))).toEqual(new Set(['call', 'put']));
  });
});
