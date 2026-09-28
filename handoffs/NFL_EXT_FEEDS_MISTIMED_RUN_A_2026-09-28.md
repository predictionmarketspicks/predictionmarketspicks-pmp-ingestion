# ext-feeds: the 02:30 AM Run A that re-ingested week 2 with fresh mtimes

**Status**: SHIPPED (pmp-ingestion, this commit) — week-progress gate live, skill doc updated. Two items for Benny in §5.
**Date**: 2026-09-28 · **Author**: Claude Code
**Trigger**: Benny: files under `data/ext-staging/` written 02:29–02:33 ET with week-2 content while we are in week 3; `ext_team_grades` re-ingested at 06:33:58Z with ARI `1-1`; `roster-status.json` present but undocumented.

---

## 1. What actually ran (evidence, not inference)

| Time (ET, 2026-09-28) | Evidence | Meaning |
|---|---|---|
| 02:29:33 → 02:33:43 | `data/ext-staging/{grades-team,roster-status,grades-player,dvoa-team,power-ranks}.json` mtimes, in that order, minutes apart | A driven capture in the skill's feed order — not a file restore (a restore writes all files in one second) |
| 02:30:13 · 02:30:19–24 · 02:32:19 | Chrome history (`~/Library/Application Support/Google/Chrome/Default/History`): `premium.pff.com/nfl/teams/2026/REGPO`, `ftnfantasy.com/stats/nfl/team-total-dvoa`, `pff.com/betting/nfl-power-rankings`, each with a Clerk `session-token-expired` handshake that re-issued a `tier: pro` session | The skill's §2 login check and the two browser recipes ran, logged in |
| 06:33:59Z … 06:34:02Z | `ext_capture_runs`: five heartbeat rows, one per feed, `source=manual`, 32/387/32/32/1636 rows written | The real ingest ran feed-by-feed, exactly as §5 of the skill says |
| 06:10Z on 09-14 and 09-21; 09:03Z + 11:31Z on 09-23 | earlier `ext_capture_runs` / `ingested_at` rows | **Every Run A has fired at ~02:10–02:33 ET, and Run B at 05:03/07:31 ET** — never at the 11:00 AM the skill's cadence table states |

Not involved: launchd (`launchctl list` — no ext/ingest/capture job; the three plists matching "capture" are the CLV jobs), crontab (silver-tracker only), `.pmp-git-lock-watchdog/` (does not exist in either checkout; `com.pmp.git-lock-watchdog` only clears `.git/index.lock`), and `/Users/benny/pmp-cowork-stranded-backup-2026-09-27/` (a 16:58 Sep-27 snapshot of `app/ docs/ handoffs/ lib/ public/` from the worktree refresh script — site repo, nothing ingestion-related, no process reads it).

The actor is the Cowork scheduled task running the **synced** copy of this skill (`~/.claude/skills/synced/…/nfl-ext-feeds-capture/SKILL.md`, dated 2026-09-19, 153 diff lines behind the repo copy of 2026-09-21: it lacks the roster-status section, the FTN logged-out correction and the null-density guard). No Claude Code transcript on this Mac visited those pages; Cowork transcripts are not on disk.

## 2. Why the content was week 2 — and why that is the design, not a replay

`scripts/capture-pff-api.js` resolves the week from PFF's own `/v1/games` and takes the last **fully** graded regular-season week (`every(has_stats)`). At 02:30 Monday, week 3's Sunday games were hours old and MNF unplayed, so the API said **2**, and every aggregate was scoped `week=1..2`. The 387 player rows therefore match the week-2 rows already in the table because they ARE the week-2 rows, re-fetched. `roster-status` rows are stamped with the same week label. The browser feeds were the same story on the vendor side: FTN's DVOA table and PFF's power rankings still showed week 2 at 02:30 Monday.

This is not a lost week: `ext_team_grades` is one REGPO row per team, upserted on `(season, week_scope, team)`, and the table has never held week 3 (`max(games from record) = 2`, all 32 rows `ingested_at 06:33Z`). It holds exactly what Run B wrote on 09-23, rewritten in place.

## 3. What was silent, and what now shouts

Both existing gates passed by construction: the files were captured today (staleness gate) and 32/32 dense (null-density gate). Nothing compared the capture's week with the table's.

**Week-progress gate (`scripts/ingest-ext-feeds.js`, real runs):** the capture's week (staging header `week`, now written by `capture-pff-api.js` for all three API feeds; else max row week; for `grades-team` games played from `record`) against what the table holds for the season. Lower → `BLOCKED (regression)`. Equal → `BLOCKED (same-week)` unless `--allow-same-week="<why>"`. `roster-status` is exempt from the equal rule (moving feed), `free-agency` from both (no week). Every block posts to `#bot-logs` and fails the run (exit 1), so an unattended Cowork run can no longer report success on a no-op. Proven against today's files:

```
$ node --env-file-if-exists=.env scripts/ingest-ext-feeds.js grades-team
  grades-team: BLOCKED (same-week) — capture is week 2 and the table already holds week 2 — nothing new. …
$ node --env-file-if-exists=.env scripts/ingest-ext-feeds.js dvoa-team
  dvoa-team: BLOCKED (same-week) — …
```

Self-test: `node scripts/ingest-ext-feeds.js --self-test` → `SELF-TEST PASS (31 checks)` (18 null-density + 13 week-progress).

## 4. ext_team_grades needs no manual fix — verified

The upsert key is `(season, week_scope, team)` (`src/delivery/ext-feeds.js:24`), one row per team, so the next successful `grades-team` ingest with `week ≥ 3` overwrites all 32 rows in place. The next such capture is whenever PFF's API reports week 3 fully graded — after MNF is graded, i.e. **Tuesday morning ET or Run B Wednesday** — and the gate will let it through because 3 > 2. Verify after it lands: `select max(split_part(record,'-',1)::int + split_part(record,'-',2)::int) from ext_team_grades where season=2026` → 3, and ARI reads `1-2`. Same for `ext_player_grades` week 3 (new rows, keyed on week) and the two browser feeds.

## 5. Benny

1. ~~Fix the scheduled task's time.~~ **DONE 2026-09-28 (Claude Code):** Run A is the cloud routine `trig_018rtbTAzm5iQBGUp1NTZ9uT` (the local Cowork task `nfl-ext-feeds-run-a-mon`, cron `0 2 * * 1`, was migrated to it on 09-24 — that is where 02:00 ET came from), now `CRON_TZ=America/New_York 30 9 * * 2` = **Tuesday 09:30 ET**. Its prompt still says "Run A (Monday)"; harmless, the skill file is authoritative. Run B is still the LOCAL Cowork task `nfl-ext-feeds-run-b-wed` at `0 3 * * 3` (03:00 ET Wed) — data is graded by then, but it is not the 11:00 the skill says; change it in Cowork if you want them aligned. Original ask: It fires Mondays ~02:00–02:30 ET and Wednesdays ~05:00–07:30 ET (§1 table). Nothing is graded that early on Monday. Set Run A to **Tuesday ≥ 09:00 ET** (MNF graded, DVOA + power rankings posted) — or keep Monday 11:00 AM ET knowing only the browser feeds can move — and Run B Wednesday 11:00 AM ET. The skill's §1 table now says what a Monday run can and cannot return.
2. **Re-sync the skill to claude.ai.** The synced copy is the 09-19 version; the repo copy carries the 09-21 corrections (FTN logged-out shape, null-density gate, roster-status cadence) and now the week-progress gate. Until it is re-synced, Cowork runs the stale procedure. (`handoffs/NFL_EXT_FEEDS_RUNB_FOLLOWUPS_2026-09-23.md` already asked for this.)

Also done on request: `.env.bak-preswap`, `.env.bak.20260828154700`, `.env.bak2.20260828154808` deleted after confirming the live `.env` (2026-09-09) carries every key the backups had and differs only on the two rotated values (`DISCORD_BOT_TOKEN`, `ODDS_API_KEY`).
