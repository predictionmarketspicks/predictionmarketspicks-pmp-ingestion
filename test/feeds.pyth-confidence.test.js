import { describe, it, expect } from 'vitest';
import { isConfidenceUsable } from '../src/feeds/pyth.js';

/**
 * Pyth publishes a confidence interval with every price and we were ignoring it.
 *
 * Measured on Pythnet 2026-09-10 (60 polls/symbol): WTI's front-month feed
 * alternates a tight print (~102.5, conf ~0.04) with a wide one (~97.5, conf
 * ~5.05) every few seconds — 27% of prints, a 5% price swing, confidence ~125x
 * wider. Gold, silver and bitcoin never exceeded 0.31%. Ingesting the wide ones
 * produced an annualized sigma of 110 against a 5.0 ceiling; excluding them
 * takes the same window to 2.16.
 */
describe('Pyth confidence gate', () => {
  it('accepts the real WTI print and rejects its wide twin', () => {
    expect(isConfidenceUsable(102.59923, 0.02077)).toBe(true);
    expect(isConfidenceUsable(97.55763, 5.06237)).toBe(false);
  });

  it('accepts every legitimate print observed across all four feeds', () => {
    // Worst real conf/price seen per symbol, 2026-09-10.
    expect(isConfidenceUsable(4327.7, 4327.7 * 0.00156)).toBe(true);  // gold  0.156%
    expect(isConfidenceUsable(30.0, 30.0 * 0.00303)).toBe(true);      // silver 0.303%
    expect(isConfidenceUsable(60000, 60000 * 0.00038)).toBe(true);    // btc   0.038%
    expect(isConfidenceUsable(102.6, 102.6 * 0.00094)).toBe(true);    // wti   0.094%
  });

  it('has real headroom either side — not a knife edge', () => {
    // ~3x above the worst legitimate print, ~5x below the bad ones.
    expect(isConfidenceUsable(100, 0.9)).toBe(true);   // 0.9%  — still fine
    expect(isConfidenceUsable(100, 1.1)).toBe(false);  // 1.1%  — rejected
  });

  it('⛔ a MISSING confidence is not a wide one', () => {
    // Refusing these would blind the feed rather than clean it — older parses
    // may omit the field entirely.
    expect(isConfidenceUsable(100, null)).toBe(true);
    expect(isConfidenceUsable(100, undefined)).toBe(true);
    expect(isConfidenceUsable(100, NaN)).toBe(true);
  });

  it('rejects a non-price outright', () => {
    expect(isConfidenceUsable(0, 0.01)).toBe(false);
    expect(isConfidenceUsable(-1, 0.01)).toBe(false);
  });
});
