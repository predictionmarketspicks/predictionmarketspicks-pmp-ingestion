# NFL ext-feeds — close the half-capture hole (runner gate + watchdog value-probe)

**Status**: SHIPPED ff2a991 (items 1, 4, 5 — pmp-ingestion) · item 2 SHIPPED prediction-marketspicks d67dbc52 (`ext-feeds-freshness.yml` value-presence probe — ran against prod: quiet 32/32 · 32/32 · 32/32 · 578/578; pointed at the DI/ED slice it alerts 288/292 hollow; dispatched run 35649099639 green) · item 3 = Benny (task-prompt text below)
**Author**: Cowork, Run A 2026-09-21

> **Shipped 2026-09-21 (Claude Code):**
> - **Item 1** — `scripts/ingest-ext-feeds.js`: `REQUIRED_COLUMNS` + `NULL_TOLERANCE = 0.10`, pure `nullDensityViolations(feed, rows)`, BLOCK in `--dry` and real runs, `--allow-sparse="<reason>"` (reason mandatory, exit 2 without), `--self-test` (18 checks). The handoff's column names were all exact normalized keys — no correction needed. **One correction to the rule itself, measured on prod:** `ext_player_grades` has no defensive/kicking grade columns, so DI/ED/CB/S/LB/K rows carry all four grades null by construction (648 of the 1,228 week-1 rows); a blanket "≥1 grade per row" rule would have BLOCKED the legitimate 09-18 broad capture. The grades-player rule is scoped to offensive positions (QB/HB/RB/WR/TE/FB/T/G/C — K excluded even though FACETS captures kickers) and the self-test pins a defender row with four nulls as NOT a violation. Verified end-to-end: today's real `dvoa-team.json` passes; the same file with its grade cells blanked to `""` → `BLOCKED — required column(s) mostly null: off_dvoa null on 32/32 rows; …`, exit 1; `--allow-sparse` proceeds with the reason echoed.
> - **Item 4** — SKILL.md §3: Recipe A (Blob intercept), Recipe B (MuiDataGrid, 27 `data-field`s mapped to staging keys, `last_week` = LAST YEAR gotcha, logged-out tell), the `javascript_tool` truncation note, and which context each capture path assumes (Cowork has no `~/Downloads` mount). **SKILL.md §2.1 also said "FTN's DVOA table renders complete and is unaffected [by logout]" — false, corrected in place.** §3's dvoa-team row said "(Export)" — there is no export button; corrected.
> - **Item 5** — the position-scope decision is recorded in SKILL.md §2b under the `grades-player` endpoint, with the 1,228-row explanation and the `ext_team_grades` unit-column follow-on.
>
> **Item 3 — Benny, paste into the Cowork scheduled task for Run A** (replace the two stale lines):
> - Replace `Run A feeds (4): grades-team, grades-player, power-ranks, dvoa-team` with: **"Run A feed list: read `skills/nfl-ext-feeds-capture/SKILL.md` §1 — that list is the source of truth, not this prompt. (As of 2026-09-21 it is five feeds: grades-team, grades-player and roster-status via the PFF Developer API, power-ranks and dvoa-team via Claude-in-Chrome.)"**
> - Replace `using Claude-in-Chrome … confirm he's signed into BOTH premium.pff.com and ftnfantasy.com` with: **"Login check: follow SKILL.md §2 — the PFF API feeds need `PFF_API_KEY`, not a Chrome login; the Chrome login check applies to `pff.com/betting/nfl-power-rankings` and `ftnfantasy.com` only. A logged-out FTN renders all 32 rows with blank grade cells; the runner's null-density gate refuses it, but assert the logged-in state first."**
>
> Verify the gate any time: `node scripts/ingest-ext-feeds.js --self-test` → `SELF-TEST PASS (18 checks)`.
**Repo**: `pmp-ingestion` (items 1, 3, 4, 5) + `prediction-marketspicks` (item 2, workflow only)

---

## What happened on 2026-09-21 Run A

Five feeds. Four landed first pass (`grades-team` 32, `grades-player` 332,
`roster-status` 1634, `power-ranks` 32 — all season 2026, week 1). `dvoa-team`
was **skipped**: `ftnfantasy.com` was logged out. Benny restored the login
mid-run and it landed (32 rows, every column populated, 13:52 UTC).

The skip was correct — SKILL.md §2.1 names this exact case. What matters is
**how close it came to not being a skip.**

FTN logged out does not error and does not thin the table. It renders **all 32
rows and all 27 columns**; `team`, `total_dvoa`, `total_dvoa_rank`, `week`,
`year` carry values and the other 22 are empty strings. The row count — the
number every gate in this system checks — is a perfect 32.

**Verified 2026-09-21**: `ext_team_dvoa` has 30 columns, **5 NOT NULL**. 25
payload columns accept NULL.

```sql
select table_name, count(*) filter (where is_nullable='NO') not_null_cols, count(*) total_cols
from information_schema.columns
where table_name in ('ext_team_dvoa','ext_power_ranks','ext_team_grades','ext_player_grades')
group by 1 order by 1;
-- ext_player_grades 8/28 · ext_power_ranks 5/14 · ext_team_dvoa 5/30 · ext_team_grades 5/21
```

So a 32-row all-blank DVOA ingest **succeeds cleanly**. And every downstream
signal goes green:

| Signal | Would have said |
|---|---|
| `ingest-ext-feeds.js` staleness gate | file written today → PASS |
| dry-run count vs §3 "Expect" | 32 = 32 → PASS |
| runner exit code | 0 |
| `ext-feeds-freshness.yml` recency | today's date → quiet |
| …season rollover | 2026 → quiet |
| …`ext_capture_runs` heartbeat | row written → quiet |
| …week stamping | OK → quiet |

**Nothing in the system asks whether the rows arrived with values.** The
2026-08-03 incident (dead PFF login, six weeks unnoticed) was this same failure
mode; the fixes that followed it hardened *freshness* and *provenance*, which
are different questions. `ext-feeds-freshness.yml`'s own header says detection
must live outside the machine doing the work — it does, and it still cannot see
this.

Today a human caught it. That is the part to fix.

---

## 1. (P1) Null-density gate in `scripts/ingest-ext-feeds.js`

Add a per-feed `REQUIRED_COLUMNS` map and BLOCK when a required column is
null/blank across more than a threshold share of normalized rows. Same
treatment as the existing stale-file and `--season`-mismatch cases: print
`BLOCKED … <feed>: <col> null on N/32 rows`, write nothing, exit 1, in **both**
`--dry` and real runs.

Suggested map (derived from what each feed's paywall actually blanks):

| Feed | Required (non-null on ≥90% of rows) |
|---|---|
| `dvoa-team` | `off_dvoa`, `def_dvoa`, `st_dvoa`, `est_wins`, `wei_dvoa` |
| `power-ranks` | `point_spread_rating`, `sim_avg_wins`, `make_playoffs_pct` |
| `grades-team` | `overall`, `off`, `def` |
| `grades-player` | `off` **or** `pass`/`run`/`recv` (position-dependent — gate on "≥1 grade present per row") |

Threshold, not zero-tolerance: a legitimately blank cell exists (see §4 below —
FTN's LAST YEAR column is `x` on all 32 rows in week 1 and that is correct).
90% catches a paywall, tolerates a genuine gap.

Escape hatch matching house style: `--allow-sparse` with a mandatory reason,
same shape as `--allow-stale`.

Self-test, per the pattern already used across the repo:
`node scripts/ingest-ext-feeds.js --self-test` should assert a synthetic
blank-column fixture BLOCKS and a synthetic good fixture passes.

## 2. (P1) Value-presence probe in `ext-feeds-freshness.yml`

Item 1 guards the machine doing the work; this is the outside observer, and the
workflow's header argues for exactly that split. Add one PostgREST count per
table — rows at the newest `(season, week)` where a required column `is.null` —
and alert when it is a majority. Cheap: one extra request per table, same
`newest()` helper shape already in the file.

Belt and braces on purpose. Item 1 alone would have been enough *today*, but
the 08-03 lapse proves a gate inside the run can be bypassed by a run that
never happens.

## 3. (P2) The scheduled-task prompt has drifted from SKILL.md

The Cowork scheduled task for Run A still says:

- "**Run A feeds (4)**: `grades-team`, `grades-player`, `power-ranks`, `dvoa-team`"
- "using Claude-in-Chrome … confirm he's signed into BOTH `premium.pff.com` and `ftnfantasy.com`"

Both are stale as of the 2026-09-09 PFF API migration. SKILL.md §2b moves
`grades-team` + `grades-player` to the Developer API (no Chrome), and §1 adds
**`roster-status` as a Run A/B feed on every in-season run**. The task prompt
never mentions `roster-status` — a run following it literally captures 4 feeds
and silently drops the fifth. It landed today only because
`capture-pff-api.js` writes it by default and I was reading SKILL.md.

Fix: replace the feed list in the task prompt with a pointer — "the Run A feed
list is SKILL.md §1, not this prompt" — so it cannot drift again. Same for the
login-check line.

## 4. (P2) Record the two DOM extraction recipes in SKILL.md §3

SKILL.md tells the operator to click the CSV button on
`pff.com/betting/nfl-power-rankings`. That lands the file in `~/Downloads`,
which is **not mounted in Cowork's sandbox** (mounts are `prediction-marketspicks`,
`pmp-ingestion`, outputs, uploads) — so from Cowork the documented path is
unreachable. Claude Code, running on the Mac, can read it; Cowork cannot. The
skill doesn't say which context it assumes, and the failure is quiet: the
obvious fallback is the rendered table, which SKILL.md itself calls "a strict
downgrade" (`<1%` → `null` via `pct()`).

**Recipe A — PFF power-ranks CSV without writing a file.** The CSV button
builds a Blob client-side. Hook `URL.createObjectURL`, neutralise the anchor
click, click the button, read the blob as text. Full precision, no download, no
`~/Downloads` dependency. Verified today: ARZ `win_super_bowl_pct` came back
`0.07` where the rendered table shows `<1%`.

```js
window.__blobs = [];
window.__origCOU = URL.createObjectURL.bind(URL);
URL.createObjectURL = (o) => { window.__blobs.push(o); return 'blob:intercepted'; };
const ac = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (this.hasAttribute('download')) return;      // swallow the download
  return ac.apply(this, arguments);
};
[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'CSV').click();
await new Promise(r => setTimeout(r, 2500));
await window.__blobs[0].text();
```

**Recipe B — FTN DVOA has no export button.** It is a MUI DataGrid with no
`<table>` element and no data API (the page is SSR; network shows only
analytics). All 27 cells render per row with stable `data-field` attributes:

```js
[...document.querySelectorAll('.MuiDataGrid-row')].map(r => {
  const m = {};
  for (const c of r.querySelectorAll('.MuiDataGrid-cell')) m[c.getAttribute('data-field')] = c.innerText.trim();
  return m;                                        // 27 fields, team → year
});
```

Field names for the mapping: `team, total_dvoa, total_dvoa_rank,
non_adj_tot_voi, w_l, last_week, offense_dvoa, offense_rank, defense_dvoa,
defense_rank, special_teams_dvoa, special_teams_rank, offense_voa_unadj,
defense_voa_unadj, special_voa_unadj, estim_wins, rank1, wei_dvoa, rank2,
past_schedule, rank3, future_schedule, rank4, var, rank5, week, year`.

Two gotchas worth writing down: `last_week` is FTN's **LAST YEAR** column and
renders `x` for every team in week 1 → omit `last_year_rank`, never write 0.
And the logged-out tell is the header carrying `Log In` / `Sign Up` with the
grade cells empty — cheap to assert before reading anything.

**Operator note**: `javascript_tool` truncates its return at roughly 1,000–1,400
characters. Emit large extractions as pipe-delimited chunks of ~8 rows rather
than one JSON blob, or the tail is silently lost.

## 5. (P3) Record the `grades-player` position-scope decision

Week 1 of season 2026 currently holds **1,228** `ext_player_grades` rows from
two differently-scoped captures: 895 written 09-18 across 15 positions (DI, ED,
CB, S, LB, T, G, C, FB, P, LS…) and 332 written 09-21 across the 5 skill
positions. Nothing was overwritten — the sets are complementary, the upsert key
is `(season, week, player_id, position)` — but a later row count will look
inconsistent with the documented expectation.

`capture-pff-api.js:111-116` `FACETS` is the only thing imposing the skill-position
filter; `src/feeds/grades-player.js` has no position filter at all. The 09-18
capture therefore came from a broader path than today's.

Decision (Benny asked 2026-09-21, answer stands): **leave the filter where it
is.** Audited both repos — nothing reads `ext_player_grades` at all (only the
writer, this workflow, and a lint rule in the site repo that *bans* the string
from `app/`/`lib/`/`content/`). Unit-level composites that do exist
(`gridiron_edge/src/pff_loader.py`, `pff_history_loader.py`) read local PFF
CSVs, not this table, and `ext_player_grades` has no pass-rush/coverage/run-def/
tackling columns to serve them anyway.

Higher-leverage follow-on, if defense is wanted in the model: `ext_team_grades`
already stores `pblk, rblk, prsh, cov, rdef, tack, spec` at team level, captured
free on the same `/v1/teams/overview` call — and **no reader selects any of
them** (`run_consensus.py:73` takes `team,overall`; `backtest_consensus.py:91`
takes `team,overall,pf,pa`). Wiring those is cheaper than expanding the player
capture against the shared 100-reads/min budget. Separate spec if Benny wants it.

---

## Not in scope

- FTN session monitoring as its own job. Items 1+2 detect the *consequence*
  within one run, which is the thing that actually protects the data. A
  login-liveness poller is a bigger build for an earlier warning.
- Anything touching `ext_*` on a public surface. These tables are
  service-role-only and the site repo's `lint:source-mask` hard-fails on the
  table names — unchanged by this spec.
