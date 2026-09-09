# NFL Ext-Feeds: PFF Developer API migration for grades-team/grades-player

**Status**: SHIPPED and CLOSED 2026-09-09. The first live run wrote **preseason** data and was wrong; the code is fixed and the 804 bad rows are deleted. See "Correction" at the bottom, which supersedes the original write-up.
**Date**: 2026-09-09
**Session**: Cowork, triggered by Benny upgrading to a PFF Pro API key mid-session after the scheduled Run B (Wed) capture failed on a Chrome-permission block.

## What changed

Benny generated a PFF Developer API key (`pff.com/account/api-keys`, stored as `PFF_API_KEY` in `.env`, gitignored). Two of the five `nfl-ext-feeds-capture` feeds now pull from `https://api.pff.com` directly instead of Claude-in-Chrome scraping `premium.pff.com`:

- **`grades-team`** ← `GET /v1/teams/overview` (1 call, 32 rows)
- **`grades-player`** ← `GET /v1/facet/{passing,rushing,receiving,field_goal}/summary` + `GET /v2/nfl/teams/{slug}/roster` ×32 for bio (height/weight/age)

New files: `src/lib/pff-api.js` (fetch client), `scripts/capture-pff-api.js` (orchestrator). Both write the same `data/ext-staging/<feed>.json` shape the existing normalizers already read — `src/feeds/ext-shared.js`'s "swappable fetch layer" seam did exactly what its comment promised, no changes needed to `grades-team.js`/`grades-player.js`/`ingest-ext-feeds.js`.

**Ran it live for season 2026** — and this run was wrong; it is kept here only because it explains the rows that had to be deleted. 32 team-grade rows + 772 player-grade rows were captured and ingested (`ext_team_grades` season=2026/REGPO=32, `ext_player_grades` season=2026/week=4=772). **Every one of those numbers was PRESEASON.** See the Correction section at the bottom.

## Coverage gap (confirmed, not a to-do)

The Developer API's full `openapi.json` (70 operations) has no path for PFF's betting/power-rankings product or free-agency — `power-ranks` and `free-agency` are unaffected, still Chrome-only. `dvoa-team` is FTN, a different vendor, also unaffected.

## WAR / college / draft fields — confirmed unused, left null (don't rebuild)

Audited every reader of `ext_player_grades` repo-wide: nothing selects `war`, `war_rank`, `college`, `draft_year`, `draft_round`, `draft_pick`, or `forty` from it. WAR **is** used in the model, but from `ext_free_agents` (`gridiron_edge/src/roster_delta_v2.py::_load_war_lookup`), a feed this change doesn't touch. `war_rank` has zero consumers anywhere. Full reasoning in `skills/nfl-ext-feeds-capture/SKILL.md` §2b.

## Handoff — commit + push needed

Cowork's shell couldn't clear `.git/index.lock` in this session (permission denied on unlink — same class of issue documented for the main site repo's Cowork worktree). Nothing was committed. Run from Claude Code:

```bash
cd /Users/benny/pmp-ingestion
git status --porcelain   # expect: M handoffs/BITCOIN_EDGE_MU_CAP_SATURATION_2026-08-13.md (pre-existing, unrelated — leave it),
                          #         M skills/nfl-ext-feeds-capture/SKILL.md,
                          #         ?? scripts/capture-pff-api.js, ?? src/lib/pff-api.js,
                          #         ?? handoffs/NFL_EXT_FEEDS_PFF_API_MIGRATION_2026-09-09.md
rm -f .git/index.lock     # stale lock from the Cowork session; no live git process holds it
git add scripts/capture-pff-api.js src/lib/pff-api.js skills/nfl-ext-feeds-capture/SKILL.md handoffs/NFL_EXT_FEEDS_PFF_API_MIGRATION_2026-09-09.md
git commit -m "nfl-ext-feeds: capture grades-team/grades-player via PFF Developer API instead of Chrome scrape"
git push
```

Do **not** stage `handoffs/BITCOIN_EDGE_MU_CAP_SATURATION_2026-08-13.md` — that modification predates this session and isn't mine to commit.


---

## Correction (2026-09-09, Claude Code) — the first run captured preseason and labelled it regular season

**What was wrong.** `GET /v1/teams/overview?season=S` and `GET /v1/facet/*/summary?season=S` with no `week` filter return a **preseason-inclusive** aggregate. On 2026-09-09, with zero regular-season games played, season 2026 returned *only* preseason: team records like `3-0` and `1-3`, ARZ at `1-3 / 108 PF`. The `deriveWeek` helper counted those preseason games and stamped `week: 4`.

Measured on a completed season so the contamination is quantified — season 2025, ARZ:

| call | record | games | PF | team grade |
|---|---|---|---|---|
| `?season=2025` (what shipped) | 5-15 | 20 | 402 | 68.0 |
| `?season=2025&week=1,2,…,18` | 3-14 | **17** | **355** | **67.2** |

Three preseason games, 47 points and 0.8 of team grade, on every row. Both consensus readers — `gridiron_edge/scripts/run_consensus.py:73` and `backtest_consensus.py:91` — select `ext_team_grades` on `season` alone, so this would have been consumed as regular-season process grades.

**What changed.**

1. `src/lib/pff-api.js` gains `lastGradedRegWeek(season)` and `regWeekUnion(n)`. The week now comes from `/v1/games`'s `has_stats` flag (monotone in week — 2025 wk1-18 all `true` with scores; 2026 wk1 `false` with null scores), binary-searched in ~5 calls.
2. `scripts/capture-pff-api.js` scopes **every** aggregate to `week=1,2,…,N`. `deriveWeek` is deleted.
3. At `N = 0` the script writes nothing and exits **3** — in September before the opener there is no honest regular-season number to capture.

**A claim in the original that was false:** "`/v1/games` … returns `has_stats:false` even for weeks `teams/overview` already reflects, so it's not a usable signal here." It is a usable signal. `teams/overview` was reflecting *preseason*; `/v1/games` was correctly reporting regular-season Week 1 as unplayed. Corrected in `SKILL.md` §2b too.

**Only the comma-union form works.** `week=1,2` unions correctly (ARZ 20 + 27 = 47 PF, verified). `weeks[]=`, `min_week`/`max_week`, `week_start`/`week_end`, `season_type=REG` and `game_type=REG` are all **silently ignored** and return the contaminated full-season number — it looks like it worked, which is why this got through.

**Verification run.**

```
$ node scripts/capture-pff-api.js --season=2026
[week] regular-season week=0 (derived from /v1/games has_stats)
No regular-season week of season 2026 is graded yet — ... Nothing written.   # exit 3

$ node scripts/capture-pff-api.js --season=2025
[week] regular-season week=18 (derived from /v1/games has_stats)
[grades-team] GET /v1/teams/overview league=nfl season=2025 week=1..18
  wrote data/ext-staging/grades-team.json (32 rows)      # ARZ 3-14, pf 355, ovr 67.2 ✓
  wrote data/ext-staging/grades-player.json (602 rows)   # week stamp 18 ✓
```

**✅ RESOLVED 2026-09-09 — the 804 preseason rows are deleted.** Run by Claude Code on Benny's
instruction after the earlier attempt was blocked:

```sql
delete from ext_team_grades   where season = 2026;   -- 32 rows
delete from ext_player_grades where season = 2026;   -- 772 rows
```

All 804 carried a single ingest timestamp (2026-09-09 10:01:45-46 UTC) — the one bad run, with no
legitimate 2026 data mixed in. Verified after: season 2026 is 0 rows in both tables, and season
2025 is intact at 32 team rows and 415 player rows.

Nothing needs re-running by hand. Once Week 1 is graded,
`node scripts/capture-pff-api.js --season=2026` resolves `week=1` from `/v1/games` on its own; it
refuses with exit 3 until then, so preseason data cannot be re-written by accident.
