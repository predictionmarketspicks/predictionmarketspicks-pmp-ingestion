"""
Sim-output validation (v5 — standings-conditioned).

v5 conditions the group-stage Monte Carlo on completed results (wc.results +
simulator.sim_group), so progression probabilities deliberately MOVE off the
pre-tournament seed as games are played (a favourite that loses MD1 sees its
advance% fall toward the market). That means the old v4 gate — "champion% must
reproduce the market-anchored seed within ±0.5pp" — is no longer a correctness
signal; it would hard-fail on every real result. We replace it with structural
invariants that must hold for ANY valid progression distribution:

  - Champion% across all 48 teams sums to 100.0 ± 0.5.
  - Per team, the progression ladder is monotone non-increasing:
    advance ≥ reach_r16 ≥ reach_qf ≥ reach_sf ≥ reach_final ≥ champion
    (each is P(reach at least stage X); the counts are strictly nested, so this
    must hold exactly up to rounding). A violation means the aggregation or the
    conditioning is broken.
  - Every team pct is within [0, 100].
  - Match-level (match_winner_*, match_o25, match_btts) — sanity only:
    H+D+A sums to 100 ± 1 per match; all values in (0, 100). The analytical match
    path is unchanged in v5 (still a pre-game DC-Poisson grid), so it is NOT
    conditioned — match rows for already-played fixtures are pre-game numbers and
    are intentionally left as sanity-only.
  - Player rows — sanity only: 25 rows, no nulls in required columns,
    exp_g_group in (0, 5), anytime_pct_group in (0, 100).

Failure modes:
  - validate_team_progression returns {"passed": False, "failures": [...]} on any
    structural violation.
  - run-wc-sim.py treats any "passed: False" as a Discord-alert + GH Action fail.
"""
from typing import Dict, List

CHAMPION_SUM_TOLERANCE = 0.5  # sum of all 48 champion% should be 100 ± this

# Progression ladder, deepest-reaching first. P(advance) ≥ P(reach_r16) ≥ … ≥
# P(champion) because the per-iteration stage counts are strictly nested.
PROGRESSION_LADDER = [
    "advance", "reach_r16", "reach_qf", "reach_sf", "reach_final", "champion",
]
MONOTONE_TOLERANCE = 0.11  # absorb 1-decimal rounding on adjacent rungs


def validate_team_progression(team_rows: List[dict]) -> dict:
    """team_rows: list of {entity_id, kind, sim_pct} dicts from this run."""
    failures: List[str] = []
    by_key = {(r["entity_id"], r["kind"]): float(r["sim_pct"]) for r in team_rows}
    entities = sorted({r["entity_id"] for r in team_rows if r["entity_id"].startswith("team:")})

    # Range check.
    for (entity_id, kind), v in by_key.items():
        if not (0.0 <= v <= 100.0):
            failures.append(f"{entity_id} {kind}={v} outside [0,100]")

    # Per-team monotone non-increasing progression ladder.
    for entity_id in entities:
        prev_kind = None
        prev_val = None
        for kind in PROGRESSION_LADDER:
            v = by_key.get((entity_id, kind))
            if v is None:
                failures.append(f"missing row for ({entity_id}, {kind})")
                continue
            if prev_val is not None and v > prev_val + MONOTONE_TOLERANCE:
                failures.append(
                    f"{entity_id} progression not monotone: {kind}={v} > "
                    f"{prev_kind}={prev_val}"
                )
            prev_kind, prev_val = kind, v

    champ_sum = sum(v for (e, k), v in by_key.items() if k == "champion")
    if abs(champ_sum - 100.0) > CHAMPION_SUM_TOLERANCE:
        failures.append(
            f"champion% sum across all teams = {champ_sum:.2f}, "
            f"expected 100.0 ± {CHAMPION_SUM_TOLERANCE}"
        )

    return {
        "passed":   len(failures) == 0,
        "failures": failures,
        "summary":  (f"team progression OK: {len(entities)} teams monotone, "
                     f"champion% sum = {champ_sum:.2f}"),
    }


def validate_match_sanity(match_rows: List[dict]) -> dict:
    """Sanity-only checks for the 360 match rows (72 matches × 5 kinds)."""
    failures: List[str] = []

    # Group rows by entity_id (match)
    by_match: Dict[str, Dict[str, float]] = {}
    for r in match_rows:
        by_match.setdefault(r["entity_id"], {})[r["kind"]] = float(r["sim_pct"])

    for entity_id, kinds in by_match.items():
        for k in ("match_winner_home", "match_winner_draw", "match_winner_away",
                  "match_o25", "match_btts"):
            v = kinds.get(k)
            if v is None:
                failures.append(f"{entity_id} missing kind={k}")
                continue
            if not (0 < v < 100):
                failures.append(f"{entity_id} {k}={v} outside (0,100)")

        # H + D + A should sum to ~100 (analytical, score-grid truncation can
        # leak ~0.1pp for high-scoring teams; tolerance ±1 is safe).
        try:
            hda_sum = (kinds["match_winner_home"]
                       + kinds["match_winner_draw"]
                       + kinds["match_winner_away"])
            if abs(hda_sum - 100.0) > 1.0:
                failures.append(f"{entity_id} H+D+A = {hda_sum:.2f}, expected 100 ± 1")
        except KeyError:
            pass  # already reported above

    return {
        "passed":   len(failures) == 0,
        "failures": failures,
        "summary":  f"match sanity OK: {len(by_match)} matches checked",
    }


def validate_player_sanity(player_rows: List[dict]) -> dict:
    failures: List[str] = []
    if len(player_rows) != 25:
        failures.append(f"expected 25 player rows, got {len(player_rows)}")
    seen_slugs = set()
    for r in player_rows:
        for col in ("player_slug", "player_name", "team_slug", "kind"):
            if not r.get(col):
                failures.append(f"player row missing {col}: {r}")
        if r["player_slug"] in seen_slugs:
            failures.append(f"duplicate player_slug: {r['player_slug']}")
        seen_slugs.add(r["player_slug"])
        eg = r.get("exp_g_group")
        if eg is None or not (0 < float(eg) < 5):
            failures.append(f"{r['player_slug']} exp_g_group={eg} outside (0,5)")
        ap = r.get("anytime_pct_group")
        if ap is None or not (0 < float(ap) < 100):
            failures.append(f"{r['player_slug']} anytime_pct_group={ap} outside (0,100)")

    return {
        "passed":   len(failures) == 0,
        "failures": failures,
        "summary":  f"player sanity OK: 25 rows, no duplicates",
    }


def validate_all(team_rows, match_rows, player_rows) -> dict:
    """Run all three validation gates. Aggregate result."""
    t = validate_team_progression(team_rows)
    m = validate_match_sanity(match_rows)
    p = validate_player_sanity(player_rows)
    return {
        "passed":   t["passed"] and m["passed"] and p["passed"],
        "failures": t["failures"] + m["failures"] + p["failures"],
        "summary":  " | ".join([t["summary"], m["summary"], p["summary"]]),
        "team":     t,
        "match":    m,
        "player":   p,
    }
