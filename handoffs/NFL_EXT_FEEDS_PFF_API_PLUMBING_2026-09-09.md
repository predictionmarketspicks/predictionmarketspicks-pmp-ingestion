# NFL Ext-Feeds — PFF API Plumbing: Handoff (2026-09-09)

Follow-up to `NFL_EXT_FEEDS_PFF_API_MIGRATION_2026-09-09.md` (commit `621d3fe`,
which added the PFF Developer API path for `grades-team`/`grades-player` and
fixed the preseason-contamination bug). Benny asked for a deep-dive on
everything that migration touches before wiring it in further ("let's fix
your plumbing too... deep dive all the places it touches"). This doc is the
result: every problem found, what's fixed vs. still open, and exact next
steps for whoever (Claude Code session or Benny) picks this up next.

**Read this before touching anything below `data/ext-staging/{grades-team,grades-player}.json`,
`src/lib/pff-api.js`, `scripts/capture-pff-api.js`, or the ext-feeds skill.**

## Status at a glance

| # | Problem | Status |
|---|---|---|
| 1 | Scheduled skill still pre-migration (the real "plumbing" gap) | **NOT FIXED** — needs Benny |
| 2 | `.env.example` missing `PFF_API_KEY` | Fixed, **staged, not committed** |
| 3 | Zero test coverage on the PFF API code | Partially fixed, **staged, not committed** |
| 4 | vitest couldn't run at all in the Cowork device sandbox | Fixed, **staged, not committed** (package-lock.json) |
| 5 | `git commit`/`git push` refused by the Cowork auto-mode classifier | **NOT FIXED** — blocks 2/3/4 from landing |
| 6 | Recurring stale `.git/index.lock` | Fixed for this occurrence only |
| 7 | `~/.pmp-git-lock-watchdog` — unexplored, access denied | **UNKNOWN** — needs Benny or a local session |

Nothing here is destructive or in a bad state — the repo's working tree is
exactly as it was, plus three files staged (`git status` shows them as
`M`/`A`, nothing committed). Reading this doc and running `git status` should
match section 5 below before you do anything else.

## 1. The scheduled skill never picked up the PFF API path (the actual plumbing gap)

The repo's tracked `skills/nfl-ext-feeds-capture/SKILL.md` was updated
correctly in `621d3fe`: new §2b section (full API/endpoint writeup), a new
§2 preflight step 0, and the §3 feed table rows for `grades-team`/
`grades-player` now point at the API instead of `premium.pff.com`.

But the skill Cowork actually loads at the start of a scheduled Run A/B —
the "synced" copy, not this repo file — is still **word-for-word the
pre-migration version**. Confirmed by direct line-by-line comparison on
2026-09-09: no §2b anywhere, §2 preflight opens straight on the Chrome-login
check with no step 0, §0's hard-rules bullet still says the only secrets are
`SUPABASE_URL`/`SUPABASE_SERVICE_KEY` (no `PFF_API_KEY` mention), and the §3
table still lists the old `premium.pff.com/nfl/teams/{SEASON}/REGPO` /
`premium.pff.com/nfl/positions/...` URLs for both feeds.

**Impact:** until this resyncs, every scheduled Run A/B — including any that
already ran today — captures `grades-team`/`grades-player` the old
Chrome-scrape way regardless of how correct `capture-pff-api.js` is. The API
code being solid doesn't matter if nothing invokes it.

**This is not a repo-commit fix.** I have no tool from a Cowork cloud session
that can force a skill resync. Benny needs to find whatever mechanism
re-syncs a repo-tracked skill (`skills/<name>/SKILL.md`) into his loaded
Cowork skill library — a settings page, a re-add of the skill, or however
that pipeline works — and trigger it.

**How to verify it's actually fixed** (don't take "I re-synced it" on faith,
verify): have a session load the `nfl-ext-feeds-capture` skill and check the
returned text for the string `§2b` or `PFF Developer API`. If it's not
there, the sync didn't take and Run A/B will still hit Chrome for these two
feeds.

## 2. `.env.example` was missing `PFF_API_KEY`

Every other secret this repo uses is documented in `.env.example`; this one
silently wasn't, since 2026-09-09's migration commit only ever needed it in
the real (gitignored) `.env`. Fixed by inserting, right after `ODDS_API_KEY`:

```
# PFF Developer API (Pro account key — generate at pff.com/account/api-keys)
# Powers grades-team + grades-player captures via scripts/capture-pff-api.js.
# power-ranks, free-agency, and dvoa-team have no Developer API coverage and
# still require the Claude-in-Chrome login path — see
# skills/nfl-ext-feeds-capture/SKILL.md §2b.
PFF_API_KEY=
```

**Status: staged, not committed** (see §5).

## 3. `src/lib/pff-api.js` / `scripts/capture-pff-api.js` had zero test coverage

The exact code that produced this morning's 804-row preseason-contamination
incident (see the migration doc) had no automated coverage at all — its only
verification, before and after the fix, was one manual run. `test/feeds.ext.test.js`
predates the migration and only exercises the normalizer layer
(`ext-shared.js`, `grades-team.js`, `grades-player.js`), which the migration
never touched.

Added `test/lib.pff-api.test.js` — 15 tests, all passing:

- `regWeekUnion` — builds the comma-joined `1..N` list (the only query form
  the API honors).
- `packedHeightToFeetInches`, `ageFromBirthDate` — the small bio-parsing
  helpers.
- `pffGet` — sends the bearer token correctly; retries once on 429 honoring
  `Retry-After`; throws a pointed error carrying `status`/`code`/`requestId`
  on a non-429 failure; throws cleanly when `PFF_API_KEY` is unset.
- `lastGradedRegWeek` — the actual bug-fix logic: returns 0 before week 1 is
  graded (the exact pre-kickoff case that caused the incident), returns 18
  when the full season is graded, finds a mid-season boundary by binary
  search in well under 18 calls, finds week 1 as the boundary when only week
  1 is graded.

Ran in isolation and as part of the full suite: **45 files / 599 tests, all
green.**

**Still not covered:** `capture-pff-api.js`'s own field-mapping
(`captureGradesTeam`, `captureGradesPlayer`, the `FACETS`/`GRADE_KEYS`/
`IDENTITY_KEYS` extraction logic). It's a script entrypoint (`main()` runs on
import, nothing is exported), not an importable module, so it can't be unit
tested without either refactoring it or spinning up a subprocess with mocked
network. **Suggested follow-up:** export `captureGradesTeam` and
`captureGradesPlayer` from `capture-pff-api.js` (guard `main()` behind an
`if (import.meta.url === ...)` check the way some of this repo's other
scripts already do, if any — check first) and add mocked-fetch tests
mirroring the pattern in `test/lib.pff-api.test.js`'s `pffGet` block.

**Status: staged, not committed** (see §5).

## 4. vitest couldn't run at all in the Cowork device sandbox

First attempt to run the new test file failed immediately, before any test
executed:

```
Error: Cannot find native binding. npm has a bug related to optional
dependencies (https://github.com/npm/cli/issues/4828).
Cannot find module '@rolldown/binding-linux-arm64-gnu'
```

This is a Cowork-sandbox-specific issue (the device's shell runs Linux
arm64; `node_modules` apparently didn't have that platform's optional native
binding installed) — nothing to do with this repo's code. Fixed with a plain
`npm install` (no flags beyond `--no-audit --no-fund`, no deleting
`node_modules` or `package-lock.json` first — that's what the error message
suggests but it's a bigger hammer than was needed here and would risk
resolving to different versions). It emitted some harmless `EPERM: operation
not permitted, unlink` warnings during its cleanup phase (the Cowork device
sandbox can't delete files without an explicit one-time grant — see §6) but
still completed ("added 2 packages") and fixed the binding.

Side effect: `package-lock.json` picked up a 30-line diff, entirely
`"libc": [...]` metadata keys dropping out of several optional-dependency
stanzas (probably an npm-version lockfile-normalization difference). No
resolved package versions changed — confirmed by re-running the full suite
after: still 45 files / 599 tests green.

**If this error recurs in a future Cowork session:** just run `npm install`
again first. Don't reach for deleting the lockfile/node_modules.

**Status: staged, not committed** (see §5).

## 5. `git commit` / `git push` refused by the Cowork auto-mode classifier

After clearing the stale index lock (§6), `git add .env.example
package-lock.json test/lib.pff-api.test.js` succeeded cleanly — `git status
--short` showed `M .env.example`, `M package-lock.json`, `A
test/lib.pff-api.test.js`, exactly as expected.

Committing did not work. Two attempts, both refused outright by "the Claude
Code auto mode classifier" with no content-specific reason given (not a git
error — a permission-layer block before git even ran):

1. `git commit -m "..." && git push origin main` — refused.
2. `git commit -m "..."` alone (no push) — also refused.

Per the tool's own guidance on a denial like this, a Cowork session
shouldn't keep retrying variations to work around it — so I stopped after
the second attempt rather than trying `--no-verify`, scripting around it, or
anything else.

**Current real state of the repo right now:** the three files above are
staged (in the index) in `~/pmp-ingestion`. Nothing else in the working tree
is touched. (Don't assume `621d3fe` is HEAD when you check it yourself —
`git log --oneline -1` showed `965d596`, an unrelated bitcoin-edge commit,
already ahead of it on `main`. Unrelated to this work, just don't be thrown by it.)

**How to actually get this committed:**

- Simplest: from an actual terminal on the Mac (not through Cowork), `cd
  ~/pmp-ingestion && git status` to confirm the three files are still
  staged, then just `git commit` and `git push origin main` directly. No AI
  needed for this part — the files are already staged and verified working.
  Suggested commit message (reuse or rewrite):

  ```
  nfl-ext-feeds: test coverage for pff-api.js + document PFF_API_KEY

  .env.example never got a PFF_API_KEY entry when 621d3fe added the PFF
  Developer API path. Added it with a pointer to SKILL.md §2b.

  src/lib/pff-api.js and scripts/capture-pff-api.js had zero test
  coverage — added test/lib.pff-api.test.js covering the binary-search
  week resolution, the week-union query builder, and pffGet's 429
  retry/backoff. 15 tests, all passing; full suite still green (45
  files / 599 tests). capture-pff-api.js's own field-mapping is still
  untested (script entrypoint, not an importable module) — see
  handoffs/NFL_EXT_FEEDS_PFF_API_PLUMBING_2026-09-09.md §3.

  Incidental package-lock.json churn from an `npm install` needed to
  fix a broken vitest native binding in the Cowork device sandbox — no
  resolved versions changed.
  ```

- If you want a Cowork/Claude Code session to be able to commit on this
  device going forward: check whatever auto-mode / permission settings
  govern git-write commands for this linked device or session. This wasn't
  a one-off fluke — see §7, the same classifier also refused a folder-access
  request in the same session. Worth confirming nothing is set more
  restrictively than intended.

**If you're a Cowork/Claude session reading this before it's resolved:**
`git add` works fine in this sandbox. `git commit` and `git push` did not,
as of 2026-09-09. Don't burn attempts blindly retrying — flag it to Benny
and move on to other work, per standard practice for a denied action.

## 6. Recurring stale `.git/index.lock`

Same known issue documented elsewhere in this repo's history (device_bash
sandboxes can't unlink files in a mounted folder without an explicit
one-time grant). Hit again today: a 0-byte `.git/index.lock` blocked `git
add` outright (`fatal: Unable to create '.../.git/index.lock': File
exists`). Fixed for this occurrence by requesting delete permission for
`~/pmp-ingestion` (Benny approved it in-session) and running `rm -f
.git/index.lock`, after which `git add` worked immediately.

This is a recurring environmental quirk, not a one-time fluke — see §7.

## 7. `~/.pmp-git-lock-watchdog` — found, not inspected, access denied

While chasing §6, `get_device_info` listed a home-directory entry named
`.pmp-git-lock-watchdog` (alongside the connected folders, under
`homeDirectories`). The name strongly suggests a previous attempt — by
Benny or an earlier session — at a permanent fix for exactly the recurring
lock problem in §6 (a launchd job, a script, something that clears stale
locks automatically).

Requested folder access to look inside it; **the request was denied by the
same Cowork auto-mode classifier as §5**, before it ever reached Benny as an
approval prompt. So as of this doc: completely unknown what's in that
folder, whether it's installed, running, or effective — the lock in §6
recurred today regardless, so if it exists it either isn't running or isn't
sufficient.

**Action needed:** Benny (or a Claude Code session running directly on the
Mac with normal filesystem access, not through the Cowork device bridge)
should open `~/.pmp-git-lock-watchdog` directly and figure out what it is —
reuse it, fix it, or delete it if it's dead weight. Don't let another Cowork
session keep re-requesting access to it; that path is blocked at the
classifier level, not a per-request thing.

## 8. Recap — the underlying PFF API migration itself

Not re-litigated in full here; see `NFL_EXT_FEEDS_PFF_API_MIGRATION_2026-09-09.md`
for the complete original writeup. Confirmed independently during this
deep-dive (not just taken on the migration doc's word):

- The "swappable staging layer" claim is real. Read `src/feeds/ext-shared.js`,
  `grades-team.js`, `grades-player.js` directly — `loadStagingRows()` just
  reads whatever JSON is at `data/ext-staging/<feed>.json`; the normalizers
  have no idea whether Chrome or the API wrote it, and none of the three
  files were touched by the migration.
- The preseason-contamination fix (binary-searched week via `/v1/games`
  `has_stats`, explicit `week=1,2,...,N` union, hard refusal at week 0) is
  correctly implemented in the current `src/lib/pff-api.js` / `scripts/capture-pff-api.js` —
  and is now the thing `test/lib.pff-api.test.js` actually exercises, so a
  future regression here won't need another manual run to catch.
- The coverage boundary is permanent, not temporary: `power-ranks` and
  `free-agency` aren't in the PFF Developer API at all (checked against the
  full `openapi.json`), and `dvoa-team` is a different vendor (FTN) entirely.
  These three stay Chrome-only no matter what happens with §1.
- Data tradeoffs on the two covered feeds are real but apparently
  inconsequential: `war`/`war_rank`/`college`/`draft_round`/`draft_pick`/
  `forty`/`rs` all come back null via the API path. The migration's own
  repo-wide grep found no downstream reader of those columns on
  `ext_player_grades`. I could not independently verify the named
  downstream consumers (`gridiron_edge/scripts/run_consensus.py`,
  `backtest_consensus.py`, `roster_delta_v2.py`) myself — `gridiron_edge`
  isn't part of this repo and isn't a folder connected to the Cowork session
  that did this deep-dive, so that part rests on the migration author's own
  audit, not independent confirmation.

## 9. Action checklist, in order

1. From a real terminal on the Mac: `cd ~/pmp-ingestion && git status` —
   confirm the three staged files from §2–4 are still there, then commit
   (message above) and `git push origin main`.
2. Check Cowork/Claude's auto-mode or permission settings for this linked
   device/session — figure out why `git commit`/`git push` and a
   home-directory folder-access request were both refused at the classifier
   level in the same session (§5, §7). Adjust if it's more restrictive than
   intended.
3. Open `~/.pmp-git-lock-watchdog` directly and decide what to do with it
   (§7).
4. Get the loaded `nfl-ext-feeds-capture` skill resynced from this repo's
   `skills/nfl-ext-feeds-capture/SKILL.md`, then verify per §1's recipe
   (look for "§2b" in what actually loads) before trusting the next
   scheduled Run A/B to use the API path.
5. Optional follow-up: export `captureGradesTeam`/`captureGradesPlayer` from
   `capture-pff-api.js` and add field-mapping unit tests (§3).
6. Once §4 is confirmed, let the next scheduled Run A/B exercise the API
   path live for `grades-team`/`grades-player` and verify the written rows
   in Supabase the way SKILL.md §5 already describes.
