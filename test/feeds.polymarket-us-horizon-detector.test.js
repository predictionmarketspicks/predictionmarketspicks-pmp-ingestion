// W3-lite (POLYMARKET_REFERRAL_CODE_AND_POLY_US_REAL_ESTATE_2026-10-29): a new up/down horizon in the census is reported; known ones never are.
import { describe, it, expect } from 'vitest';
import { newHorizons, KNOWN_HORIZONS } from '../src/feeds/polymarket-us-horizon-detector.js';

describe('newHorizons', () => {
  it('ignores the horizons already listed (census 2026-10-30)', () => {
    const slugs = ['btc-updown-5m-2026-10-30-0115z', 'eth-updown-15m-2026-10-30-0115z', 'gold-updown-1h-2026-10-30-0100z', 'xrp-updown-1d-2026-10-30-0000z', 'usfed-fomc-2026-12-09', null];
    expect(newHorizons(slugs)).toEqual({});
    expect([...KNOWN_HORIZONS].sort()).toEqual(['15m', '1d', '1h', '5m']);
  });
  it('reports 30m and 4h windows, whatever their start alignment', () => {
    const found = newHorizons(['btc-updown-30m-2026-11-03-1430z', 'btc-updown-4h-2026-11-03-1200z', 'btc-updown-4h-2026-11-03-1600z']);
    expect(Object.keys(found).sort()).toEqual(['30m', '4h']);
    expect(found['4h']).toHaveLength(2);
  });
});
