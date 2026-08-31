// EDGE_MARKETS §2.4 — μ = 0 for gold/silver/oil, and WHY it is a config flag
// rather than a deletion.
//
// The 60-day trailing drift is a trend estimate. At the horizons this engine
// prices it carried no information and only DISPLACED the model CDF — the same
// finding bitcoin reached for its short-horizon momentum μ (BTC_MU_SCALE = 0).
//
// Backtested before flipping: 85 settled metals/oil events replayed at ~24h to
// close, paired and bootstrapped CLUSTERED BY EVENT (28 strikes share one
// event's spot/σ/μ, so resampling rows would have overstated certainty ~5x).
// Zeroing μ improved Brier, 95% CI entirely positive pooled and on oil alone.
import { describe, it, expect } from 'vitest';
import { COMMODITIES } from '../src/engine/commodities.js';

describe('§2.4 drift scale', () => {
  it('is zero for the three trailing-drift commodities', () => {
    for (const c of ['gold', 'silver', 'oil']) {
      expect(COMMODITIES[c].driftMuScale).toBe(0);
    }
  });

  it('is NOT set on bitcoin — its drift path is the short-horizon μ', () => {
    // Setting it here would look like a second lever on the same term and
    // invite someone to "re-enable" one of them in isolation. Bitcoin's μ is
    // already zeroed at BTC_MU_SCALE in thresholds.js.
    expect(COMMODITIES.bitcoin.driftMuScale).toBeUndefined();
  });

  it('defaults to 1 where unset, so no other commodity changes', () => {
    for (const c of Object.keys(COMMODITIES)) {
      if (['gold', 'silver', 'oil'].includes(c)) continue;
      expect(COMMODITIES[c].driftMuScale ?? 1).toBe(1);
    }
  });

  it('the engine reads it as a SCALE, not a boolean', () => {
    // A scale keeps the re-enable path open at any fraction and makes the
    //zero-case arithmetic (mu * 0) obvious at the call site.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../src/engine/commodity-base.js'), 'utf8');
    expect(/config\.driftMuScale \?\? 1/.test(src)).toBe(true);
    expect(/muUsed \* muScale/.test(src)).toBe(true);
  });
});
