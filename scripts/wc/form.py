"""
Form-adjusted team strength from completed results (v5 P0, 2026-06-18).

The analytical match grid (wc/matches.py) and the remaining-fixture progression
sim (wc/simulator.py) both read pre-tournament ratings from wc/teams.py TEAMS.
Those never change, so per-match predictions on the public fixture pages
(/sports/world-cup-2026/[slug]) stayed frozen at kickoff values even after games
were played. See
prediction-marketspicks/handoffs/WC_FIXTURE_FORM_AWARE_PREDICTIONS_2026-06-18.md.

This module derives a small per-team (off_delta, def_delta) from how a team's
ACTUAL goals compared to the model's EXPECTED goals in its completed fixtures,
heavily shrunk so one game stays far weaker than the pre-tournament prior. The
base TEAMS table is the validation anchor and is never mutated — adjusted_ratings
returns a NEW dict the runner threads into the grid + the unplayed-fixture sim.

Goals only (matches JSON carries no xG); the heavy shrink absorbs goal noise.
"""
from __future__ import annotations

from typing import Dict, FrozenSet, Tuple

from .teams import TEAMS, NAME_TO_SLUG, HOST_SET
from .simulator import expected_goals

SLUG_TO_NAME: Dict[str, str] = {slug: name for name, slug in NAME_TO_SLUG.items()}

# ── Tunables (heavy shrink — operator default 2026-06-18) ──────────────────────
# GOAL_TO_RATING: rating points that explain a 1-goal swing in expected_goals at
# the average lambda (~1.35). d(lam)/d(rating) = lam * EXP_SOFTEN/ELO_SCALE
# = 1.35 * 0.35/110 ~= 0.0043 goals/pt -> ~233 pts/goal.
GOAL_TO_RATING = 233.0
# SHRINK_PER_GAME: fraction of a fully-believed adjustment credited per game of
# evidence. 0.15 keeps the prior dominant (3 games ~= 0.45 weight).
SHRINK_PER_GAME = 0.15
# DELTA_CAP: hard ceiling on |off_delta| / |def_delta| in rating points, so a
# single blowout (or a data error) can't distort the model.
DELTA_CAP = 60.0

PlayedResults = Dict[FrozenSet[str], Dict[str, int]]


def _clamp(x: float, cap: float) -> float:
    return max(-cap, min(cap, x))


def compute_form_deltas(played: PlayedResults) -> Dict[str, Tuple[float, float]]:
    """Return {team_name: (off_delta, def_delta)} from completed results.

    off_delta  > 0  -> scored more than the model expected (attack underrated)
    def_delta  > 0  -> conceded fewer than expected (defence underrated; def is a
                       "higher = better" rating in expected_goals)
    """
    off_acc: Dict[str, float] = {}
    def_acc: Dict[str, float] = {}
    for pair, scores in played.items():
        slugs = list(scores.keys())
        if len(slugs) != 2:
            continue
        sa, sb = slugs
        name_a, name_b = SLUG_TO_NAME.get(sa), SLUG_TO_NAME.get(sb)
        if not name_a or not name_b:
            continue
        ga, gb = scores[sa], scores[sb]
        off_a, def_a = TEAMS[name_a]
        off_b, def_b = TEAMS[name_b]
        exp_a = expected_goals(off_a, def_b, host_a=name_a in HOST_SET)
        exp_b = expected_goals(off_b, def_a, host_a=name_b in HOST_SET)
        # A's attack vs its own expectation; A's defence vs what B was expected to score.
        off_acc[name_a] = off_acc.get(name_a, 0.0) + (ga - exp_a)
        def_acc[name_a] = def_acc.get(name_a, 0.0) + (exp_b - gb)
        off_acc[name_b] = off_acc.get(name_b, 0.0) + (gb - exp_b)
        def_acc[name_b] = def_acc.get(name_b, 0.0) + (exp_a - ga)

    deltas: Dict[str, Tuple[float, float]] = {}
    k = SHRINK_PER_GAME * GOAL_TO_RATING
    for name in set(off_acc) | set(def_acc):
        od = _clamp(k * off_acc.get(name, 0.0), DELTA_CAP)
        dd = _clamp(k * def_acc.get(name, 0.0), DELTA_CAP)
        deltas[name] = (round(od, 1), round(dd, 1))
    return deltas


def adjusted_ratings(played: PlayedResults) -> Dict[str, Tuple[float, float]]:
    """Base TEAMS with form deltas applied. Base table is NOT mutated."""
    deltas = compute_form_deltas(played)
    out: Dict[str, Tuple[float, float]] = {}
    for name, (off, defr) in TEAMS.items():
        od, dd = deltas.get(name, (0.0, 0.0))
        out[name] = (off + od, defr + dd)
    return out


def describe_top_movers(played: PlayedResults, n: int = 8) -> str:
    """Human-readable log line of the biggest form adjustments."""
    deltas = compute_form_deltas(played)
    ranked = sorted(deltas.items(), key=lambda kv: -(abs(kv[1][0]) + abs(kv[1][1])))
    parts = [f"{name} off{od:+.0f}/def{dd:+.0f}" for name, (od, dd) in ranked[:n]]
    return "; ".join(parts) if parts else "(no completed results)"
