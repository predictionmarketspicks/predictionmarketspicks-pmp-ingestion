#!/usr/bin/env python3
"""
WC 2026 nightly Monte Carlo + analytical match/player projection.

Inputs (env):
  SUPABASE_URL                     write target
  SUPABASE_SERVICE_KEY             write key (service role, NOT anon)
  DISCORD_BOT_TOKEN                optional — posts validation failures to #bot-logs
  WC_SIM_ITERATIONS                optional override (default 10000)

Outputs (DB):
  world_cup_simulation             ~648 rows under new sim_run_id v5_<TS> (288 team + 360 match)
  world_cup_player_simulation      25 rows
  world_cup_simulation_latest      matview refreshed
  world_cup_player_simulation_latest matview refreshed

v5 (2026-06-18): the group-stage Monte Carlo now CONDITIONS on completed match
results loaded from the site's data/wc2026-matches.json (via wc.results). Banked
points/GD/GF are facts; only remaining fixtures are simulated. This kills the
stale-sim mispricings documented in
prediction-marketspicks/handoffs/WC_MISPRICINGS_STALE_SIM_2026-06-18.md. Team
strength ratings (teams.py) are unchanged — we condition on deterministic state,
not on re-estimating strength from one game.

Validation gate (v5 — structural, no longer seed-reproduction):
  - All 48 champion% sum to 100 ± 0.5
  - Per team, advance ≥ reach_r16 ≥ reach_qf ≥ reach_sf ≥ reach_final ≥ champion
  - Match H+D+A sums to 100 ± 1 per match
  - 25 player rows present, no nulls in required columns
  Failure → Discord alert + sys.exit(1)

CLI:
  python scripts/run-wc-sim.py                            full run, write to DB
  python scripts/run-wc-sim.py --validate-only            validate, no DB writes
  python scripts/run-wc-sim.py --iterations 1000          fast smoke
  python scripts/run-wc-sim.py --seed 42                  override RNG seed (default 42)
  python scripts/run-wc-sim.py --no-backdrop              skip market backdrop attach
  python scripts/run-wc-sim.py --no-results              ignore completed results (full re-sim)
  python scripts/run-wc-sim.py --require-results          fail if 0 results load (tournament safety)
  python scripts/run-wc-sim.py --matches-source URL|PATH override results source
  python scripts/run-wc-sim.py --dump-json out.json       write rows to file, skip DB
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
from wc.results import (  # noqa: E402
    load_played_results, load_knockout_bracket, describe as describe_results,
)
from wc.form import adjusted_ratings, describe_top_movers                 # noqa: E402


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
    """Convert aggregated progression rates into 288 sim rows (48 teams × 6 kinds)."""
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
        "advance":     "advance",      # qualify from group → reach R32 (≠ reach_r16 in 48-team format)
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


def build_match_rows(sim_run_id: str, ran_at_iso: str, backdrop, ratings=None) -> List[dict]:
    """Convert analytical match probabilities into 360 sim rows (72 × 5).

    `ratings`: form-adjusted strength (wc.form) so per-match predictions on the
    fixture pages track results; None = frozen pre-tournament TEAMS.
    """
    from wc.markets import attach_to_metadata
    matches = all_group_matches(ratings)
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


def build_player_rows(sim_run_id: str, ran_at_iso: str, stages) -> List[dict]:
    """25 Golden Boot rows. exp_g_total + metadata.golden_boot_pct now come from the
    tournament-long scorer MC, reusing the champion sim's `stages` realizations."""
    rows = project_all_players(stages)
    for r in rows:
        r["sim_run_id"] = sim_run_id
        r["sim_ran_at"] = ran_at_iso
        r.setdefault("metadata", {})  # project_all_players already sets golden_boot_pct
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
    parser.add_argument("--no-results", action="store_true",
                        help="Ignore completed results — re-simulate the full group stage")
    parser.add_argument("--no-form", action="store_true",
                        help="Skip form-adjusted ratings (use frozen pre-tournament TEAMS)")
    parser.add_argument("--require-results", action="store_true",
                        default=os.environ.get("WC_SIM_REQUIRE_RESULTS") == "1",
                        help="Fail if zero completed results load (tournament safety)")
    parser.add_argument("--matches-source", default=None,
                        help="Override results source (URL or file path)")
    parser.add_argument("--dump-json", default=None,
                        help="Write {team_rows,match_rows,player_rows} to this file; skip DB")
    args = parser.parse_args()

    sim_run_id = f"v5_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    ran_at_iso = datetime.now(timezone.utc).isoformat()
    print(f"[wc-sim] starting run {sim_run_id} ({args.iterations} iterations, seed={args.seed})")

    # 0. Load completed group-stage results to condition the group MC on.
    played = {}
    if not args.no_results:
        try:
            played = load_played_results(args.matches_source)
        except Exception as e:
            msg = f"WC sim {sim_run_id}: results load FAILED: {e!s}"
            print(msg, file=sys.stderr)
            if args.require_results:
                if not args.validate_only and not args.dump_json:
                    discord_alert(msg, sim_run_id=sim_run_id, failures=[str(e)])
                return 1
            print("[wc-sim] proceeding without results (full re-sim)", file=sys.stderr)
        print(f"[wc-sim] {describe_results(played)}")
        if args.require_results and len(played) == 0:
            msg = (f"WC sim {sim_run_id}: --require-results set but 0 completed "
                   f"results loaded — refusing to publish a stale full re-sim")
            print(msg, file=sys.stderr)
            if not args.validate_only and not args.dump_json:
                discord_alert(msg, sim_run_id=sim_run_id, failures=["0 results loaded"])
            return 1
    else:
        print("[wc-sim] --no-results: simulating full group stage from priors")

    # 0b. Form-adjusted ratings from completed results (applied to UNPLAYED
    # fixtures in both the grid and the progression sim). Base TEAMS is unchanged.
    ratings = None
    if played and not args.no_form:
        ratings = adjusted_ratings(played)
        print(f"[wc-sim] form movers: {describe_top_movers(played)}")
    elif args.no_form:
        print("[wc-sim] --no-form: using frozen pre-tournament ratings")

    # 0c. Real knockout bracket (post-R32). When the full Round of 16 is known,
    # seed the bracket from the actual 8 ties instead of re-simulating it from
    # group standings — otherwise eliminated teams keep re-advancing and carry
    # phantom champion% (the staleness the recap article/mispricings surface).
    ko_r16, r32_teams = None, None
    if not args.no_results:
        try:
            r32_teams, r16_ties = load_knockout_bracket(args.matches_source)
            if len(r16_ties) == 8:
                ko_r16 = r16_ties
                print(f"[wc-sim] bracket pinned to real Round of 16 "
                      f"({len(r32_teams)} R32 teams, 8 ties) — QF+ shuffled")
            elif r16_ties:
                print(f"[wc-sim] partial R16 ({len(r16_ties)}/8 ties) — "
                      f"re-simulating bracket from group standings")
        except Exception as e:  # noqa: BLE001 — bracket is a best-effort overlay
            print(f"[wc-sim] knockout bracket load failed (non-fatal): {e!s}")

    # 1. Monte Carlo team progression (conditioned on `played`, form-adjusted)
    t0 = time.time()
    random.seed(args.seed)
    stages = [run_one_tournament(played, ratings, ko_r16, r32_teams)
              for _ in range(args.iterations)]
    agg = aggregate_team_progression(stages)
    print(f"[wc-sim] team MC done in {time.time() - t0:.1f}s")

    # 2. Market backdrop (skipped in --validate-only, --no-backdrop, --dump-json)
    backdrop = {}
    if not args.validate_only and not args.no_backdrop and not args.dump_json:
        try:
            from wc.markets import fetch_market_backdrop
            backdrop = fetch_market_backdrop()
        except Exception as e:
            print(f"[wc-sim] backdrop fetch failed (non-fatal): {e!s}")

    # 3. Build rows
    team_rows = build_team_rows(sim_run_id, agg, ran_at_iso, backdrop)
    match_rows = build_match_rows(sim_run_id, ran_at_iso, backdrop, ratings)
    player_rows = build_player_rows(sim_run_id, ran_at_iso, stages)
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

    # 5. Write (skip in validate-only / dump-json)
    if args.validate_only:
        print("[wc-sim] --validate-only: no DB writes")
        return 0

    if args.dump_json:
        import json as _json
        payload = {
            "sim_run_id": sim_run_id,
            "ran_at": ran_at_iso,
            "played_count": len(played),
            "team_rows": team_rows,
            "match_rows": match_rows,
            "player_rows": player_rows,
        }
        with open(args.dump_json, "w", encoding="utf-8") as fh:
            _json.dump(payload, fh)
        print(f"[wc-sim] --dump-json: wrote {args.dump_json} (no DB)")
        return 0

    from wc.supabase_writer import (
        insert_simulation_rows,
        insert_player_rows,
        refresh_matviews,
    )
    # Write + matview refresh are wrapped so ANY failure here (a dropped/renamed
    # table, an RPC error, a stale matview) fires a Discord alert and exits 1 —
    # never a silent red CI run. This is the guard that was missing when the
    # retired `world_cup_match_model` write crashed the job for 2 days (06-28→30)
    # leaving the *_latest matviews stale with no alert.
    try:
        n_team = insert_simulation_rows(team_rows)
        n_match = insert_simulation_rows(match_rows)
        n_player = insert_player_rows(player_rows)
        print(f"[wc-sim] wrote {n_team} team + {n_match} match + "
              f"{n_player} player rows")
        refresh_matviews()
    except Exception as e:
        msg = f"WC sim {sim_run_id} DB write/refresh FAILED: {e!s}"
        print(msg, file=sys.stderr)
        discord_alert(msg, sim_run_id=sim_run_id, failures=[str(e)])
        return 1

    print(f"[wc-sim] DONE — sim_run_id={sim_run_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
