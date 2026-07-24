# Commodity Soak Validator — Whitelist Expected Flags

**Date**: 2026-05-30
**Severity**: P2 — soak has cried wolf on every run since deploy (13/13 red ❌). False-positive noise is hiding real failures.
**Status**: Spec + ready-to-apply patch in this doc. No code committed yet.
**Branch suggestion**: `fix/soak-expected-flags`

---

## TL;DR

`scripts/soak-commodities.js` criterion #5 ("No NON-NULL quality_flag values landed today") is **incompatible with the engine's intentional use of `quality_flag` as an audit tag**. It has fired on every single run since the soak shipped on 2026-05-15. Run #13 (2026-05-29, 21:00 UTC):

```
silver:  FAIL — snapshots=2 < 4; quality_flagged_rows=26
gold:    FAIL — snapshots=2 < 4; quality_flagged_rows=48
oil:     FAIL — snapshots=1 < 4
bitcoin: FAIL — quality_flagged_rows=562
```

Run #12 (2026-05-28) shows the same shape. Run #11. Run #10. All 13 runs.

**Root cause**: The engine intentionally writes `quality_flag='twap_settle_window'` rows in the final 15 minutes before each settle (handoff: `COMMODITY_EDGE_OIL_BITCOIN_FIX_2026-05-22.md`). Bitcoin settles HOURLY → 15 min × 24 hours × ~60s cadence × ~6 strikes = **roughly 1,440 audit rows daily by design**. `cold_buffer` adds another ~5 min × strikes per Fly redeploy. These are NOT errors — site readers + Discord routing already filter `quality_flag IS NULL`.

**Secondary concern**: `snapshots=1-2 < 4` for silver/gold/oil. The unflagged-snapshot count is genuinely low. Could be: (a) flagged snapshots dominate the day's writes (most likely — every TWAP-window snap is flagged on bitcoin, ditto cold_buffer windows on silver/gold/oil), or (b) engine writes are actually sparse. We won't know until #5 is fixed and we can see clean numbers. **Don't touch criterion #3 yet.**

---

## The seven `quality_flag` values and how to treat them

Grepped from `src/engine/commodity-base.js`:

| Flag | When fired | Expected volume | Treat as |
|---|---|---|---|
| `cold_buffer` | First ~5 min after Fly redeploy, Pyth buffer not warm | Dozens per redeploy × commodities | **EXPECTED** (whitelist) |
| `twap_settle_window` | `minutesToClose < config.minMinutesToClose` (bitcoin: 15min, others: null) | Hundreds daily for bitcoin (hourly settles) | **EXPECTED** (whitelist) |
| `kalshi_no_book` | Kalshi market has no book | Should be rare | UNEXPECTED, ceiling 50/day |
| `kalshi_stale_divergence` | Kalshi quote stale + diverges from engine prob | Rare | UNEXPECTED, ceiling 25/day |
| `kalshi_thin_book_large_edge` | Kalshi book thin + large engine edge | Rare | UNEXPECTED, ceiling 25/day |
| `smile_kalshi_diverged` | Per-snapshot smile-vs-kalshi correlation < 0.5 | Rare (chain corruption) | UNEXPECTED, ceiling 10/day |

The fix: replace the existing "any non-null flag = fail" with a per-flag whitelist + ceiling map.

---

## Patch — `scripts/soak-commodities.js`

Replace lines 38–46 and lines 133–140. Full replacement block:

```javascript
// --- replace existing MIN_SMILE_RATIO_DEFAULT block (around line 38–46) ---

const IV_HARD_CAP = 3.0;
const MIN_SNAPSHOTS_PER_DAY = 4;
const MIN_SMILE_RATIO_DEFAULT = 0.005;
const MIN_SMILE_RATIO_OVERRIDES = {};
const BOT_LOGS_CHANNEL_ID = '1487857846111567952';

// quality_flag classification. EXPECTED_FLAGS fire under normal operation by
// design — cold_buffer after Fly redeploys, twap_settle_window in the last 15
// min before bitcoin's hourly settles. Site readers + Discord routing filter
// `quality_flag IS NULL` so these never reach a public surface. Soak ignores
// them.
//
// UNEXPECTED_FLAG_CEILINGS sets per-flag daily ceilings for the genuinely
// problematic flags. Small daily counts (transient hiccups) are fine; anything
// sustained means kalshi or the chain is broken — those should fail soak.
const EXPECTED_FLAGS = new Set(['cold_buffer', 'twap_settle_window']);
const UNEXPECTED_FLAG_CEILINGS = {
  kalshi_no_book:              50,
  kalshi_stale_divergence:     25,
  kalshi_thin_book_large_edge: 25,
  smile_kalshi_diverged:       10,
};
// Anything not in either set above falls through to ceiling=0 (any sighting
// fails). New flag names added to the engine should be added here explicitly.
```

Replace the criterion-#5 block in `checkCommodity` (currently lines 133–140) with:

```javascript
  // Criterion #5: per-flag classification (replaces the blanket flaggedCount > 0 check).
  const { data: flagRows, error: flagErr } = await client
    .from('commodity_edge_signals')
    .select('quality_flag')
    .eq('commodity', commodity)
    .eq('snapshot_date', snapshotDate)
    .not('quality_flag', 'is', null);
  if (flagErr) {
    failures.push(`flag_query: ${flagErr.message}`);
  } else {
    const flagCounts = {};
    for (const r of flagRows || []) {
      flagCounts[r.quality_flag] = (flagCounts[r.quality_flag] || 0) + 1;
    }
    for (const [flag, count] of Object.entries(flagCounts)) {
      if (EXPECTED_FLAGS.has(flag)) continue;
      const ceiling = UNEXPECTED_FLAG_CEILINGS[flag] ?? 0;
      if (count > ceiling) failures.push(`${flag}=${count} > ${ceiling}`);
    }
  }
```

Note: the Supabase `.select('quality_flag')` query returns ALL flagged rows in JS — for bitcoin's 500–1500 flagged rows/day this is fine (well under the 1000-row default limit per page, but ESLint won't yell either way; if it ever exceeds use `.csv()` or `.count('exact')` with `head: true` per-value). For the foreseeable cardinality (≤7 flag values × ≤2000 rows) this is cheap.

---

## Tests — extend `test/scripts.soak-commodities.test.js`

Add a new describe block. The existing tests cover `evaluateSmile` and `minSmileRatio` purely — for the flag classifier we want a similar pure helper. **Refactor**: extract the classification into an exported pure function:

```javascript
// in scripts/soak-commodities.js, alongside evaluateSmile:

export function classifyFlagCounts(flagCounts, {
  expected = EXPECTED_FLAGS,
  ceilings = UNEXPECTED_FLAG_CEILINGS,
} = {}) {
  const violations = [];
  for (const [flag, count] of Object.entries(flagCounts || {})) {
    if (expected.has(flag)) continue;
    const ceiling = ceilings[flag] ?? 0;
    if (count > ceiling) violations.push({ flag, count, ceiling });
  }
  return violations;
}
```

Then call `classifyFlagCounts(flagCounts)` in `checkCommodity` and push `${v.flag}=${v.count} > ${v.ceiling}` for each.

Test cases to add:

```javascript
describe('classifyFlagCounts', () => {
  it('ignores cold_buffer at any volume', () => {
    expect(classifyFlagCounts({ cold_buffer: 9999 })).toEqual([]);
  });

  it('ignores twap_settle_window at any volume (bitcoin hourly settles produce 500+ rows/day)', () => {
    expect(classifyFlagCounts({ twap_settle_window: 1500 })).toEqual([]);
  });

  it('passes mixed expected flags', () => {
    expect(classifyFlagCounts({ cold_buffer: 30, twap_settle_window: 800 })).toEqual([]);
  });

  it('fails kalshi_no_book above ceiling 50', () => {
    const v = classifyFlagCounts({ kalshi_no_book: 51 });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ flag: 'kalshi_no_book', count: 51, ceiling: 50 });
  });

  it('passes kalshi_no_book at exactly 50 (ceiling is inclusive of equal counts)', () => {
    expect(classifyFlagCounts({ kalshi_no_book: 50 })).toEqual([]);
  });

  it('fails smile_kalshi_diverged at low volume (ceiling 10)', () => {
    expect(classifyFlagCounts({ smile_kalshi_diverged: 11 })).toHaveLength(1);
  });

  it('fails unknown flags on first sighting (defensive — forces engine devs to update soak)', () => {
    expect(classifyFlagCounts({ some_new_flag: 1 })).toHaveLength(1);
  });

  it('reports all violations in one pass', () => {
    const v = classifyFlagCounts({
      cold_buffer: 100,                        // ignored
      twap_settle_window: 800,                 // ignored
      kalshi_no_book: 200,                     // FAIL
      smile_kalshi_diverged: 11,               // FAIL
    });
    expect(v.map((x) => x.flag).sort()).toEqual(['kalshi_no_book', 'smile_kalshi_diverged']);
  });
});
```

---

## After patch lands — investigate the snapshots threshold separately

Once #5 stops crying wolf, criterion #3 (`snapshots ≥ 4`) is the next thing to look at. Hypothesis: the unflagged snapshot count looks low because most of each day's silver/gold/oil snapshots fall inside cold_buffer or transient flag windows. Real action items:

1. After patch ships, watch one full week of soak runs. If snapshots≥4 is consistently failing for silver/gold/oil while bitcoin passes, we have an engine-availability problem, not a threshold problem.
2. If it's threshold, lower MIN_SNAPSHOTS_PER_DAY to 2 (matches observed reality on a typical day) OR drop the `.is('quality_flag', null)` filter from the snapshot-count query (count flagged snapshots too — they prove the engine wrote *something*).
3. **Don't lower the threshold without first looking at production data.** Pull `SELECT commodity, snapshot_date, COUNT(DISTINCT snapshot_at) FROM commodity_edge_signals WHERE snapshot_date >= '2026-05-15' GROUP BY 1, 2 ORDER BY 1, 2;` and pick a floor from the 5th-percentile day per commodity.

Tracking this as a follow-up — NOT bundled with this patch.

---

## Node.js 20 deprecation warning (cosmetic, ignore for now)

Both jobs emit `Node.js 20 actions are deprecated`. We're already pinning `node-version: '24'` for the actual job step. The warning is from `actions/checkout@v4` and `actions/setup-node@v4` themselves being implemented in Node 20. June 16 2026 GH will force-bump them. If you want zero noise now, prepend to the job env:

```yaml
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'
```

Don't block this PR on it.

---

## Sanity checks before pushing

```bash
cd /Users/benny/pmp-ingestion
npm test -- test/scripts.soak-commodities.test.js
npm test  # full suite — make sure nothing else regressed
node scripts/soak-commodities.js  # dry-run against today's data (needs SUPABASE_URL + SUPABASE_SERVICE_KEY in .env.local; SKIP discord by leaving DISCORD_BOT_TOKEN unset)
```

Expected after patch:
- Test suite passes
- Local dry run: bitcoin no longer fails on `quality_flagged_rows=*`; if silver/gold/oil still fail on `snapshots < 4`, that's the real-engine-availability flag to chase in the follow-up.

---

## Files this touches

- `scripts/soak-commodities.js` — replace lines ~38–46 (constants block) and ~133–140 (criterion #5 in `checkCommodity`). Export new `classifyFlagCounts` helper.
- `test/scripts.soak-commodities.test.js` — add `describe('classifyFlagCounts', …)` block.

No engine code changes. No DB schema changes. No GH Actions workflow changes (unless you want to silence the Node-20 warning, which is optional).

---

## Commit message

```
fix(soak): whitelist expected quality_flag values (cold_buffer, twap_settle_window)

Soak has failed on every run since deploy (2026-05-15, 13/13 red) because
criterion #5 treated any non-null quality_flag as an error. Engine design
uses quality_flag as an audit tag — cold_buffer after Fly redeploys,
twap_settle_window in the 15-min window before bitcoin's hourly settles.
Site readers + Discord routing already filter quality_flag IS NULL.

Replace blanket flaggedCount > 0 check with a per-flag classifier:
- EXPECTED_FLAGS (cold_buffer, twap_settle_window): always ignored
- UNEXPECTED_FLAG_CEILINGS: per-flag daily ceiling, fail when exceeded
- Unknown flags: ceiling 0 (any sighting fails — forces explicit handling)

Extract pure-function classifier (classifyFlagCounts) for testability,
mirroring the evaluateSmile pattern from the 2026-05-15 ratio retune.

Snapshot-count criterion (#3) untouched — separate concern to investigate
after this stops crying wolf.

Handoff: COMMODITY_SOAK_VALIDATOR_FIX_2026-05-30.md
```
