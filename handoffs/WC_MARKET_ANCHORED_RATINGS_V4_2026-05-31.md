# WC 2026 — Market-Anchored Ratings (v4 seed)

**Date:** 2026-05-31 · **Repo:** pmp-ingestion · **Branch:** `wc-market-anchored-ratings-v4`
**Status:** Built + validated locally. Awaiting push + PR + nightly-action run (DB write).

## What changed & why

The WC sim's strength ratings were pure Elo (`teams.py`, v2 April calibration). The
`markets.py` header even stated the sim "does NOT use prediction-market or sportsbook
prices to calibrate strength ratings." This phase **deliberately reverses that**: the
ratings are now **market-anchored** so the champion seed is a **50/50 blend** of the Elo
model and the **de-vigged outright-winner market**. This makes the "market-implied
strength ratings" copy genuinely true.

The **algorithm is unchanged** — only the team ratings moved. Determinism (seed=42,
the operator-precedence penalty quirk) is fully intact, so the nightly run reproduces
the new seed exactly.

## Market source

- **DraftKings outright board, operator snapshot 2026-05-31** (full 48-team coverage).
  De-vigged proportionally: overhead 1.1697 → factor 0.8549, sums to 100.
- Cross-checked vs **de-vigged Kalshi KXWORLDCUP champion** (27 teams) — tight agreement
  at the top (Spain/France co-favs, Portugal elevated, Norway dark-horse). Kalshi only
  prices 27 teams, so DK was used for full-field coverage.
- ⚠️ The DraftKings rows in `world_cup_market_latest` are **corrupted for longshots**
  (Sweden 99¢, Austria 66¢, Czechia 40¢ — a Fly-writer entity-mapping bug). They were
  **bypassed** in favor of the hand-verified board. *Separate follow-up: fix that writer.*
- Blend weight **W_MARKET = 0.50** (operator sign-off).

## Seed move (champion %, 10k iters, seed=42)

| Team | v2 model | **v4 market-anchored** |
|---|---|---|
| Spain | 18.6 | **16.7** |
| France | 15.2 | **14.6** |
| England | 12.8 | **12.7** |
| Brazil | 11.0 | **9.6** |
| Argentina | 10.2 | **9.7** |
| Germany | 7.4 | **6.4** |
| Portugal | 5.5 | **6.7** ⬆ |
| Netherlands | 5.1 | **4.8** |
| Norway | 0.1 | **1.1** ⬆ (Haaland dark-horse) |

Champion% sum = 100.10. Top compresses toward the market; Portugal & Norway gain real
title equity. Calibration landed within **0.25pp** of the exact 50/50 target on every
contender.

## Files

- **`scripts/wc/market_anchor.py`** (new) — frozen DK board + de-vig + `W_MARKET`. The
  auditable, repeatable calibration input. Not read at sim time.
- **`scripts/wc/calibrate_ratings.py`** (new) — one-time fixed-point solver. Damped
  Newton step on overall strength (preserving each team's Off−Def differential),
  precise objective + gain annealing + best-state tracking. Re-run to re-anchor.
- **`scripts/wc/teams.py`** — `TEAMS` ratings replaced with v4 values; groups/slugs/
  tri-codes unchanged. New provenance header.
- **`scripts/wc/validation.py`** — `SPOT_CHECKS` set to actual v4 champ% (expected ==
  what the run produces, ±0.5 tol). Docstring updated.
- **`scripts/run-wc-sim.py`** — `sim_run_id` prefix `v3_` → `v4_`.
- **`scripts/wc/supabase_writer.py`** — docstring example bumped to v4.

## Verification done (local, Python 3.9 — reproduces CI 3.11 because the prior committed
seed reproduced exactly here)

```
python3 scripts/run-wc-sim.py --validate-only --no-backdrop --iterations 10000
→ 6 spot checks within tolerance, champion% sum = 100.10,
  match sanity OK (72), player sanity OK (25), EXIT 0
```

## To re-anchor in future

1. Update `DK_OUTRIGHT_AMERICAN` in `market_anchor.py` (and/or `W_MARKET`).
2. `PYTHONPATH=scripts python3 -m wc.calibrate_ratings`
3. Paste its printed `TEAMS` + `SPOT_CHECKS` blocks into `teams.py` / `validation.py`.
4. Bump the `sim_run_id` prefix in `run-wc-sim.py`.

## DEPLOY (operator — there is NO Fly deploy; the WC sim is a GitHub Action)

```bash
cd /Users/benny/pmp-ingestion
git push -u origin wc-market-anchored-ratings-v4
gh pr create --fill --base main
# after merge to main, write the v4 seed to Supabase by triggering the nightly action:
gh workflow run wc-sim-nightly.yml            # full run (DB write)
# or dry-run first:  gh workflow run wc-sim-nightly.yml -f validate_only=true
```

Left to nightly cron (`0 6 * * *`, 02:00 ET) it ships automatically after merge.
Downstream readers (`world_cup_simulation_latest` matview, site WC pages) pick up the
new `v4_<TS>` seed once the run writes + refreshes the matviews.
