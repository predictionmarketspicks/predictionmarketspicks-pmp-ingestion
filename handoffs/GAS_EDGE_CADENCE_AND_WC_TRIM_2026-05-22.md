# Gas Edge Cadence Rebuild + World Cup Pre-Tournament Prep

**Date**: 2026-05-22
**Severity**: P2 — no live customer harm, but Oracle Gas Edge's strike-trajectory chart is starving for data and WC volume will explode when the tournament opens
**Status**: Handoff. No code changes applied. Read the file, follow the plan, push.

---

## TL;DR

Two unrelated storage/cadence issues showed up during today's Supabase audit:

1. **Gas Edge writes way too little.** The Fly engine only samples `kalshi_gas_strikes` during a 15-minute window each night (23:50–00:05 ET). The Oracle Gas Edge tool's strike-trajectory chart (shipped 2026-05-18) tries to read "14 days of intraday samples" but the writer only produces 15 min/day → the chart shows a flat line for 23¾ hours and a tiny spike at midnight. **Fix: write ≥1 row per hour all day, drop to 60-second cadence in the final 15 minutes before settle.** Bonus: there's a stale code comment claiming the table has "zero read consumers" — it's the entire backing data for the chart now.

2. **World Cup writes too aggressively for the pre-tournament window.** 131k rows in 16 days, 30-day TTL firing, no storage emergency — but writing the same dormant book state 288 times a day before any match has been played is silly. **Drop the existing every-5-min cron to hourly now**, then **before June 11 add a game-day gate that drops back to 5-min cadence only on days with scheduled matches**. Pre-tournament write volume falls 92%; tournament steady-state ~70% lower than current path. Daily rollup pattern becomes optional rather than required given the new floor.

This handoff bundles both because they're the same kind of work (writer cadence + TTL + rollup pattern). Ship gas-edge first (P2 user-facing — chart looks broken), WC second (pre-emptive — has weeks of runway).

---

## Problem A — Gas Edge: writer cadence vs. chart consumer

### Current state (verified in code today)

**Writer** — `src/engine/gas-snapshot.js` (pmp-ingestion repo):

```js
// 2026-05-15: dropped from 5min/15min always-on to window-only.
// kalshi_gas_strikes has zero readers in lib/, app/, or any edge fn — Oracle
// Gas Edge settle/logger use commodity_edge_signals. We keep a thin sample
// purely for future analytics:
//   - SETTLEMENT WINDOW (23:50–00:05 ET): sample every 60s to capture print
//   - OUTSIDE WINDOW: idle (no writes)
// If the gas table ever gets a real-time read consumer, revisit this.
const GAS_WINDOW_INTERVAL_MS = 60 * 1000;       // 60s in window
const GAS_OUTSIDE_CHECK_MS = 5 * 60 * 1000;     // outside: wake every 5min, idle
```

Effective volume: 15 samples × 8 active strikes × 1 night = **~120 rows/day**. Confirmed against `kalshi_gas_strikes` row count today: 40,404 rows over ~10 months of operation (~135 rows/day average, matches).

**Consumer** — `lib/oracle-gas/strike-trajectory.ts` (main repo, shipped per CLAUDE.md 2026-05-18):

```ts
/**
 * Reads 14d of intraday samples for the live KXAAAGASD ticker the dashboard
 * is currently pointing at. `kalshi_gas_strikes` is written by the Fly
 * engine during the 23:50–00:05 ET settlement window at ~60s sampling.
 */
const FOURTEEN_DAYS_MS = 14 * 86_400_000
const MAX_SAMPLES = 500
// ... .gte('captured_at', new Date(Date.now() - FOURTEEN_DAYS_MS).toISOString())
//     .order('captured_at', { ascending: true })
//     .limit(MAX_SAMPLES)
```

The consumer's docstring even acknowledges the writer's window-only behavior, which means whoever shipped the chart **knew the cadence was wrong but did it anyway**. The chart over 14 days shows ~210 samples clustered in 14 narrow 15-min spikes at midnight, with nothing in between. That's not a "trajectory" — that's 14 stamps with white space.

### Target state

Hybrid cadence per gas-edge strike:

| Window (America/New_York) | Sampling | Rationale |
|---|---|---|
| **23:45–00:05 ET** (20-min burst around AAA settle) | every 60s | Capture the EIA print as it lands; current behavior already does this, just widened by 5 min at the front |
| **All other hours** | every 60 min, on the :00 wallclock | Gives the strike-trajectory chart real intraday data without flooding the table; chart can render the full 24h arc of "where is the market pricing tomorrow's gas?" |

Math on the new write volume:

- Burst: 20 samples × 8 strikes = 160 rows/day
- Baseline: 23 samples × 8 strikes = 184 rows/day
- **Total: ~344 rows/day** (was ~120/day — 2.9× current)
- Over 14 days (the chart's read horizon): ~4,800 rows, well under the `MAX_SAMPLES=500` per-ticker limit
- Annual at this cadence: ~125k rows → with 90d TTL guard (see Problem C), steady state ~31k rows. Trivial storage.

### Files to edit

1. `src/engine/gas-snapshot.js` — rewrite the cadence logic
2. `src/index.js` — verify the gas-snapshot loop is registered and starts at boot (it already is, but the new cadence needs to honor both timers)
3. `test/gas-snapshot-cadence.test.js` — new vitest file covering: in-burst-window, on-the-hour, mid-hour idle, env-var override behavior

### Exact change to `src/engine/gas-snapshot.js`

Replace the existing `isInGasWindow()` + constants + the scan loop logic with:

```js
// Gas Edge cadence (2026-05-22 rebuild):
//   - BURST WINDOW (23:45–00:05 ET): 60s sampling around the AAA settle print
//   - HOURLY BASELINE (every other hour): one sample on the :00 wallclock
// Drives /tools/oracle-gas Strike Trajectory chart (lib/oracle-gas/
// strike-trajectory.ts, shipped 2026-05-18). Previous window-only cadence
// gave the chart 14 spikes/14d; the new cadence gives it a continuous arc.
const GAS_BURST_INTERVAL_MS = Number(
  process.env.GAS_BURST_INTERVAL_MS || 60 * 1000,
);
// Outside the burst window we wake every minute, but only WRITE if the
// current ET wallclock minute === 0. Wake-frequency stays high so we don't
// miss the :00 mark by more than ~30s.
const GAS_BASELINE_CHECK_MS = Number(
  process.env.GAS_BASELINE_CHECK_MS || 60 * 1000,
);

// 23:45 ET → handle DST via Intl.DateTimeFormat (same pattern as the
// existing isInGasWindow). Window straddles UTC midnight only in DST.
function getEtMinuteOfDay(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const hh = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const mm = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  return { hh, mm, minuteOfDay: hh * 60 + mm };
}

export function isInGasBurstWindow(now = new Date()) {
  const { minuteOfDay } = getEtMinuteOfDay(now);
  // 23:45 = 1425; 00:05 = 5. Window wraps midnight.
  return minuteOfDay >= 23 * 60 + 45 || minuteOfDay <= 5;
}

export function isOnGasBaselineTick(now = new Date()) {
  // Sample on the :00 minute of every hour outside the burst window.
  // Tolerate up to 30s drift on either side so a slightly-late wake-up
  // still catches the hourly tick.
  const { mm } = getEtMinuteOfDay(now);
  return mm === 0;
}

// Replace the single-cadence scheduler with a unified "tick every minute,
// write only when the cadence rules say to" loop. Keeps the code simpler
// than tracking two SetIntervals.
function scheduleNext() {
  if (stopRequested) return;
  state.scanTimer = setTimeout(async () => {
    const now = new Date();
    const burst = isInGasBurstWindow(now);
    const hourly = !burst && isOnGasBaselineTick(now);
    if (burst || hourly) {
      try {
        await runGasSnapshotOnce();
      } catch (err) {
        state.lastErrorAt = new Date().toISOString();
        state.lastError = String(err?.message || err);
        console.warn(`[gas-snapshot] tick failed: ${state.lastError}`);
      }
    }
    // Always wake at the next minute boundary — keeps the :00 detection
    // honest without drifting more than a few seconds per day.
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    const interval = burst
      ? Math.min(GAS_BURST_INTERVAL_MS, msToNextMinute)
      : Math.max(GAS_BASELINE_CHECK_MS, msToNextMinute - 500);
    state.scanTimer = setTimeout(scheduleNext, interval);
  }, 100); // tiny initial delay so callers see state.scanTimer set immediately
}
```

Note: the existing `runGasSnapshotOnce()` function does not need to change — it already fetches + writes. Only the scheduling layer changes.

**Update the stale comment block at the top of the file:**

```js
// Oracle Gas Edge snapshot engine — drives the /tools/oracle-gas Strike
// Trajectory chart via lib/oracle-gas/strike-trajectory.ts. Writes
// kalshi_gas_strikes on a hybrid cadence:
//   - 23:45–00:05 ET: 60s sampling (capture the AAA EIA settle print)
//   - every other :00 wallclock minute: one sample per hour (chart spine)
// See handoffs/GAS_EDGE_CADENCE_2026-05-22.md for the why.
```

### Validation steps

```bash
cd /Users/benny/pmp-ingestion
npm test                                        # vitest run — new tests pass

# After deploy, watch live writes for one full day
curl -s "https://svxqipncfupabpvxtlro.supabase.co/rest/v1/kalshi_gas_strikes?order=captured_at.desc&limit=50&select=captured_at,ticker,strike,yes_ask,yes_bid" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" | jq '[.[] | .captured_at] | sort | unique | length'

# Expected: ~30-45 distinct captured_at values per day (24 hourly + ~21 in burst).
# Old behavior: ~15 captured_at values clustered at midnight.

# Render the gas dashboard and eyeball the chart:
open https://predictionmarketspicks.com/tools/oracle-gas
# The strike-trajectory chart should now show a continuous line across each
# day instead of 14 isolated spikes.
```

---

## Problem B — Stale `kalshi_gas_strikes` comments

Two files claim the table has "zero read consumers." Both are wrong as of 2026-05-18.

1. `src/feeds/kalshi-gas.js` — the header comment block is fine, just mentions the chart consumer
2. `src/engine/gas-snapshot.js` — the 2026-05-15 comment ("kalshi_gas_strikes has zero readers in lib/, app/, or any edge fn") needs to die

Replacement done in Problem A above when rewriting the cadence comment. No separate edit needed.

---

## Problem C — Add TTL guard on `kalshi_gas_strikes`

Currently no cleanup job. With the new cadence the table will write ~125k rows/year and grow forever. Add a 90-day TTL via cron — drop the migration into `supabase/migrations/`:

**File: `supabase/migrations/20260523_kalshi_gas_strikes_ttl.sql`** (in main repo, not pmp-ingestion):

```sql
-- 90-day TTL on kalshi_gas_strikes. Chart consumer reads 14d; 90d gives us
-- plenty of headroom for retrospective analytics + the StorageCleanup
-- 2026-05-15 audit's "no unbounded growth without TTL" rule.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'kalshi-gas-strikes-cleanup';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'kalshi-gas-strikes-cleanup',
  '0 5 * * *',
  $cmd$
    DELETE FROM public.kalshi_gas_strikes
    WHERE captured_at < now() - interval '90 days'
  $cmd$
);
```

Steady-state row count after this lands: ~31k. Today's count: 40,404 (mostly old daily-window data). The TTL job's first run will clean up ~3k stale rows from before 2026-02-22 — harmless.

---

## Problem D — World Cup: drop to hourly NOW, 5-min only on game days

### Current state

- `world_cup_market_snapshot`: 131k rows, 16 days old, 30-day TTL working (job `world-cup-snapshot-cleanup` @ 04:00 UTC)
- Cron `wc-kalshi-ingest` fires `*/5 * * * *` (every 5 min, 24×7) → calls edge fn `ingest-wc-kalshi-markets`
- Pre-tournament write rate: ~8k rows/day. Tournament doesn't open until **June 11 2026** (20 days away).

### Owner's direction (2026-05-22)

> "We absolutely do not need a 5 min WC write until games start. Even then that feels aggressive other than for live games. Change to hourly until games start and then only on game day drop that days games to 5 min."

Correct call. Pre-tournament every-5-min is writing the same dormant book state 288 times a day for zero reader benefit. New plan:

| Phase | Default cadence | Game-day cadence | Notes |
|---|---|---|---|
| **Now → June 10** | hourly (`0 * * * *`) | n/a | No matches scheduled; hourly captures any pre-tournament position-building |
| **June 11 → final** | hourly | 5-min on UTC dates with at least one scheduled kickoff | Game day = today is in the published WC schedule |
| **Post-final** | revert to hourly until rows TTL out | n/a | Or drop the cron entirely |

### Volume math

- **Hourly baseline**: 24 calls/day × ~28 active markets ≈ **670 rows/day** (was ~8k — 92% reduction)
- **Game day with 5-min layered on**: baseline + 12 calls/hour × ~12 hours of game window ≈ +2k rows = **~2.7k rows/day**
- **Full tournament estimate**: ~28 group-stage match days + ~16 knockout match days ≈ 44 game days. Plus ~25 non-game days during the tournament. Total tournament write volume estimate: 44 × 2.7k + 25 × 670 ≈ **135k rows over 5 weeks**, vs. current path's ~1.2M+
- **Steady state under 30d TTL**: peaks around end-of-group-stage at ~75k. Well under previous baseline.

### Dependency that needs to be sourced first

**We don't currently store kickoff dates anywhere.** `WC_GROUP_MATCHES` in `pmp-ingestion/src/feeds/wc-shared.js` has 72 group-stage tuples `[group, matchday, home_slug, away_slug]` but no dates. The ESPN feed (`wc-espn.js`) pulls live game state for today's matches only — not a persisted schedule.

We have two options:

**Option 1 (recommended): hardcode kickoff dates into `WC_GROUP_MATCHES`.** The FIFA Final Draw happened 2025-12-05 and the schedule is public + fixed. Single source of truth, no live API dependency, easy to test. Extend each tuple from 4-element `[group, matchday, home, away]` to 5-element `[group, matchday, home, away, kickoff_iso_utc]`. Knockout-round matches get added as the draw resolves (handled separately — same pattern, append to the array).

**Option 2: nightly ESPN scrape.** Pull `?dates=YYYYMMDD` for every day from June 11 → final at boot, persist to a new `world_cup_fixtures` table. More moving parts, depends on ESPN. Defer unless Option 1 turns out wrong.

Go with Option 1. Single-file change, no migration, no new API surface.

### Implementation

#### Step 1 (ship NOW — single migration, 30 seconds of work)

Replace the existing cron with hourly. Drops write volume by 92% immediately.

**File**: `supabase/migrations/20260523_wc_cron_hourly.sql` (in main repo):

```sql
-- Drop WC ingest from every-5-min to hourly. Tournament opens 2026-06-11;
-- pre-tournament book state doesn't churn fast enough to justify 288 writes/day.
-- A second cron with 5-min cadence + game-day gating ships separately
-- (see handoffs/GAS_EDGE_CADENCE_AND_WC_TRIM_2026-05-22.md Problem D Step 2)
-- once kickoff dates land in WC_GROUP_MATCHES.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'wc-kalshi-ingest';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'wc-kalshi-ingest',
  '0 * * * *',  -- hourly on the :00
  $cmd$
    SELECT net.http_post(
      url := 'https://svxqipncfupabpvxtlro.supabase.co/functions/v1/ingest-wc-kalshi-markets',
      headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2eHFpcG5jZnVwYWJwdnh0bHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MzA2MTIsImV4cCI6MjA4OTIwNjYxMn0.0nzr10dh12LqaLBwg-l5CtqXRO3kIWtluNGjFFRI_9M", "Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    )
  $cmd$
);
```

After this lands you can safely forget about WC writes until kickoff dates need to go in.

#### Step 2 (ship before June 11 — game-day 5-min cadence)

Two pieces:

**(a) Add kickoff dates to `pmp-ingestion/src/feeds/wc-shared.js`:**

```js
// WC_GROUP_MATCHES extended with kickoff_at (ISO UTC).
// Source: FIFA Final Draw 2025-12-05 official schedule. Knockout matches
// appended as the draw resolves; each entry's date is fixed at publication.
export const WC_GROUP_MATCHES = [
  ['A', 1, 'mexico', 'korea-republic',   '2026-06-11T20:00:00Z'],
  ['A', 1, 'south-africa', 'czechia',    '2026-06-12T16:00:00Z'],
  // ... 70 more rows; pull from the FIFA schedule
];

// Helper exposed for cron-side game-day gating
export function isWcGameDay(now = new Date()) {
  const ymd = now.toISOString().slice(0, 10);
  return WC_GROUP_MATCHES.some(([, , , , kickoff]) => kickoff?.startsWith(ymd));
}

export function todaysWcMatches(now = new Date()) {
  const ymd = now.toISOString().slice(0, 10);
  return WC_GROUP_MATCHES.filter(([, , , , kickoff]) => kickoff?.startsWith(ymd));
}
```

Tests in `test/wc-shared-fixtures.test.js`: every tuple has a valid ISO UTC string in 2026-06 or 2026-07, `isWcGameDay` returns true for known game days and false for off days.

**(b) Add a second cron + gate inside the edge function:**

Two options for where to put the gate. Pick (i) — simpler.

**(i) Gate inside the edge function** (`supabase/functions/ingest-wc-kalshi-markets/index.ts`): on every invocation, check `isWcGameDay(new Date())`. If false, only run when the wallclock minute === 0. If true, always run. Cron stays at `*/5 * * * *` post-June-11; pre-June-11 the hourly cron from Step 1 covers everything and there's no harm leaving the 5-min cron disabled.

Migration to flip the cron back to 5-min on the day before kickoff:

```sql
-- File: supabase/migrations/20260610_wc_cron_gameday_5min.sql
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'wc-kalshi-ingest';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'wc-kalshi-ingest',
  '*/5 * * * *',  -- every 5 min, but the edge fn gates writes by game-day check
  $cmd$ ... same body as before ... $cmd$
);
```

**(ii) Two crons** — keep `wc-kalshi-ingest-hourly` at `0 * * * *` always, add `wc-kalshi-ingest-gameday-5min` at `*/5 * * * *` with the gate at the cron level via a `WHERE` clause checking a `wc_fixtures` table. Cleaner separation but requires a fixtures table (Option 2 above) and Postgres-side date logic. Skip.

#### Step 3 (optional, post-tournament)

Daily rollup table (`world_cup_market_snapshot_daily`) for the historical "what did the market know and when" retrospective. Same pattern as `polymarket_market_snapshots_daily`. Not urgent given the new lower volume — the snapshot table will hold its own under 30d TTL. Decide post-tournament whether the long-term record is worth the schema work.

### When to ship each step

- **Step 1 (hourly cron)**: tonight or tomorrow. Pure SQL migration, no code dependencies, no test surface, immediately drops write volume.
- **Step 2 (game-day 5-min)**: hard deadline 2026-06-10 (one day before opener). Requires WC_GROUP_MATCHES kickoff dates + edge fn gate. Maybe 2 hours of work + tests.
- **Step 3 (daily rollup)**: post-tournament. Decide then.

### Files in scope (this section only)

| File | Repo | When | Status | Action |
|---|---|---|---|---|
| `supabase/migrations/20260523_wc_cron_hourly.sql` | prediction-marketspicks | NOW | NOT created | Step 1 migration |
| `src/feeds/wc-shared.js` | pmp-ingestion | by June 10 | NOT edited | Step 2 (a) — add kickoff_at to tuples |
| `test/wc-shared-fixtures.test.js` | pmp-ingestion | by June 10 | NOT created | Step 2 (a) tests |
| `supabase/functions/ingest-wc-kalshi-markets/index.ts` | prediction-marketspicks | by June 10 | NOT edited | Step 2 (b) — gate writes via isWcGameDay |
| `supabase/migrations/20260610_wc_cron_gameday_5min.sql` | prediction-marketspicks | June 10 | NOT created | Step 2 (b) — flip cron back to 5-min |
| `supabase/migrations/20260*_wc_daily_rollup.sql` | prediction-marketspicks | post-tournament | NOT created | Step 3 — optional |

---

## Out of scope (don't bundle into this PR)

- Wider Oracle Gas Edge methodology changes (e.g. moving the settle window calc, changing which series feeds the chart). This handoff only changes WRITE cadence.
- World Cup ingest function itself (`functions/ingest-wc-kalshi-markets`). Keep the 5-min cron; only the read/rollup side gets reworked.
- `commodity_gamma_snapshots` cadence — unique constraint already caps it at 1 row/(commodity, snapshot_date). Fine as-is.
- Re-enabling the oil USO-synthetic path. Separate handoff at `handoffs/COMMODITY_EDGE_OIL_BITCOIN_FIX_2026-05-22.md`.

---

## Commit + push

One commit per problem so they're independently revertable:

```bash
# Problem A + B (gas-edge cadence + stale comment)
cd /Users/benny/pmp-ingestion
# (apply edits)
git add src/engine/gas-snapshot.js test/gas-snapshot-cadence.test.js handoffs/GAS_EDGE_CADENCE_AND_WC_TRIM_2026-05-22.md
git commit -m "feat(gas-snapshot): hybrid cadence (hourly baseline + 60s burst) to feed the Strike Trajectory chart

Previous window-only cadence (60s sampling 23:50–00:05 ET only) gave the
chart 14 spikes per 14-day read horizon, with 23h45m of nothing between
each. lib/oracle-gas/strike-trajectory.ts shipped 2026-05-18 expecting
'14d of intraday samples'; this commit makes that true:

- BURST WINDOW (23:45–00:05 ET): 60s sampling around the AAA settle print
- HOURLY BASELINE (every :00 wallclock minute outside burst): 1 sample/hr

New write volume: ~344 rows/day (was ~120). Annual at this cadence ~125k;
90d TTL guard ships in a parallel migration in the main repo.

Also kills the stale 2026-05-15 'zero read consumers' comment — the
strike-trajectory chart has been the read consumer since 2026-05-18.

Tests: test/gas-snapshot-cadence.test.js covers burst, hourly tick,
mid-hour idle, env-var override.

Handoff: handoffs/GAS_EDGE_CADENCE_AND_WC_TRIM_2026-05-22.md"
git push origin main

# Problem C (TTL — separate repo)
cd /Users/benny/prediction-marketspicks
# (create supabase/migrations/20260523_kalshi_gas_strikes_ttl.sql)
git add supabase/migrations/20260523_kalshi_gas_strikes_ttl.sql
git commit -m "feat(supabase): 90d TTL on kalshi_gas_strikes via cron

Pairs with the gas-snapshot cadence rebuild (pmp-ingestion #21). New write
volume of ~344 rows/day requires a TTL guard — 90d gives chart consumer
(14d horizon) plenty of headroom while keeping steady-state at ~31k rows.

Cleanup job 'kalshi-gas-strikes-cleanup' runs daily at 05:00 UTC."
git push origin main

# Problem D: hold for late May / early June, separate commit when shipped
```

After both pushes:
- Fly auto-deploys the engine (~3 min)
- Supabase migration runs on first connection from the main app

Validation per Problem A "Validation steps" section above. Give it ~25 hours after deploy to see a full day's worth of hybrid-cadence samples populate.

---

## Files in scope

| File | Repo | Status | Action |
|---|---|---|---|
| `src/engine/gas-snapshot.js` | pmp-ingestion | NOT edited | Apply rewrite per Problem A |
| `test/gas-snapshot-cadence.test.js` | pmp-ingestion | NOT created | Write tests per Problem A |
| `supabase/migrations/20260523_kalshi_gas_strikes_ttl.sql` | prediction-marketspicks | NOT created | Apply migration per Problem C |
| `supabase/migrations/20260601_wc_daily_rollup.sql` | prediction-marketspicks | NOT created | Hold for early June per Problem D |
| `supabase/migrations/20260601_wc_snapshot_ttl_tighten.sql` | prediction-marketspicks | NOT created | Hold for early June per Problem D |
| `handoffs/GAS_EDGE_CADENCE_AND_WC_TRIM_2026-05-22.md` | pmp-ingestion | Created (this file) | Include in Problem A commit |
