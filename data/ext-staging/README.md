# External-benchmark staging (NFL grades/DVOA fusion — Phase 1)

INTERNAL-ONLY drop zone for the five external NFL benchmark feeds that calibrate
the Gridiron Edge (DAEPA) model. **This data never faces a user** — not raw, not
as a recognizable re-expression. RLS on the `ext_*` tables is service-role only;
`lib/lint-strings.js` (site repo) bans the vendor strings and any public query of
`ext_*`. Full rule + rationale: `handoffs/NFL_GRADES_DVOA_FUSION_2026-06-20.md`.

## Files

| Staging file | Table | Spec |
|---|---|---|
| `grades-team.json` | `ext_team_grades` | §2b — team process grades |
| `grades-player.json` | `ext_player_grades` | §2a — player grades + WAR |
| `power-ranks.json` | `ext_power_ranks` | §2c — point-spread/QB ratings + 10k-sim probs |
| `free-agency.json` | `ext_free_agents` | §2d — WAR + signing destinations (roster-delta) |
| `dvoa-team.json` | `ext_team_dvoa` | §2e — opponent-adjusted efficiency + variance |

The real `*.json` captures are **gitignored** (raw external data is internal).
Only the `*.example.json` shape templates are committed — copy one to its
`<feed>.json` name and replace the rows.

## Swappable fetch layer

Each `src/feeds/<feed>.js` exposes `fetchOnce()` → normalized rows. Today its
body reads the staging JSON here (a Claude-in-Chrome capture through Benny's
logins, like `gsc-wc-indexing-daily`). Once a licensed export/API is in place,
only `src/feeds/ext-shared.js` `loadStagingRows()` flips to a CSV/API pull — the
normalizers, delivery upserts, and runner stay identical.

## Capture → ingest

1. Capture the season's rows for a feed into `data/ext-staging/<feed>.json` —
   either a bare array of row objects, or `{ "season": 2025, "rows": [...] }`.
   Keys match the `*.example.json` template. Numbers may be raw strings
   (`"18.2%"`, `"$12.5M"`, `"11th/119"`) — the normalizer coerces them; `team`
   may be any spelling (full name / city / nickname), resolved to the
   gridiron_edge code.
2. Dry-run to check normalization + team resolution:
   ```
   node scripts/ingest-ext-feeds.js dvoa-team --season=2025 --dry
   ```
3. Write to Supabase (needs `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`):
   ```
   node scripts/ingest-ext-feeds.js all --season=2025
   ```
   Re-running the same season updates in place (idempotent upsert on each table's
   UNIQUE key). Missing staging files are skipped, not fatal.

## Cadence (Phase 1 = manual backfill; cron is Phase 4)

grades + DVOA weekly in-season / monthly off-season · free-agency daily during
the FA window (Feb–May) else weekly · power-ranks weekly.
