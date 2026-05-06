#!/usr/bin/env python3
"""
WC 2026 nightly Monte Carlo + analytical match/player projection.

Inputs (env):
  SUPABASE_URL                     write target
  SUPABASE_SERVICE_KEY             write key (service role, NOT anon)
  DISCORD_BOT_LOGS_WEBHOOK         optional — posts validation failures
  WC_SIM_ITERATIONS                optional override (default 10000)

Outputs (DB):
  world_cup_simulation             ~600 rows under new sim_run_id v3_<TS>
  world_cup_player_simulation      25 rows
  world_cup_simulation_latest      matview refreshed
  world_cup_player_simulation_latest matview refreshed

Validation gate:
  - Spain/France/England/Brazil/Argentina/Germany champion% within ±0.5pp of seed
  - All 48 champion% sum to 100 ± 0.5
  - Match H+D+A sums to 100 ± 1 per match
  - 25 player rows present, no nulls in required columns
  Failure → Discord alert + sys.exit(1)

CLI:
  python scripts/run-wc-sim.py                            full run, write to DB
  python scripts/run-wc-sim.py --validate-only            validate, no DB writes
  python scripts/run-wc-sim.py --iterations 1000          fast smoke
  python scripts/run-wc-sim.py --seed 42                  override RNG seed (default 42 for reproducibility)
  python scripts/run-wc-sim.py --no-backdrop              skip market backdrop attach
"""
from __future__ import annotations

import argparse
import random
import sys
import time
from datetime import datetime, timezone
from typing import List, Optional

# Make sibling `wc/` package importable when run as `python scripts/run-wc-sim.py`
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from wc.simulator import run_one_tournament, aggregate_team_progression  # noqa: E402
from wc.matches import all_group_matches                                 # noqa: E402
from wc.player_model import project_all_players                          # noqa: E402
from wc.teams import NAME_TO_SLUG                                        # noqa: E402
from wc.validation import validate_all                                   # noqa: E402
from wc.notify import discord_alert                                      # noqa: E402


# ── Probability → American odds conversion ────────────────────────────────────
def pct_to_american(pct: float) -> Optional[int]:
    """Convert a percentage (0-100) to American odds. Returns None for very low pct."""
    if pct is None or pct < 0.5 or pct > 99.5:
        return None
    p = pct / 100.0
    if p >= 0.5:
        return -int(round(100 * p / (1 - p)))
    return int(round(100 * (1 - p) / p))


# ── Row builders ──────────────────────────────────────────────────────────────
def build_team_rows(sim_run_id: str, agg: dict, ran_at_iso: str, backdrop) -> List[dict]:
    """Convert aggregated progression rates into 240 sim rows (48 teams × 5 kinds)."""
    from wc.markets import attach_to_metadata
    from wc.teams import GROUPS
    team_to_group = {t: g for g, members in GROUPS.items() for t in members}

    rows = []
    KIND_MAP = {
        "champion":    "champion",
        "final":       "reach_final",
        "sf":          "reach_sf",
        "qf":          "reach_qf",
        "r16":         "reach_r16",
    }
    for team_name, progression in agg.items():
        slug = NAME_TO_SLUG[team_name]
        entity_id = f"team:{slug}"
        base_md = {"group": team_to_group[team_name]}
        for agg_key, kind in KIND_MAP.items():
            pct = progression[agg_key]
            md = attach_to_metadata(base_md, entity_id, kind, backdrop) if backdrop else base_md
            rows.append({
                "entity_id":         entity_id,
                "kind":              kind,
                "sim_run_id":        sim_run_id,
                "sim_pct":           pct,
                "sim_american_odds": pct_to_american(pct),
                "sim_ran_at":        ran_at_iso,
                "metadata":          md,
            })
    return rows


def build_match_rows(sim_run_id: str, ran_at_iso: str, backdrop) -> List[dict]:
    """Convert analytical match probabilities into 360 sim rows (72 × 5)."""
    from wc.markets import attach_to_metadata
    matches = all_group_matches()
    rows = []
    for m in matches:
        base_md = {
            "home":     m["home_slug"],
            "away":     m["away_slug"],
            "group":    m["group"],
            "matchday": m["matchday"],
        }
        for kind, pct in m["probs"].items():
            md = attach_to_metadata(base_md, m["entity_id"], kind, backdrop) if backdrop else base_md
            rows.append({
                "entity_id":         m["entity_id"],
                "kind":              kind,
                "sim_run_id":        sim_run_id,
                "sim_pct":           pct,
                "sim_american_odds": pct_to_american(pct),
                "sim_ran_at":        ran_at_iso,
                "metadata":          md,
            })
    return rows


def build_player_rows(sim_run_id: str, ran_at_iso: str) -> List[dict]:
    """25 Golden Boot rows. exp_g_total left null for v3 — full MC scorer model is a follow-up."""
    rows = project_all_players()
    for r in rows:
        r["sim_run_id"] = sim_run_id
        r["sim_ran_at"] = ran_at_iso
        r["metadata"] = {}
    return rows


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> int:
    parser = argparse.ArgumentParser(description="WC 2026 nightly sim")
    parser.add_argument("--iterations", type=int,
                        default=int(os.environ.get("WC_SIM_ITERATIONS", "10000")),
                        help="Monte Carlo iterations (default 10000)")
    parser.add_argument("--validate-only", action="store_true",
                        help="Run sim + validation, do NOT write to DB or fetch backdrop")
    parser.add_argument("--seed", type=int, default=42,
                        help="RNG seed (42 reproduces v2_april_2026_seed exactly)")
    parser.add_argument("--no-backdrop", action="store_true",
                        help="Skip market backdrop fetch (faster local runs)")
    args = parser.parse_args()

    sim_run_id = f"v3_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    ran_at_iso = datetime.now(timezone.utc).isoformat()
    print(f"[wc-sim] starting run {sim_run_id} ({args.iterations} iterations, seed={args.seed})")

    # 1. Monte Carlo team progression
    t0 = time.time()
    random.seed(args.seed)
    stages = [run_one_tournament() for _ in range(args.iterations)]
    agg = aggregate_team_progression(stages)
    print(f"[wc-sim] team MC done in {time.time() - t0:.1f}s")

    # 2. Market backdrop (skipped in --validate-only or --no-backdrop)
    backdrop = {}
    if not args.validate_only and not args.no_backdrop:
        try:
            from wc.markets import fetch_market_backdrop
            backdrop = fetch_market_backdrop()
        except Exception as e:
            print(f"[wc-sim] backdrop fetch failed (non-fatal): {e!s}")

    # 3. Build rows
    team_rows = build_team_rows(sim_run_id, agg, ran_at_iso, backdrop)
    match_rows = build_match_rows(sim_run_id, ran_at_iso, backdrop)
    player_rows = build_player_rows(sim_run_id, ran_at_iso)
    print(f"[wc-sim] built {len(team_rows)} team rows, {len(match_rows)} match rows, "
          f"{len(player_rows)} player rows")

    # 4. Validate
    result = validate_all(team_rows, match_rows, player_rows)
    print(f"[wc-sim] validation: {result['summary']}")
    if not result["passed"]:
        msg = f"WC sim {sim_run_id} validation FAILED: {len(result['failures'])} failures"
        print(msg, file=sys.stderr)
        for f in result["failures"]:
            print(f"  - {f}", file=sys.stderr)
        if not args.validate_only:
            discord_alert(msg, sim_run_id=sim_run_id, failures=result["failures"])
        return 1

    # 5. Write (skip in validate-only)
    if args.validate_only:
        print("[wc-sim] --validate-only: no DB writes")
        return 0

    from wc.supabase_writer import insert_simulation_rows, insert_player_rows, refresh_matviews
    n_team = insert_simulation_rows(team_rows)
    n_match = insert_simulation_rows(match_rows)
    n_player = insert_player_rows(player_rows)
    print(f"[wc-sim] wrote {n_team} team + {n_match} match + {n_player} player rows")

    refresh_matviews()
    print(f"[wc-sim] DONE — sim_run_id={sim_run_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
