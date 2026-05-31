"""
Sim-output validation against the v4 market-anchored seed (see teams.py header).

What we validate:
  - Team progression (champion + reach_*) reproduces the seed within ±0.5pp,
    because the algorithm is deterministic with seed=42 (we replicated the
    original wc2026_sim_v2.py operator-precedence quirk on purpose; see
    simulator.py for the load-bearing comment). The v4 seed swapped the team
    ratings (market-anchored) but NOT the algorithm, so determinism is intact.
  - Champion% across all 48 teams sums to 100.0 ± 0.5.
  - Match-level (match_winner_*, match_o25, match_btts) — sanity only:
    H+D+A sums to 100 ± 1 per match; all values in (0, 100).
    NOT compared to seed: PR 2 upgrades match values from the edge function's
    hand-tuned ALL_MATCHES table to analytical Poisson, so values WILL differ.
  - Player rows — sanity only: 25 rows, no nulls in required columns,
    exp_g_group in (0, 5), anytime_pct_group in (0, 100).

Failure modes:
  - validate_team_progression returns {"passed": False, "failures": [...]} if
    any spot-check team is outside tolerance OR if the sum check fails.
  - run-wc-sim.py treats any "passed: False" as a Discord-alert + GH Action fail.
"""
from typing import Dict, List

# Spot-check teams + tolerance window — v4 MARKET-ANCHORED seed (May 2026).
# expected = the actual champion% the baked teams.py ratings produce at the
# production config (10000 iters, seed=42), which is a 50/50 blend of the Elo
# model and the de-vigged DraftKings outright market (see teams.py header +
# market_anchor.py). Because the run is deterministic, the nightly sim reproduces
# these exactly; ±0.5pp catches any algorithmic drift. spec_band = expected ±1.0,
# the acceptable market-anchored range. To re-anchor, regenerate via
# `python -m wc.calibrate_ratings` and paste its printed SPOT_CHECKS block.
SPOT_CHECKS = {
    "team:spain":     {"kind": "champion", "expected": 16.7, "tol": 0.5, "spec_band": (15.7, 17.7)},
    "team:france":    {"kind": "champion", "expected": 14.6, "tol": 0.5, "spec_band": (13.6, 15.6)},
    "team:england":   {"kind": "champion", "expected": 12.7, "tol": 0.5, "spec_band": (11.7, 13.7)},
    "team:brazil":    {"kind": "champion", "expected": 9.6,  "tol": 0.5, "spec_band": (8.6, 10.6)},
    "team:argentina": {"kind": "champion", "expected": 9.7,  "tol": 0.5, "spec_band": (8.7, 10.7)},
    "team:germany":   {"kind": "champion", "expected": 6.4,  "tol": 0.5, "spec_band": (5.4, 7.4)},
}

CHAMPION_SUM_TOLERANCE = 0.5  # sum of all 48 champion% should be 100 ± this


def validate_team_progression(team_rows: List[dict]) -> dict:
    """team_rows: list of {entity_id, kind, sim_pct} dicts from this run."""
    failures: List[str] = []
    by_key = {(r["entity_id"], r["kind"]): r["sim_pct"] for r in team_rows}

    for entity_id, spec in SPOT_CHECKS.items():
        actual = by_key.get((entity_id, spec["kind"]))
        if actual is None:
            failures.append(f"missing row for ({entity_id}, {spec['kind']})")
            continue
        diff = float(actual) - spec["expected"]
        if abs(diff) > spec["tol"]:
            band = spec["spec_band"]
            inside_spec = band[0] <= float(actual) <= band[1]
            failures.append(
                f"{entity_id} {spec['kind']}: got {actual}, expected {spec['expected']} "
                f"(diff {diff:+.2f}, tol ±{spec['tol']}), spec band {band} → "
                f"{'inside spec band' if inside_spec else 'OUTSIDE spec band'}"
            )

    champ_sum = sum(float(r["sim_pct"]) for r in team_rows if r["kind"] == "champion")
    if abs(champ_sum - 100.0) > CHAMPION_SUM_TOLERANCE:
        failures.append(
            f"champion% sum across all teams = {champ_sum:.2f}, "
            f"expected 100.0 ± {CHAMPION_SUM_TOLERANCE}"
        )

    return {
        "passed":   len(failures) == 0,
        "failures": failures,
        "summary":  (f"team progression OK: {len(SPOT_CHECKS)} spot checks within tolerance, "
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
