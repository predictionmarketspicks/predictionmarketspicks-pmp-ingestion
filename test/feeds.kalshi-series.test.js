// Oil settle-contract resolution (2026-09-30). Kalshi emptied the series
// important_info markdown, so the contract month now comes from the market's own
// rules_primary. Fixture text is a live KXWTI market's rules_primary, 2026-09-30.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getActiveSettleContract, __test__ } from '../src/feeds/kalshi-series.js';

const { contractFromRules } = __test__;
const LIVE_RULES =
  'If the daily settlement price for WTI crude oil(November 2026 contract) on October 01, 2026 is above 95.99 USD/Bbl, then the market resolves to Yes.';

describe('contractFromRules', () => {
  it('reads the settle month from a live KXWTI rules_primary', () => {
    expect(contractFromRules(LIVE_RULES)).toBe('NOV26');
  });
  it('handles any month and case', () => {
    expect(contractFromRules('WTI crude oil (december 2026 contract)')).toBe('DEC26');
    expect(contractFromRules('(January 2027 contract)')).toBe('JAN27');
  });
  it('returns null when no contract month is named', () => {
    expect(contractFromRules('Settlement is based on the nearest listed contract month')).toBeNull();
    expect(contractFromRules(null)).toBeNull();
    expect(contractFromRules(undefined)).toBeNull();
  });
});

describe('getActiveSettleContract with rules text', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the rules month and makes no network call', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(getActiveSettleContract('KXWTI', Date.now(), LIVE_RULES)).resolves.toEqual({
      contract: 'NOV26',
      yyyymm: '202611',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls through to the series metadata when the rules name no month', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ series: { settlement_sources: [{ name: 'ICE' }], product_metadata: { scope: 'x' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getActiveSettleContract('KXWTI', Date.now(), 'no month here')).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
  });
});
