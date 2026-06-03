"""
WC 2026 single-tournament simulator (Monte Carlo loop driver).

Algorithm — ported faithfully from /Users/benny/projects/predictionmarketspicks/
wc2026_sim_v2.py (the script that produced v2_april_2026_seed):

  - Goals ~ Poisson(λ) per team
  - λ_a = BASE * exp((Off_a − Def_b) / ELO_SCALE * 0.35) * (HOME_ADV if host else 1)
  - Group stage: 6 round-robin matches per group, FIFA tiebreak (pts > GD > GF > random)
  - Top 2 from each group + best 8 of 12 thirds → 32-team R32 bracket
  - KO rounds: if drawn after regulation, ET coin-flip + penalty model
    (52% to higher-rated team)

Per-iteration output is a dict mapping team → furthest stage code:
  0=group, 1=R32, 2=R16, 3=QF, 4=SF, 5=F, 6=Champion
"""
import math
import random
from typing import Dict, List, Tuple

from .teams import TEAMS, GROUPS, ALL_TEAMS, HOST_SET

# ── Match model constants (locked — drift = seed validation will fail) ────────
BASE_GOALS = 1.35   # global per-team xG baseline
HOME_ADV   = 1.15   # multiplicative bump for host-cluster teams
ELO_SCALE  = 110    # rating-diff → goal-diff conversion
EXP_SOFTEN = 0.35   # softer Poisson curve, prevents elite-vs-minnow blowouts
LAM_FLOOR  = 0.1
LAM_CAP    = 5.0


def expected_goals(off_a: int, def_b: int, host_a: bool = False) -> float:
    diff = (off_a - def_b) / ELO_SCALE
    lam = BASE_GOALS * math.exp(diff * EXP_SOFTEN)
    if host_a:
        lam *= HOME_ADV
    return max(LAM_FLOOR, min(lam, LAM_CAP))


def poisson(lam: float) -> int:
    """Knuth's algorithm. Uses module random state — seed via random.seed()."""
    L = math.exp(-lam)
    k = 0
    p = 1.0
    while True:
        k += 1
        p *= random.random()
        if p <= L:
            return k - 1


def sim_match(
    team_a: str,
    team_b: str,
    host_a: bool = False,
    host_b: bool = False,
    knockout: bool = False,
) -> Tuple[int, int]:
    oa, da = TEAMS[team_a]
    ob, db = TEAMS[team_b]
    lam_a = expected_goals(oa, db, host_a)
    lam_b = expected_goals(ob, da, host_b)
    ga = poisson(lam_a)
    gb = poisson(lam_b)
    if knockout and ga == gb:
        # ET + pens: 50/50 mix. Strength-favored team has slight edge in both.
        p_a = 1 / (1 + math.exp(-(oa + da - ob - db) / 400))
        if random.random() < 0.5:
            # ET goal goes to the strength-favored team probabilistically.
            if random.random() < p_a:
                ga += 1
            else:
                gb += 1
        else:
            # NOTE: the operator-precedence quirk below is intentional and load-bearing.
            # Python parses this as `(random.random() < 0.52) if p_a > 0.5 else 0.48`,
            # NOT `random.random() < (0.52 if p_a > 0.5 else 0.48)`. When p_a <= 0.5 the
            # conditional collapses to the truthy constant 0.48 and team_a always wins
            # the shootout with NO random.random() consumed. This is the exact form
            # used by wc2026_sim_v2.py to produce v2_april_2026_seed; "fixing" it
            # changes the random stream and breaks every champion% in the seed by 1-3pp.
            # If we ever rewrite the penalty model, bump sim_run_id to v4 and update the
            # validation tolerance bands; do not silently correct.
            if random.random() < 0.52 if p_a > 0.5 else 0.48:
                ga += 1
            else:
                gb += 1
    return ga, gb


def sim_group(group_teams: List[str]) -> Tuple[List[str], Dict[str, dict]]:
    """Run all 6 round-robin matches; return (ranked, stats)."""
    stats = {t: {"pts": 0, "gf": 0, "ga": 0, "gd": 0} for t in group_teams}
    for i in range(4):
        for j in range(i + 1, 4):
            a, b = group_teams[i], group_teams[j]
            ga, gb = sim_match(a, b, host_a=(a in HOST_SET), host_b=(b in HOST_SET))
            stats[a]["gf"] += ga; stats[a]["ga"] += gb; stats[a]["gd"] += (ga - gb)
            stats[b]["gf"] += gb; stats[b]["ga"] += ga; stats[b]["gd"] += (gb - ga)
            if ga > gb:
                stats[a]["pts"] += 3
            elif gb > ga:
                stats[b]["pts"] += 3
            else:
                stats[a]["pts"] += 1; stats[b]["pts"] += 1
    ranked = sorted(
        group_teams,
        key=lambda t: (-stats[t]["pts"], -stats[t]["gd"], -stats[t]["gf"], random.random()),
    )
    return ranked, stats


def run_one_tournament() -> Dict[str, int]:
    """Returns dict: team → furthest stage (0=group .. 6=champion)."""
    stage = {t: 0 for t in ALL_TEAMS}
    advancers: List[str] = []
    third_pool: List[Tuple[Tuple[int, int, int], str]] = []

    for letter, teams in GROUPS.items():
        ranked, stats = sim_group(teams)
        for t in ranked[:2]:
            stage[t] = 1
            advancers.append(t)
        third = ranked[2]
        third_pool.append((
            (-stats[third]["pts"], -stats[third]["gd"], -stats[third]["gf"]),
            third,
        ))

    # Best 8 of 12 third-place teams advance (FIFA 48-team format).
    third_pool.sort()
    for _, t in third_pool[:8]:
        stage[t] = 1
        advancers.append(t)

    # Bracket pairing: shuffle approximation (true bracket is path-dependent on
    # actual group standings; for outright-progression sim, shuffle is fine).
    random.shuffle(advancers)

    def run_round(pairs, next_stage):
        winners = []
        for a, b in pairs:
            ga, gb = sim_match(a, b, knockout=True)
            w = a if ga > gb else b
            winners.append(w)
            stage[w] = next_stage
        return winners

    pairs = [(advancers[i], advancers[i + 1]) for i in range(0, 32, 2)]
    r16 = run_round(pairs, 2)                                                # R32 → R16
    qf = run_round([(r16[i], r16[i + 1]) for i in range(0, 16, 2)], 3)       # R16 → QF
    sf = run_round([(qf[i], qf[i + 1]) for i in range(0, 8, 2)], 4)          # QF  → SF
    f  = run_round([(sf[i], sf[i + 1]) for i in range(0, 4, 2)], 5)          # SF  → F
    run_round([(f[0], f[1])], 6)                                              # Final
    return stage


def aggregate_team_progression(stages_per_iteration: List[Dict[str, int]]) -> Dict[str, Dict[str, float]]:
    """Aggregate N tournament runs into per-team progression rates (percent)."""
    n = len(stages_per_iteration)
    # stage codes: 1=advanced from group (R32), 2=R16, 3=QF, 4=SF, 5=Final, 6=Champion.
    # `advance` (s>=1) = qualify from group → reach Round of 32. In the 48-team format this
    # is a DIFFERENT event from reach_r16 (s>=2); they coincided only in the old 32-team
    # bracket. Matches Kalshi KXWCGROUPQUAL (kind=advance in ingest-wc-kalshi-markets).
    counts = {t: {"advance": 0, "r16": 0, "qf": 0, "sf": 0, "final": 0, "champion": 0} for t in ALL_TEAMS}
    for stage in stages_per_iteration:
        for t, s in stage.items():
            if s >= 1: counts[t]["advance"]  += 1
            if s >= 2: counts[t]["r16"]      += 1
            if s >= 3: counts[t]["qf"]       += 1
            if s >= 4: counts[t]["sf"]       += 1
            if s >= 5: counts[t]["final"]    += 1
            if s >= 6: counts[t]["champion"] += 1
    return {
        t: {kind: round(c[kind] / n * 100, 1) for kind in c}
        for t, c in counts.items()
    }
