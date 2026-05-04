// Macro fetcher helper tests — verifies the cents/int/null coercion that goes
// into macro_market_snapshots. The integration with Kalshi REST is exercised
// by the engine's runMacroSnapshotOnce() at /dev/macro; here we just lock the
// shape so a future "let's switch to Number()" refactor doesn't silently break
// the upsert (which has typed columns and would reject coerced strings).

import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/feeds/kalshi-macro.js';

const { toCentsOrNull, toNumOrNull, toIntOrNull } = __test__;

describe('toCentsOrNull', () => {
  it('returns null for null/undefined (column is nullable — preserve "no quote")', () => {
    expect(toCentsOrNull(null)).toBeNull();
    expect(toCentsOrNull(undefined)).toBeNull();
  });

  it('preserves null distinct from 0', () => {
    expect(toCentsOrNull(0)).toBe(0);
    expect(toCentsOrNull('0')).toBe(0);
    expect(toCentsOrNull(null)).toBeNull();
  });

  it('converts dollar fractions to cents', () => {
    expect(toCentsOrNull(0.45)).toBe(45);
    expect(toCentsOrNull('0.45')).toBe(45);
    expect(toCentsOrNull(1)).toBe(100);
  });

  it('passes through values already in cents (>1)', () => {
    expect(toCentsOrNull(45)).toBe(45);
    expect(toCentsOrNull('45')).toBe(45);
  });

  it('returns null on garbage input', () => {
    expect(toCentsOrNull('abc')).toBeNull();
    expect(toCentsOrNull(NaN)).toBeNull();
  });
});

describe('toNumOrNull', () => {
  it('returns null for null/undefined', () => {
    expect(toNumOrNull(null)).toBeNull();
    expect(toNumOrNull(undefined)).toBeNull();
  });

  it('preserves numeric values incl 0', () => {
    expect(toNumOrNull(0)).toBe(0);
    expect(toNumOrNull(3.14)).toBe(3.14);
    expect(toNumOrNull('3.14')).toBe(3.14);
  });

  it('returns null on garbage', () => {
    expect(toNumOrNull('abc')).toBeNull();
  });
});

describe('toIntOrNull', () => {
  it('rounds to integer (open_interest column is INTEGER)', () => {
    // supabase-js silently drops rows where a numeric value can't fit the
    // declared column type — same incident as tweet_log.market_volume from
    // the Apr 23 retro. Round at the source so volume + OI stay safe.
    expect(toIntOrNull(123.7)).toBe(124);
    expect(toIntOrNull('123.7')).toBe(124);
    expect(toIntOrNull(0)).toBe(0);
  });

  it('returns null for null/undefined/NaN', () => {
    expect(toIntOrNull(null)).toBeNull();
    expect(toIntOrNull(undefined)).toBeNull();
    expect(toIntOrNull('abc')).toBeNull();
  });
});
