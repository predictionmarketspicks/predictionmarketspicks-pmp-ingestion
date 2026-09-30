# Cowork: finish the ext-feeds single-Tuesday switch (4 steps)

**Status**: Spec — for Cowork, do before Tue 2026-10-06 09:30 ET
**Date**: 2026-09-30 · **Author**: Claude Code · **Parent**: `handoffs/NFL_EXT_FEEDS_SINGLE_TUESDAY_RUN_2026-09-30.md` (read §6 there — it holds the prompt text)

Claude Code already renamed the cloud routine, fixed skill §1 (`ddf0904`) and re-synced the local skill copy. The steps below need Cowork's own scheduler/app access; Claude Code's API could not do them safely.

## Do exactly this

1. **Replace the prompt of the scheduled task "NFL ext-feeds weekly capture (Tue 9:30 ET)"** (routine `trig_018rtbTAzm5iQBGUp1NTZ9uT`, formerly "Nfl ext feeds run a mon").
   - New prompt = the text inside the ```` ```text ```` block at the end of §6 of the parent handoff, verbatim.
   - Change ONLY the prompt. Keep the schedule (`CRON_TZ=America/New_York 30 9 * * 2` = Tue 09:30 ET), keep it enabled, keep its folders (`/Users/benny/prediction-marketspicks`, `/Users/benny/pmp-ingestion`), device, connectors and permission mode as they are.
   - ✅ Done when: the task's prompt starts with "You are running the **NFL Ext-Feeds Weekly Tuesday Capture**" and contains no "Run A (Monday)" and no "NO free-agency"; next run still shows Tue 10-06 ~09:30 ET.

2. **Disable the scheduled task `nfl-ext-feeds-run-b-wed`** (the local one you moved to Tue 10:00 ET). Disable, don't delete.
   - Why: exactly one Tuesday run. If it fires at 10:00 after the 09:30 routine, four feeds hit `same-week` and its prompt posts four false MISS alerts to `#bot-logs`.
   - ✅ Done when: Scheduled shows it off; `nfl-ext-feeds-run-a-mon` is also still off.

3. **Delete the routine "zz probe - safe to delete (Claude Code 2026-09-30)"** (`trig_01FYppgpX4JLJtCmciShFqtQ`, disabled, never runs). It was a throwaway test; Claude Code has no delete.
   - ✅ Done when: it no longer appears in the routines list.

4. **Update the account skill `nfl-ext-feeds-capture`** (`skill_019YRzAgZv8L5PnueCCpQRPR`) to the repo file `/Users/benny/pmp-ingestion/skills/nfl-ext-feeds-capture/SKILL.md` (318 lines, has the Tuesday §1 table naming `trig_018rtbTAzm5iQBGUp1NTZ9uT`). The account copy is from 09-19 and lacks the week-progress, roster-status and null-density gates; the local synced copy was overwritten by hand and will revert on the next sync unless the account skill changes.
   - If you cannot replace an account skill, say so — Benny does it in claude.ai → Settings → Skills.
   - ✅ Done when: the account skill contains `trig_018rtbTAzm5iQBGUp1NTZ9uT` and "week-progress".

## Don't

- Don't touch any routine's schedule, the skill text, or any other task.
- Don't run a capture now — the next real run is Tue 10-06 09:30 ET.
- Don't `git add`/`commit` anything (Claude Code carries files).

## Report back (one line per step)

`1 prompt replaced ✅/❌ · 2 run-b-wed disabled ✅/❌ · 3 probe deleted ✅/❌ · 4 account skill updated ✅/❌ (or "needs Benny")`

After Tue 10-06: parent handoff §4 SQL should show week **4** for dvoa / power / pgrade and no `same-week` BLOCK rows that morning.
