// Bitcoin TWAP settlement-window guard + oil USO-synthetic rollback locks.
// Anchors the 2026-05-22 fix (handoff: COMMODITY_EDGE_OIL_BITCOIN_FIX_2026-05-22.md).
//
// Two pieces of config are load-bearing:
//   1. commodities.bitcoin.minMinutesToClose === 15 — drives the
//      twap_settle_window guard in commodity-base.js computeSnapshot.
//      Started at 5min, widened to 15min same session after a live
//      t-7.4min KXBTCD-26MAY2216 reading where the engine wanted to fade
//      an uptrend with BUY NO STRONG -92pp at $75,900 (Kalshi correctly
//      pricing YES at 94c). Sub-hour BS prob can't represent BTC's real
//      realized vol — this is a band-aid until a TWAP-aware probability
//      model lands.
//   2. commodities.oil.useUsoSynthetic === false — rolls back the
//      synthetic spot path that shipped earlier the same day.
//      Databento's parity-derived USO underlyingPrice has been ~$142
//      vs real ~$77 for days; the new path treated that as truth and
//      produced WTI spot of ~$111.62 vs Kalshi-implied $98.
//
// Full computeSnapshot integration tests for the guard are deferred —
// they need heavy mocking of chain/event/spot. Config-level tests lock
// in the patch and prevent silent re-enablement.

import { describe, it, expect } from 'vitest';
import { COMMODITIES } from '../src/engine/commodities.js';

describe('Bitcoin TWAP settlement-window guard config', () => {
  it('bitcoin.minMinutesToClose === 15', () => {
    // Widened from 5 → 15 same session after a live t-7.4min signal that
    // the 5-min guard would have let through. The proper fix is a TWAP-
    // aware probability model (simulate the avg-outcome distribution, not
    // the point-in-time outcome); this guard is the conservative band-aid.
    expect(COMMODITIES.bitcoin.minMinutesToClose).toBe(15);
  });

  it('silver / gold / oil / spx / copper leave minMinutesToClose unset', () => {
    // Daily-settle commodities — point-in-time prob is valid all the way
    // to close because there's no TWAP averaging window absorbing moves.
    expect(COMMODITIES.silver.minMinutesToClose ?? null).toBe(null);
    expect(COMMODITIES.gold.minMinutesToClose ?? null).toBe(null);
    expect(COMMODITIES.oil.minMinutesToClose ?? null).toBe(null);
    expect(COMMODITIES.spx.minMinutesToClose ?? null).toBe(null);
    expect(COMMODITIES.copper.minMinutesToClose ?? null).toBe(null);
  });
});

describe('Oil USO-synthetic rollback config', () => {
  it('oil.useUsoSynthetic === false', () => {
    // Re-enabling requires fixing deriveEtfSpotByParity in feeds/databento.js
    // first (currently returns ~$142 USO vs real ~$77). Do not flip back
    // without verifying the underlying USO number matches reality.
    expect(COMMODITIES.oil.useUsoSynthetic).toBe(false);
  });

  it('oil.useYahooSpot === true (fallback ladder remains active)', () => {
    // With useUsoSynthetic off, the engine drops through to the Yahoo
    // path — contract-aware CLM26.NYM primary, CL=F continuous fallback.
    expect(COMMODITIES.oil.useYahooSpot).toBe(true);
  });

  it('oil.spotLabel reflects the active Yahoo path, not the disabled synthetic', () => {
    expect(COMMODITIES.oil.spotLabel).toMatch(/yahoo/i);
    expect(COMMODITIES.oil.spotLabel).not.toMatch(/uso-synthetic/i);
  });
});

describe('Guard block presence in commodity-base.js (smoke)', () => {
  // Cheap source-level guard: re-introducing the bug by removing the
  // minMinutesToClose branch would silently re-enable late-window
  // signals. This test fails loud if the literal guard is gone.
  it('commodity-base.js still references config.minMinutesToClose', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = url.fileURLToPath(import.meta.url);
    const src = fs.readFileSync(
      path.resolve(path.dirname(here), '..', 'src', 'engine', 'commodity-base.js'),
      'utf8',
    );
    expect(src).toMatch(/config\.minMinutesToClose/);
    expect(src).toMatch(/twap_settle_window/);
  });
});
