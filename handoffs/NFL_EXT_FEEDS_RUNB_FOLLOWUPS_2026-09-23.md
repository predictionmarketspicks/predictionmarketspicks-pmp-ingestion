# NFL Ext-Feeds — Run B (Wed) Follow-ups — 2026-09-23

**Status: data pipeline is healthy, nothing to fix there.** This handoff is two tooling/process
gaps a Cowork run (this one) surfaced while verifying Run B, not a data-capture bug. Route to
Claude Code because both fixes need local access (Cowork's device bridge can observe but not fix
either one).

## Context — what today's run actually found

Scheduled Run B fired 2026-09-23 15:04 UTC (11:04am ET). By then all 5 feeds + `roster-status`
were *already* captured and ingested for season 2026 / week 2 — someone ran an ad-hoc capture
~5:03am and ~7:31am ET, ahead of the scheduled slot. Verified directly against Supabase
(`svxqipncfupabpvxtlro`), not just trusted the staging files:

| feed | rows | ingested_at (UTC) |
|---|---|---|
| grades-team | 32/32 | 2026-09-23 09:02:59 |
| grades-player | 387 | 2026-09-23 09:03:00 |
| roster-status (`ext_player_status`) | ~1,610 | 2026-09-23 09:03:01 |
| power-ranks | 32/32 | 2026-09-23 11:31:50 |
| dvoa-team | 32/32 | 2026-09-23 11:31:51 |
| free-agency | 396 new / 482 total | 2026-09-23 11:31:55 |

Re-ran `--dry` against the live `scripts/ingest-ext-feeds.js` for all 5 feeds (all normalized
clean, exit 0, no `BLOCKED`) and `node scripts/ingest-ext-feeds.js --self-test` (18/18 passed).
Did **not** re-scrape or re-run the real ingest — everything already matched, and redoing it would
just burn PFF/FTN pageviews for identical data. No Discord alert was needed or sent.

The two problems below are about the *tooling* a Cowork run depends on, surfaced only because this
run happened to cross-check things it didn't strictly need to.

---

## Problem 1 — Cowork's saved `nfl-ext-feeds-capture` skill is stale

**Symptom:** Cowork's `Skill` tool loads a synced copy from
`/root/.claude/skills/synced/.../nfl-ext-feeds-capture/SKILL.md` that does **not** match the
canonical file in this repo at `skills/nfl-ext-feeds-capture/SKILL.md` (current as of commit
`ff2a991`, 2026-09-21). The synced copy is missing everything commit `ff2a991` (and `e81a950`,
`1a4abe4`) added:

- §2b — `grades-team`/`grades-player` now pull from the PFF Developer API (`scripts/capture-pff-api.js`), not a Chrome scrape.
- The `roster-status` feed entirely (writes `ext_player_status`, shares the roster pass with `grades-player`).
- The null-density `REQUIRED_COLUMNS` gate, `--self-test`, `--allow-sparse="<reason>"`.
- The correction that a logged-out FTN is **not** safe (`§2.1` used to say it renders complete; it doesn't — 22 of 27 columns blank).
- Recipe A (PFF power-ranks CSV via Blob intercept) and Recipe B (FTN DVOA via MuiDataGrid read) — the actual DOM extraction methods now in use.
- The `--season` flag now being actively dangerous to pass (the staging file's own `season` wins; a mismatch hard-errors instead of silently overwriting).

**Why it matters:** a scheduled Run A/B session that trusts the stale copy would try to Chrome-scrape
two feeds that no longer need it, skip `roster-status` entirely, misread `BLOCKED` output, or (worst
case) re-introduce the FTN logged-out half-capture the null-density gate exists to catch. Today's run
only avoided this because it happened to diff the loaded skill against git log and re-read the repo's
actual `skills/nfl-ext-feeds-capture/SKILL.md` — that's not something to rely on happening every time.

**Solution — not a code fix, a Cowork resync:**

1. The current file content was already extracted and delivered to Benny as a chat file
   (`nfl-ext-feeds-capture-SKILL.md`, byte-for-byte from this repo's
   `skills/nfl-ext-feeds-capture/SKILL.md`).
2. Benny opens that file card in Cowork and saves it over the existing `nfl-ext-feeds-capture`
   account skill (Cowork skills are keyed by name, so this replaces the stale one wholesale).
3. No repo change needed — the repo's copy was already correct.
4. **Standing gap to close:** nothing currently re-syncs Cowork's account skill when
   `skills/nfl-ext-feeds-capture/SKILL.md` changes in the repo. Worth deciding whether that's a
   manual step to remember after every edit to that file, or worth a short note added to this
   repo's own contribution checklist (e.g. "if you touch `skills/*/SKILL.md`, re-push the account
   skill in Cowork").

**Verify:** next scheduled Run A/B firing's `Skill` tool output should mention the PFF Developer
API path, `roster-status`, and the null-density gate. If it doesn't, the resync didn't take.

---

## Problem 2 — the local "Control Chrome" bridge on benjamins-mini is half-broken

**Symptom:** during today's run, `mcp__remote-devices__Control_Chrome__list_tabs`,
`get_current_tab`, and `switch_to_tab` all worked and correctly reflected Benny's real Chrome
(confirmed by seeing his actual open tabs — Mercury, Buffer, GSC, the PFF free-agency and FTN
tabs, etc. — this is the real, logged-in browser, not an isolated automation profile). But on the
**same server, same session**, both `get_page_content` and `execute_javascript` failed immediately:

```
Error: Google Chrome is not running. Please launch Chrome and try again.
```

Reproduced on two different tabs, and again after explicitly `switch_to_tab`-ing to make one of
them active — not a one-off race. Chrome was demonstrably running (tab listing worked throughout).
By the end of the session the entire `mcp__remote-devices__*` bridge (all 131 tools, not just
Control Chrome) had disconnected.

**Why it matters:** `power-ranks` (Recipe A, Blob-intercept CSV read) and `dvoa-team` (Recipe B,
MuiDataGrid read) both depend on `execute_javascript`/page-content reads working, not just tab
control. If a future Run A/B actually needs a fresh Chrome-based capture while this bridge is in
this state, it'll *look* connected (tabs list fine) but fail on the step that matters, which is a
worse failure mode than an outright disconnect because it's not obviously broken at a glance.

**Root cause:** unknown from Cowork's side — this lives in whatever local MCP server / native host
backs "Control Chrome" on benjamins-mini, not in this repo's code. Handing off the repro rather
than a diagnosis.

**Solution / next steps for Claude Code (local shell access needed):**

1. Find how "Control Chrome" is registered as a local MCP server (Claude desktop app's local MCP
   config, or wherever it's defined) and check its process/logs for what happened around
   2026-09-23 ~15:10–15:20 UTC.
2. The surfaced error text is almost certainly generic/wrong — Chrome was running. More likely a
   broken CDP/`chrome.debugger` attach specifically for the content-reading path (tab listing
   probably uses the lighter `chrome.tabs` API, which doesn't need that attach). Check whether
   Chrome needs to be launched with a remote-debugging flag, or whether something else is holding
   the debugger port.
3. After a fix, sanity-check with a minimal call (`execute_javascript` returning `document.title`
   on an open tab) before trusting it for a real capture.
4. If it can't be fixed quickly, the practical fallback for the next Run A/B is: capture
   `power-ranks`/`dvoa-team`/`free-agency` requires a working Chrome bridge — if it's still down,
   skip those three, alert (§7 in the skill), and land the two API-based feeds
   (`grades-team`/`grades-player`) plus `roster-status` only, per §1's own note that per-feed
   independence is fine.

**Verify:** ask a Cowork session (or whatever local tool has equivalent access) to run
`execute_javascript` against any open tab and confirm it returns instead of erroring.

---

## Problem 3 (low priority, not blocking) — `free-agency.example.json` has drifted from what's actually captured

**Symptom:** today's real `data/ext-staging/free-agency.json` uses `war_rank: "#30 ED"` (string)
and `history[].year` / `history[].position_rank`, while
`data/ext-staging/free-agency.example.json` still shows `war_rank: 11` (bare number) and
`history[].season` / `history[].pos_rank`.

**Not a functional bug** — confirmed in `src/feeds/free-agency.js`: `war_rank` goes through
`int()`, which regex-extracts the first run of digits regardless of surrounding text (`"#30 ED"` →
`30`), and `history` is stored as a raw jsonb passthrough with no key validation at all. Ingest
works fine either way.

**Solution:** whenever convenient, update `data/ext-staging/free-agency.example.json` to match
what the current capture method actually produces, so it stays a trustworthy reference for anyone
(human or agent) building a capture from it fresh. Not urgent — nothing downstream is broken by the
drift today.
