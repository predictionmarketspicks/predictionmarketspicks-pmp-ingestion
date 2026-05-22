// Bitcoin TWAP settlement-window guard + oil USO-synthetic rollback locks.
// Anchors the 2026-05-22 fix (handoff: COMMODITY_EDGE_OIL_BITCOIN_FIX_2026-05-22.md).
//
// Two pieces of config are load-bearing:
//   1. commodities.bitcoin.minMinutesToClose === 5 — drives the
//      twap_settle_window guard in commodity-base.js computeSnapshot.
//      Without it, every actionable signal still fires in the final
//      ~60s before the KXBTCD hourly TWAP settle, when the point-in-time
//      BS prob collapses to 0/1 against $200-500 real-world BTC moves.
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
  it('bitcoin.minMinutesToClose === 5', () => {
    expect(COMMODITIES.bitcoin.minMinutesToClose).toBe(5);
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
