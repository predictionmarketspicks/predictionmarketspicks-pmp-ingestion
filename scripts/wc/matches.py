"""
Group-stage match probability computer (analytical Poisson).

For each of the 72 group-stage matches, computes:
  - match_winner_home / draw / away
  - match_o25  (P(total goals >= 3))
  - match_btts (P(both teams score >= 1))

Uses the same Off/Def ratings + Poisson model as simulator.py, but evaluated
analytically over an 8x8 score grid rather than via Monte Carlo. This matches
the methodology of the original wc2026_matches_v2.py that generated the
v2_april_2026_seed match rows — analytical → exact reproducibility, no
seed-tolerance debate.

Match entity_id format: match:{group}-MD{matchday}-{HOME_TRI}-{AWAY_TRI}
  e.g. match:I-MD1-FRA-SEN
"""
from __future__ import annotations

import math
from typing import Dict, List, Tuple

from .teams import TEAMS, GROUPS, NAME_TO_SLUG, NAME_TO_TRI, HOST_SET
from .simulator import expected_goals
from .venues import match_env

# Score grid cap. Goals 0..SCORE_GRID-1 per team. 15x15 captures >99.999% of mass
# for our LAM_CAP=5; smaller grids leak ~5% on Brazil-Haiti / Spain-Cape Verde
# tail and break H+D+A=100 sanity.
SCORE_GRID = 15

# Dixon-Coles (1997) low-score correlation correction. The independent-Poisson
# grid over-weights the (0,0)/(1,1) decisive-vs-draw cells; DC redistributes mass
# toward draws and compresses heavy-favorite win% by ~1-3pp in mismatches — the
# exact bias the analytical model needs. v3 applies it ONLY to this analytical
# match path (simulator.py's Monte Carlo progression loop is untouched, so the
# champion% seed + its validation bands are unaffected).
#
# ρ = −0.18 is the long-run international-football prior (WC2018 ~−0.15,
# WC2022 ~−0.22) per .claude/skills/wc-2026-edge/reference/poisson-dixon-coles.md.
# Sign verified empirically: with this τ + ρ<0 the favorite win% drops and draw
# rises (matches the skill's Spain–Cape Verde worked example). See tools/dc_check.
DC_RHO = -0.18


def _pmf(k: int, lam: float) -> float:
    return math.exp(-lam) * (lam ** k) / math.factorial(k)


def _dc_tau(ga: int, gb: int, la: float, lb: float, rho: float) -> float:
    """Dixon-Coles τ adjustment for the four low-score cells; 1.0 elsewhere."""
    if ga == 0 and gb == 0:
        return 1.0 - la * lb * rho
    if ga == 0 and gb == 1:
        return 1.0 + la * rho
    if ga == 1 and gb == 0:
        return 1.0 + lb * rho
    if ga == 1 and gb == 1:
        return 1.0 - rho
    return 1.0


def match_probs(
    team_a: str,
    team_b: str,
    host_a: bool = False,
    host_b: bool = False,
    rho: float = DC_RHO,
    home_mult: float = 1.0,
    away_mult: float = 1.0,
    ratings: Dict[str, tuple] | None = None,
) -> Dict[str, float]:
    """Analytical Poisson + Dixon-Coles over an SxS score grid.

    Returns percentages (0-100, rounded to 1 decimal — matching seed format).
    Pass rho=0.0 for the legacy independent-Poisson result.

    home_mult / away_mult are per-match environmental λ multipliers (altitude +
    heat) from venues.match_env; default 1.0 (no adjustment). Applied after
    expected_goals so the base rating model is untouched. See venues.py for the
    containment rationale (analytical path only; champion seed unaffected).

    ratings: optional form-adjusted {name: (off, def)} (wc/form.py). Defaults to
    the frozen pre-tournament TEAMS table.
    """
    r = ratings or TEAMS
    oa, da = r[team_a]
    ob, db = r[team_b]
    la = expected_goals(oa, db, host_a) * home_mult
    lb = expected_goals(ob, da, host_b) * away_mult

    # Build the DC-corrected joint grid, then renormalize (τ distorts total mass).
    cells: List[Tuple[int, int, float]] = []
    total = 0.0
    for ga in range(SCORE_GRID):
        for gb in range(SCORE_GRID):
            p = _pmf(ga, la) * _pmf(gb, lb) * _dc_tau(ga, gb, la, lb, rho)
            cells.append((ga, gb, p))
            total += p

    home_w = draw = away_w = 0.0
    over25 = btts = 0.0
    for ga, gb, p in cells:
        p /= total
        if ga > gb:
            home_w += p
        elif gb > ga:
            away_w += p
        else:
            draw += p
        if (ga + gb) >= 3:
            over25 += p
        if ga > 0 and gb > 0:
            btts += p
    return {
        "match_winner_home": round(home_w * 100, 1),
        "match_winner_draw": round(draw   * 100, 1),
        "match_winner_away": round(away_w * 100, 1),
        "match_o25":         round(over25 * 100, 1),
        "match_btts":        round(btts   * 100, 1),
    }


def match_grid_detail(
    team_a: str,
    team_b: str,
    host_a: bool = False,
    host_b: bool = False,
    rho: float = DC_RHO,
    home_mult: float = 1.0,
    away_mult: float = 1.0,
    top_n: int = 5,
) -> Dict:
    """Rich per-match detail from the SAME DC-corrected grid as match_probs().

    Returns home_xg (la), away_xg (lb), total_xg, the full W/D/L + over/under +
    BTTS ladder, and the top-N most-likely exact scores ("H-A", H = team_a).

    Kept deliberately SEPARATE from match_probs(): run-wc-sim.py iterates
    match_probs()'s returned dict and writes ONE DB row per key (kind=key,
    pct=value). Adding xG / score-list fields there would inject bogus sim rows
    and crash pct_to_american on a list. This detail powers ONLY the static
    site card export (scripts/export-wc-match-detail.py); nothing writes it to
    the DB, so the nightly sim + champion seed are untouched.

    Percentages are 0-100 rounded to 1 decimal; xG rounded to 2 — matching the
    site card's display precision.
    """
    oa, da = TEAMS[team_a]
    ob, db = TEAMS[team_b]
    la = expected_goals(oa, db, host_a) * home_mult
    lb = expected_goals(ob, da, host_b) * away_mult

    cells: List[Tuple[int, int, float]] = []
    total = 0.0
    for ga in range(SCORE_GRID):
        for gb in range(SCORE_GRID):
            p = _pmf(ga, la) * _pmf(gb, lb) * _dc_tau(ga, gb, la, lb, rho)
            cells.append((ga, gb, p))
            total += p

    home_w = draw = away_w = 0.0
    o15 = o25 = o35 = btts = 0.0
    scored: List[Tuple[float, int, int]] = []
    for ga, gb, p in cells:
        p /= total
        if ga > gb:
            home_w += p
        elif gb > ga:
            away_w += p
        else:
            draw += p
        tot = ga + gb
        if tot >= 2:
            o15 += p
        if tot >= 3:
            o25 += p
        if tot >= 4:
            o35 += p
        if ga > 0 and gb > 0:
            btts += p
        scored.append((p, ga, gb))

    scored.sort(key=lambda x: x[0], reverse=True)
    top_scores = [
        {"score": f"{ga}-{gb}", "pct": round(p * 100, 1)}
        for p, ga, gb in scored[:top_n]
    ]
    return {
        "home_xg":    round(la, 2),
        "away_xg":    round(lb, 2),
        "total_xg":   round(la + lb, 2),
        "hw":         round(home_w * 100, 1),
        "d":          round(draw   * 100, 1),
        "aw":         round(away_w * 100, 1),
        "o15":        round(o15  * 100, 1),
        "o25":        round(o25  * 100, 1),
        "o35":        round(o35  * 100, 1),
        "btts":       round(btts * 100, 1),
        "top_scores": top_scores,
    }


def _matchday_pairs(group_teams: List[str]) -> List[Tuple[int, str, str]]:
    """Return [(matchday, home, away), ...] following standard FIFA group order:
        MD1: T1 vs T2, T3 vs T4
        MD2: T1 vs T3, T2 vs T4
        MD3: T1 vs T4, T2 vs T3
    Matches the seed's MD layout (verified against seed-wc-simulation.sql).
    """
    t1, t2, t3, t4 = group_teams
    return [
        (1, t1, t2), (1, t3, t4),
        (2, t1, t3), (2, t2, t4),
        (3, t1, t4), (3, t2, t3),
    ]


def all_group_matches(ratings: Dict[str, tuple] | None = None) -> List[dict]:
    """Returns all 72 group-stage matches with analytical probabilities.

    `ratings`: optional form-adjusted ratings (wc/form.adjusted_ratings); when
    omitted, uses the frozen pre-tournament TEAMS table.

    Each item:
      {
        "entity_id": "match:I-MD1-FRA-SEN",
        "group": "I",
        "matchday": 1,
        "home_name": "France",
        "away_name": "Senegal",
        "home_slug": "france",
        "away_slug": "senegal",
        "probs": { "match_winner_home": 54.8, "match_winner_draw": 22.4, ... },
      }
    """
    out = []
    for letter, teams in GROUPS.items():
        for md, home, away in _matchday_pairs(teams):
            home_slug = NAME_TO_SLUG[home]
            away_slug = NAME_TO_SLUG[away]
            entity_id = (
                f"match:{letter}-MD{md}-"
                f"{NAME_TO_TRI[home]}-{NAME_TO_TRI[away]}"
            )
            env = match_env(letter, home_slug, away_slug)
            probs = match_probs(
                home, away,
                host_a=(home in HOST_SET),
                host_b=(away in HOST_SET),
                home_mult=env["home_mult"],
                away_mult=env["away_mult"],
                ratings=ratings,
            )
            out.append({
                "entity_id": entity_id,
                "group": letter,
                "matchday": md,
                "home_name": home,
                "away_name": away,
                "home_slug": home_slug,
                "away_slug": away_slug,
                "venue": env["venue"],
                "env_notes": env["notes"],
                "probs": probs,
            })
    assert len(out) == 72, f"expected 72 group matches, got {len(out)}"
    return out
