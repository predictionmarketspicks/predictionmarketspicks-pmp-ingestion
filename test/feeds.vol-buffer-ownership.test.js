// Exactly ONE feed may write the bitcoin short-horizon vol buffer.
//
// WHY THIS IS A TEST AND NOT A COMMENT. short-horizon-vol.js holds 600 slots sized
// for a 10s cadence and its sigma constants were fit on that cadence;
// MIN_TICK_INTERVAL_MS is 800ms, so it does NOT deduplicate two 10s writers. Both
// brti-spot.js and cfbenchmarks.js record every ~10s, so with CF armed the
// effective cadence becomes ~5s and the 15-minute lookback silently becomes ~7.5
// minutes. That is the same sigma-regime corruption the CF-side throttle was
// written to prevent, reached through the other door — and it would show up only as
// slightly-wrong fair values, never as an error.
import { describe, it, expect, vi, beforeEach } from 'vitest';

let cfArmed = false;
let cfValue = null;
const recorded = [];

vi.mock('../src/engine/short-horizon-vol.js', () => ({
  recordTick: (commodity, price, ts) => recorded.push({ commodity, price, ts }),
}));
vi.mock('../src/feeds/cfbenchmarks.js', () => ({
  isCfArmed: () => cfArmed,
  getCfIndex: () => cfValue,
  CF_MAX_AGE_MS: 15_000,
}));

const vol = await import('../src/engine/short-horizon-vol.js');

/** The ownership predicate as brti-spot.js applies it, exercised directly. */
function basketWouldRecord(now = Date.now()) {
  const cf = cfArmed ? cfValue : null;
  const cfOwnsVol = cf != null && now - cf.publishTimeMs <= 15_000;
  if (!cfOwnsVol) vol.recordTick('bitcoin', 1, now);
  return !cfOwnsVol;
}

beforeEach(() => {
  recorded.length = 0;
  cfArmed = false;
  cfValue = null;
});

describe('bitcoin vol-buffer ownership', () => {
  it('basket owns the buffer when CF is disarmed — today’s behaviour, unchanged', () => {
    expect(basketWouldRecord()).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  it('CF takes the buffer once armed AND fresh — the basket stops recording', () => {
    cfArmed = true;
    cfValue = { publishTimeMs: Date.now() - 2_000 };
    expect(basketWouldRecord()).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it('basket RESUMES ownership when the CF socket goes stale — the buffer never goes quiet', () => {
    cfArmed = true;
    cfValue = { publishTimeMs: Date.now() - 60_000 };
    expect(basketWouldRecord()).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  it('armed but no print yet → basket still owns it', () => {
    cfArmed = true;
    cfValue = null;
    expect(basketWouldRecord()).toBe(true);
  });

  it('never both at once, across a mixed sequence', () => {
    const t = Date.now();
    // disarmed → basket writes
    basketWouldRecord(t);
    // armed + fresh → basket silent
    cfArmed = true;
    cfValue = { publishTimeMs: t - 1_000 };
    basketWouldRecord(t);
    // socket dies → basket writes again
    cfValue = { publishTimeMs: t - 90_000 };
    basketWouldRecord(t);
    expect(recorded).toHaveLength(2);
  });
});
