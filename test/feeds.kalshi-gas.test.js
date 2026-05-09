// Kalshi gas fetcher helper tests — locks the resolution-date parsing and
// cents coercion that go into kalshi_gas_strikes. The integration with
// Kalshi REST is exercised by the engine's runGasSnapshotOnce() at /dev/gas
// post-deploy; here we only unit-test the pure helpers.

import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/feeds/kalshi-gas.js';

const { parseResolutionDate, toCentsOrNull } = __test__;

describe('parseResolutionDate (KXAAAGASD daily)', () => {
  it('parses uppercase event ticker', () => {
    expect(parseResolutionDate('KXAAAGASD-26MAY09')).toBe('2026-05-09');
  });

  it('parses lowercase event ticker (handcrafted in tests)', () => {
    expect(parseResolutionDate('kxaaagasd-26may09')).toBe('2026-05-09');
  });

  it('parses full market ticker (with -T<strike> suffix)', () => {
    expect(parseResolutionDate('KXAAAGASD-26MAY09-T4.535')).toBe('2026-05-09');
  });

  it('handles all months', () => {
    expect(parseResolutionDate('KXAAAGASD-26JAN15')).toBe('2026-01-15');
    expect(parseResolutionDate('KXAAAGASD-26AUG31')).toBe('2026-08-31');
    expect(parseResolutionDate('KXAAAGASD-27DEC01')).toBe('2027-12-01');
  });
});

describe('parseResolutionDate (KXAAAGASM monthly)', () => {
  it('resolves to the last day of the month', () => {
    expect(parseResolutionDate('KXAAAGASM-26MAY')).toBe('2026-05-31');
    expect(parseResolutionDate('KXAAAGASM-26FEB')).toBe('2026-02-28'); // not a leap year
    expect(parseResolutionDate('KXAAAGASM-28FEB')).toBe('2028-02-29'); // leap year
    expect(parseResolutionDate('KXAAAGASM-26APR')).toBe('2026-04-30');
  });

  it('parses full market ticker with strike', () => {
    expect(parseResolutionDate('KXAAAGASM-26AUG-T5.30')).toBe('2026-08-31');
  });
});

describe('parseResolutionDate (rejection)', () => {
  it('returns null for unrecognized series', () => {
    expect(parseResolutionDate('KXSILVERW-26MAY09')).toBeNull();
    expect(parseResolutionDate('KXFED-25DEC')).toBeNull();
  });

  it('returns null for malformed dates', () => {
    expect(parseResolutionDate('KXAAAGASD-26ZZZ09')).toBeNull();
    expect(parseResolutionDate('KXAAAGASD-')).toBeNull();
    expect(parseResolutionDate('')).toBeNull();
    expect(parseResolutionDate(null)).toBeNull();
    expect(parseResolutionDate(undefined)).toBeNull();
  });
});

describe('toCentsOrNull', () => {
  it('preserves null distinct from 0 (column is nullable — "no quote" stays NULL)', () => {
    expect(toCentsOrNull(null)).toBeNull();
    expect(toCentsOrNull(undefined)).toBeNull();
    expect(toCentsOrNull(0)).toBe(0);
    expect(toCentsOrNull('0')).toBe(0);
  });

  it('converts dollar fractions to cents', () => {
    expect(toCentsOrNull(0.82)).toBe(82);
    expect(toCentsOrNull('0.82')).toBe(82);
    expect(toCentsOrNull(1)).toBe(100);
  });

  it('passes through values already in cents (>1)', () => {
    expect(toCentsOrNull(82)).toBe(82);
    expect(toCentsOrNull('82')).toBe(82);
    expect(toCentsOrNull(100)).toBe(100);
  });

  it('returns null on garbage input', () => {
    expect(toCentsOrNull('abc')).toBeNull();
    expect(toCentsOrNull(NaN)).toBeNull();
  });
});
