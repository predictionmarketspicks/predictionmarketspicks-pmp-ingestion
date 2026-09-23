# skills/

The canonical copy of each skill lives here, in git. **Cowork does not read it.**
Cowork loads its own saved account copy of a skill (keyed by name), and nothing
re-syncs that copy when a file here changes.

**If you edit `skills/<name>/SKILL.md`, re-save it as the Cowork account skill in
the same sitting**: open the file in Cowork and save it over the existing skill of
the same name. Otherwise the next scheduled run follows the old instructions.

Why this note exists: on 2026-09-23 Cowork's saved `nfl-ext-feeds-capture` predated
`ff2a991` (2026-09-21): no PFF Developer API path, no `roster-status` feed, no
null-density gate, and the retracted claim that logged-out FTN renders complete.
Run B only avoided acting on it because the session happened to diff the skill
against git (handoffs/NFL_EXT_FEEDS_RUNB_FOLLOWUPS_2026-09-23.md, Problem 1).

Check a resync took: the next Run A/B's `Skill` output should mention the PFF
Developer API, `roster-status` and the null-density gate.
