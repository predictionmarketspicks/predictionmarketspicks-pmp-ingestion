# NFL Ext-Feeds — Reliability Fixes After the Silent 6-Week PFF Outage

**Status**: §3 + §4 + §5 SHIPPED `e81a950` (2026-08-03, not deployed — none of this runs on Fly). §1 + §2 still need Benny. §6/§7 are SKILL.md doc rules, already patched.
**One follow-up owed** — SKILL.md §5's loop still passes `--season=$SEASON` on lines 114/123/184; that now hard-blocks `power-ranks`/`free-agency`, which carry their own season. Drop the flag: every staging file has a `season` field, so the bare command is correct. Not done here because SKILL.md was already uncommitted from the session that wrote this doc (one-writer).
**Date**: 2026-08-03
**Repo**: `pmp-ingestion` (INTERNAL-ONLY — `ext_*` tables never face a user)
**Trigger**: Run A (Mon 2026-08-03) found PFF logged out; 3 of 4 feeds uncapturable. Login was fixed mid-session and the run completed.

---

## What happened

The scheduled Run A opened `premium.pff.com` and got a **signed-out page that still rendered 32 team rows** — every grade column blank. The same logged-out state truncated `pff.com/nfl/grades/position/QB` to the top 3 players and `pff.com/betting/nfl-power-rankings` to 10 of 32 teams. All three are *plausible-looking partial data*, not errors.

The PFF session died sometime between **2026-06-21** (last good capture) and **2026-08-03**. **Nothing noticed for six weeks.** Two independent defects allowed that:

1. The Discord alert path is dead (empty token) — §1 below.
2. The dry-count gate reads leftover staging files, so failed captures still "pass" — §3 below.

Benny logged into PFF + FTN mid-session; the run then completed. **No data was lost and no bad data was written** — the count checks and a per-feed source review caught every trap before the real ingest.

---

## Final state — all five tables correct

| Table | Season / Week | Rows | This run |
|---|---|---|---|
| `ext_team_grades` | 2025 / `REGPO` | 32 | ✅ re-captured + ingested |
| `ext_team_dvoa` | 2025 / wk18 | 32 | ✅ re-captured + ingested |
| `ext_player_grades` | 2025 / wk18 | 415 | untouched (frozen season — §6) |
| `ext_power_ranks` | 2026 / wk0 | 32 | untouched (deliberate — §4) |
| `ext_free_agents` | 2026 | 396 | untouched (Run B feed) |

---

## 1. `DISCORD_BOT_TOKEN` is empty — **highest priority, Benny only**

`.env` line 51 is `DISCORD_BOT_TOKEN=` with a **zero-length value**. `postBotLog()` returns `false` and logs `[discord] DISCORD_BOT_TOKEN not set — skipping post`.

This is not scoped to this skill — **every alerting job in `pmp-ingestion` is silently muted.** It is the direct reason the outage ran six weeks.

```bash
# verify
node --env-file-if-exists=.env -e "console.log(process.env.DISCORD_BOT_TOKEN ? 'SET (len '+process.env.DISCORD_BOT_TOKEN.length+')' : 'EMPTY/UNSET')"
# expect: SET (len ~70)
```

**Action (Benny):** paste the bot token into `.env`. Then re-run the verify above and post a test line to `#bot-logs`.

**Follow-up worth considering:** a startup assertion that fails loudly when a delivery credential is present-but-empty. Present-but-empty is worse than absent — it reads as "configured."

---

## 2. No vendor login monitor — **the actual root cause**

Nothing watches the PFF/FTN sessions. A logout degrades to partial data, not an error, so only a human reading a run summary catches it.

**Proposed:** a weekly authenticated-page probe that asserts a known cell is non-null (e.g. `premium.pff.com/nfl/teams/2025/REGPO` → Arizona `overall` is a number, not blank) and posts to `#bot-logs` on failure. Cheap, and it converts a silent 6-week hole into a 7-day one. Blocked on §1.

---

## 3. The dry-count gate can't detect a stale staging file

`scripts/ingest-ext-feeds.js --dry` reads whatever JSON is on disk. Staging files are never cleared. On 8/3 the three feeds that **failed to capture entirely** still dry-counted **32 / 415 / 32** off 6-week-old files — every count matched the expected value in SKILL.md §3.

A run that trusted the count alone would have done a real ingest of stale data tagged `--source=manual` and reported four healthy feeds.

**SHIPPED `e81a950`.** `ingest-ext-feeds.js` refuses a staging file not captured **today** and exits 1. Two deliberate deviations from the spec below, both to make the guarantee real:

- **Dry runs are blocked too**, not just real ones. The spec scoped this to non-`--dry`, but the misleading *count* is the trap — a dry run that prints `415` off a fossil has already done the damage. `--allow-stale` restores the old behavior in both modes.
- **Day boundary, not a rolling N hours.** A rolling window false-flags a file the same capture session just wrote — measured: a 6h window blocked that morning's own `grades-team.json` (10.8h) and `dvoa-team.json` (18.6h) by evening. That is the failure mode §5 of SKILL.md already warned about. `--max-age-hours=N` opts into a rolling window if ever wanted.

Verify (from `pmp-ingestion`, no secrets needed):
```bash
node scripts/ingest-ext-feeds.js all --dry; echo "exit=$?"
# fresh feeds print counts; anything not captured today prints BLOCKED; exit=1 if any
```

**Interim fix (superseded by the above, kept because it's still the human eyeball check): SKILL.md §5's** staleness gate:

```bash
find data/ext-staging -name '*.json' ! -name '*.example.json' -mmin +60 \
  -printf '  STALE  %f  (%TY-%Tm-%Td %TH:%TM)\n'
```

**Proper fix (code, unstarted):** have `ingest-ext-feeds.js` refuse a non-`--dry` run when the staging file's mtime is older than N hours, overridable with `--allow-stale` for intentional backfills.

---

## 4. `--season` is per-run, but the data is per-feed

`--season` **overrides the `season` field inside the staging file for every row.** In the offseason the feeds straddle two seasons:

- `grades-team` / `grades-player` / `dvoa-team` → the **completed** season (2025)
- `power-ranks` → **next** season's preseason projection, `week 0` (2026 — header reads "Rankings prior to Week 1")
- `free-agency` → the **new** FA class (2026)

The documented §5 loop passes one `--season` to all feeds. Running it as written on 8/3 (`--season=2025`) would have written the **2026 preseason projections into season 2025**. Caught pre-ingest; `power-ranks` was excluded.

**SHIPPED `e81a950`** — `resolveSeason()` in `src/feeds/ext-shared.js` does both halves: the staging file's `season` wins, and a disagreement is a hard error tagged `SEASON_MISMATCH` (the runner exits 1 on it rather than logging an ordinary skip). `--season` is now optional — **every real staging file already carries its own `season`**, so the correct invocation is to drop the flag entirely.

Verify — this is the literal 8/3 corruption attempt, now refused:
```bash
node scripts/ingest-ext-feeds.js power-ranks --season=2025 --allow-stale --dry
# BLOCKED — season mismatch: --season=2025 but the staging file says 2026 · exit=1
node scripts/ingest-ext-feeds.js power-ranks --allow-stale --dry   # 32 rows · exit=0
```

---

## 5. `ingested_at` is insert-only — not a freshness signal

`upsert()` in `src/delivery/ext-feeds.js` doesn't include `ingested_at`, so the column's `now()` default fires only on the original INSERT. After refreshing all 32 `ext_team_dvoa` rows on 8/3, `max(ingested_at)` still read **2026-06-21**.

**SHIPPED `e81a950`** — all five normalizers in `src/feeds/*.js` now write `ingested_at` explicitly. Confirmed against prod first that all five `ext_*` tables carry the column (`timestamp with time zone`, default `now()`), so the payload cannot error:

```bash
supabase db query "select table_name from information_schema.columns where table_schema='public' and table_name like 'ext\_%' and column_name='ingested_at' order by 1;" --linked   # expect 5 rows
```

**Note the semantic flip:** `ingested_at` now means *last written*, not *first seen*. Safe — a repo-wide grep found no reader of the column or of any `ext_*` table outside the creating migration. It becomes a usable freshness signal from the next real ingest forward; rows written before `e81a950` still carry their original INSERT timestamp, so **the first post-fix run is the earliest point a staleness monitor can trust.**

---

## 6. Two source-choice traps (documented in SKILL.md §3)

**`grades-player` — SKILL.md pointed at the wrong page.** It listed `pff.com/nfl/grades/position/{POS}` (marked "free"). The 415 rows actually in `ext_player_grades` came from **`premium.pff.com/nfl/positions/{SEASON}/REGPO/{report}`** — a different, much richer table carrying the full stat line (`pass_att`, `btt_rate`, `twp_rate`, `qb_rating`, …) that fills `extra{}`. Capturing from the documented URL would have written thinner rows over richer ones. Seeded 2025 coverage is skill positions only: QB 45, HB 90, WR 155, TE 76, FB 7, K 42.

**`power-ranks` — the rendered table silently destroys data.** It rounds to 1 decimal and renders small probabilities as **`<1%`**, which `pct()` parses to **`null`** (`Number("<1")` → NaN). Ground truth from the DB (June CSV capture):

| team | DB (CSV) | page (table) | after re-ingest |
|---|---|---|---|
| LA `point_spread_rating` | `5.6548558` | `5.7` | rounded |
| ARI `win_super_bowl_pct` | `0.0008` | `<1%` | **null** |
| MIA `win_super_bowl_pct` | `0.0008` | `<1%` | **null** |

Values are otherwise identical to June, i.e. **the projections have not moved**. Re-ingesting from the table would have been a pure downgrade. Feed skipped; use the CSV export.

---

## 7. Frozen-season rule (new, in SKILL.md §3)

The 2025 season is complete. `grades-team` / `grades-player` / `dvoa-team` for 2025 are **final** — PFF re-grades moved ≤0.1 between June and August. The offseason monthly Run A has nothing meaningful to do for those three once the rows exist; it should verify presence and say so rather than re-derive identical data at high cost.

`power-ranks` and `free-agency` **do** move in the offseason — those are the feeds worth refreshing on the monthly cadence.

---

## Remaining order

1. **§1 token** (Benny, 2 min) — unblocks every alert in the repo, including §2. Still the highest-value item: the code gates below make a broken capture *visible in the run output*, but with `DISCORD_BOT_TOKEN` empty nothing reaches `#bot-logs`, so an unattended run still fails quietly. Exit 1 is now at least machine-detectable.
2. **§2 login probe** — needs §1 first.
3. **SKILL.md `--season` cleanup** — see the follow-up in the status header.

~~§3 / §4 / §5~~ — shipped `e81a950`.

## Files changed

**Committed `e81a950` (2026-08-03):**
- `scripts/ingest-ext-feeds.js` — staleness gate, `--allow-stale`, `--max-age-hours`, non-zero exit on any blocked feed.
- `src/feeds/ext-shared.js` — `stagingMtimeMs` / `stagingAgeHours` / `isCapturedToday` / `resolveSeason`.
- `src/feeds/{grades-team,grades-player,power-ranks,free-agency,dvoa-team}.js` — `resolveSeason` + `ingested_at`.
- `test/feeds.ext.test.js` — +21 assertions (both gates, season matrix, the six-week-fossil and same-morning-capture shapes). Suite: **398 passing / 27 files**.

**Deliberately NOT committed** (pre-existing uncommitted work from the session that wrote this doc — one-writer):
- `skills/nfl-ext-feeds-capture/SKILL.md` — the §2.1/§2.3/§3/§5/§7 doc corrections.
- `data/ext-staging/grades-team.json`, `dvoa-team.json` — fresh 2025 captures (gitignored anyway).

## Deployment

**Nothing to deploy.** Only `scripts/ingest-ext-feeds.js` imports these feeds — `src/index.js` does not — so the always-on Fly engine is untouched and no `fly deploy --remote-only` is owed. Verify: `grep -rn "ext-shared\|ingest-ext-feeds" src/index.js` → no hits.

## Incidental finding — stale `.git/index.lock`, second repo

Staging this commit hit a zero-byte `.git/index.lock` in `pmp-ingestion` dated **2026-08-03 10:06**, with no `lsof` holder and no live git process — the exact signature of the open Active Issue in `prediction-marketspicks` (`docs/STATUS.md`), which had only ever been seen in that repo. 10:06 is minutes after this run's own 09:58 `grades-team.json` capture, which is direct evidence for that issue's remaining unproven hypothesis: **a Cowork session killed mid-git-write.** Reaped after the checks; `git fsck` clean (dangling commits only). The watchdog `scripts/git-lock-watchdog.sh` only covers the other repo — worth pointing at this one too.
