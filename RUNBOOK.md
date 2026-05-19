# Commodity Edge V2 Rebuild — Runbook

Quick-reference incantations for the Silver/Gold/Oil/Bitcoin Edge rebuild. The full spec lives in `~/prediction-marketspicks/handoffs/COMMODITY_EDGE_V2_PHYSICAL_MEASURE_REBUILD_2026-05-19.md` — this file is just the cheat sheet.

---

## Open the build session

```bash
cd ~/pmp-ingestion
claude --permission-mode plan
```

First message to Claude Code:

```
Read /Users/benny/prediction-marketspicks/handoffs/COMMODITY_EDGE_V2_PHYSICAL_MEASURE_REBUILD_2026-05-19.md.
Execute Phase 0 then Phase 1. Stop at end of Phase 1 for review.
```

Plan mode = Claude reads, builds a plan, touches nothing until you approve. Hit `Ctrl+G` to edit the plan in your text editor before it runs.

---

## Per-phase prompts

After approving each plan, the next session continues with:

| Phase | Prompt |
|---|---|
| 0 | `Apply the schema migration in the handoff. Verify with: SELECT column_name FROM information_schema.columns WHERE table_name = 'commodity_edge_signals' AND column_name LIKE 'prob_%' OR column_name LIKE 'mu_%';` |
| 1 | `Build src/engine/drift.js, src/engine/vol.js, add probAboveStrikePhysical to src/engine/options.js, wire parallel writes in commodity-base.js. Stop and let me review before deploying.` |
| 2 | `Enforce liquidity gates per handoff Layer 4. Capture quote_age_seconds in src/feeds/kalshi.js. Update confidence-assignment block in commodity-base.js.` |
| 3 | `Build supabase/functions/commodity-edge-settle and the backfill from 2026-05-01. Add pg_cron entry hourly.` |
| 4 | `Extend scripts/backtest-calibration.js with --model v2 flag. Build scripts/validate-v2-vs-v1.js. Run the validation, produce validation-report.md.` |
| 5 | `Add COMMODITY_EDGE_MODEL_VERSION env var to Vercel. Wire it into lib/tools/*-edge.ts. Do NOT flip yet — that's a manual decision once validation passes.` |
| 6 | `Build commodity_edge_calibration update edge function. Weekly cron. Wire engine to read on each snapshot and apply Platt-scaling correction at end of probability chain.` |

---

## After each phase ships — fresh-eyes review

Open a **second** terminal, fresh Claude Code session in `~/pmp-ingestion`:

```
Read /Users/benny/prediction-marketspicks/handoffs/COMMODITY_EDGE_V2_PHYSICAL_MEASURE_REBUILD_2026-05-19.md.
Review the Phase N changes against the acceptance criteria in that section.
Look for math errors, missing edge cases, divergence from the spec, and silent failure modes.
Use `git diff main` to see the changes.
```

No self-review bias. This is the writer/reviewer pattern from your CLAUDE.md.

---

## Validation queries (copy-paste into Supabase SQL editor)

### After Phase 1 — parallel writes are populating
```sql
SELECT commodity, COUNT(*),
       COUNT(prob_physical) AS with_v2,
       ROUND(AVG(prob_physical * 100)::numeric, 1) AS v2_pct,
       ROUND(AVG(options_prob  * 100)::numeric, 1) AS v1_pct,
       ROUND(AVG((prob_physical - options_prob) * 100)::numeric, 1) AS shift_pp
FROM commodity_edge_signals
WHERE snapshot_at > NOW() - INTERVAL '24 hours'
GROUP BY commodity;
```

### After Phase 2 — gates are working
```sql
SELECT commodity,
       COUNT(*) FILTER (WHERE confidence IN ('high','medium')) AS actionable,
       COUNT(*) FILTER (WHERE confidence IN ('high','medium')
                          AND kalshi_volume_24h < 50)          AS leak_low_vol,
       COUNT(*) FILTER (WHERE confidence IN ('high','medium')
                          AND quote_age_seconds > 1800)        AS leak_stale
FROM commodity_edge_signals
WHERE snapshot_at > NOW() - INTERVAL '24 hours'
GROUP BY commodity;
```
Both leak columns must be zero.

### After Phase 3 — settles are flowing
```sql
SELECT DATE(settled_at) AS day, COUNT(*) AS n,
       COUNT(*) FILTER (WHERE pnl_cents > 0) AS wins,
       ROUND(AVG(brier_component)::numeric, 4) AS avg_brier,
       ROUND(SUM(pnl_cents)::numeric / 100, 2) AS pnl_usd
FROM tool_settles
WHERE settled_at > NOW() - INTERVAL '14 days'
GROUP BY 1 ORDER BY 1;
```

### After Phase 4 — A/B validation passes
```bash
cd ~/pmp-ingestion
cat validation-report.md | head -50
```
Required: Brier improvement ≥ 10% per commodity, per-bucket bias < 3pp.

---

## Cutover (Phase 5 manual step)

Only after Phase 4 validation passes:

```bash
# Vercel
vercel env add COMMODITY_EDGE_MODEL_VERSION production
# Enter value: v2

# Fly (engine)
fly secrets set COMMODITY_EDGE_MODEL_VERSION=v2 -a pmp-ingestion

# Trigger redeploy on both sides — Vercel auto, Fly via:
fly deploy -a pmp-ingestion
```

Monitor for 48 hours:
```sql
SELECT commodity, COUNT(*),
       COUNT(*) FILTER (WHERE direction <> 'PASS') AS actionable
FROM commodity_edge_signals
WHERE snapshot_at > NOW() - INTERVAL '6 hours'
  AND model_version = 'v2_physical'
GROUP BY commodity;
```

Expected: actionable count similar to v1 (~30-100/day combined). If it jumps 5×, roll back.

---

## Rollback

```bash
vercel env rm COMMODITY_EDGE_MODEL_VERSION production
vercel env add COMMODITY_EDGE_MODEL_VERSION production
# Enter value: v1

fly secrets set COMMODITY_EDGE_MODEL_VERSION=v1 -a pmp-ingestion
fly deploy -a pmp-ingestion
```

Both v1 and v2 keep writing in parallel forever, so a rollback is just a flag flip. Zero data loss.

---

## Optional: verify Databento GLBX access (Phase 7 prep, only if Brier still has room after 30d)

```bash
cd ~/pmp-ingestion
node scripts/check-databento-permissions.js
```
Reads `DATABENTO_API_KEY` from `.env`, hits metadata.list_datasets, probes cost estimates for SI.OPT / GC.OPT / LO.OPT. Tells you whether GLBX.MDP3 (CME futures options) is enabled on your plan. Pure read, no money spent.

---

## When done

```bash
mv ~/prediction-marketspicks/handoffs/COMMODITY_EDGE_V2_PHYSICAL_MEASURE_REBUILD_2026-05-19.md \
   ~/prediction-marketspicks/handoffs/done/
```

Update `~/prediction-marketspicks/CLAUDE.md`:
- Note the `commodity_edge_signals` schema change (new columns)
- Note the new `commodity_edge_calibration` table
- Note the `COMMODITY_EDGE_MODEL_VERSION` env var
- Update the "Commodity engine pricing" section to reference the v2 model
