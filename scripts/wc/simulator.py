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
from typing import Dict, FrozenSet, List, Optional, Set, Tuple, TYPE_CHECKING

from .teams import TEAMS, GROUPS, ALL_TEAMS, HOST_SET, NAME_TO_SLUG

if TYPE_CHECKING:  # avoid any import-order coupling in the hot loop
    from .results import KnockoutBracket

# Played group fixtures, keyed by frozenset of the two team slugs → {slug: goals}.
# Supplied by wc.results.load_played_results(); None means "simulate everything"
# (pre-tournament behaviour / standalone player-model runs).
PlayedResults = Dict[FrozenSet[str], Dict[str, int]]

# ── Match model constants ────────────────────────────────────────────────────
# NOTE: v5 validation (wc/validation.py) is STRUCTURAL (champion% sums to 100,
# monotone progression ladder, match H+D+A ~100) — NOT seed reproduction — so
# these can be recalibrated WITHOUT re-blessing v2_april_2026_seed. (The old
# "locked — drift fails validation" note was pre-v5 and is no longer true.)
# 2026-06-30 calibration: the live combo board showed the model running hot on
# Over 2.5 for heavy favorites (λ 3.7+) and knockout matches (+10pp vs market on
# overs AND BTTS). Two fixes: tightened LAM_CAP 5.0→3.0 (realism ceiling) and
# added KO_GOALS_MULT (knockout football is lower-scoring). BASE_GOALS is left
# alone — an even match → 2.70 total ≈ 51% O2.5, which matches the intl base rate.
BASE_GOALS = 1.35   # global per-team xG baseline
HOME_ADV   = 1.15   # multiplicative bump for host-cluster teams
ELO_SCALE  = 110    # rating-diff → goal-diff conversion
EXP_SOFTEN = 0.35   # softer Poisson curve, prevents elite-vs-minnow blowouts
LAM_FLOOR  = 0.1
LAM_CAP    = 3.0    # realism ceiling on single-team xG (no team realistically exceeds ~3)
KO_GOALS_MULT = 0.88  # knockout matches score less (cautious, elimination); damp both λ


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
    ratings: Optional[dict] = None,
) -> Tuple[int, int]:
    r = ratings or TEAMS
    oa, da = r[team_a]
    ob, db = r[team_b]
    lam_a = expected_goals(oa, db, host_a)
    lam_b = expected_goals(ob, da, host_b)
    if knockout:
        # Knockout football is lower-scoring than the group stage (see KO_GOALS_MULT).
        lam_a *= KO_GOALS_MULT
        lam_b *= KO_GOALS_MULT
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


def sim_group(
    group_teams: List[str],
    played: Optional[PlayedResults] = None,
    ratings: Optional[dict] = None,
) -> Tuple[List[str], Dict[str, dict]]:
    """Run the 6 round-robin matches; return (ranked, stats).

    When `played` carries a completed result for a pairing, the REAL score is
    banked (points/GD/GF are facts, not re-randomized) and that fixture is not
    simulated; only the remaining games are. This is what makes the sim condition
    on the live tournament state instead of re-running from kickoff. FIFA tiebreak
    (pts > GD > GF > random) is applied over the combined real + simulated table.
    """
    stats = {t: {"pts": 0, "gf": 0, "ga": 0, "gd": 0} for t in group_teams}
    for i in range(4):
        for j in range(i + 1, 4):
            a, b = group_teams[i], group_teams[j]
            res = played.get(frozenset((NAME_TO_SLUG[a], NAME_TO_SLUG[b]))) if played else None
            if res is not None:
                ga, gb = res[NAME_TO_SLUG[a]], res[NAME_TO_SLUG[b]]
            else:
                ga, gb = sim_match(a, b, host_a=(a in HOST_SET), host_b=(b in HOST_SET),
                                   ratings=ratings)
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


def _run_pinned_knockout(
    bracket: "KnockoutBracket",
    ratings: Optional[dict] = None,
) -> Dict[str, int]:
    """Bracket seeded from the REAL knockout rows (post-R32 conditioning).

    Every tie the detector has entered — at ANY stage (R16, QF, SF, Final) — is
    pinned: its two teams get their stage floor and the pairing is played with its
    true opponents. A team named in a DEEPER round's tie definitively won its
    shallower ties, so we bank that winner instead of re-rolling it. This closes
    the phantom-progression bug (eliminated teams re-advancing and carrying
    champion%) at EVERY round, not just R32→R16 — the round the bracket has
    reached auto-advances as the detector writes deeper rows, with no code change.

    Rounds whose pairings aren't entered yet keep the documented random-shuffle
    approximation from that depth on: team STRENGTHS are exact, bracket PATH is
    blurred, and we never invent an adjacency we don't actually have.

    stage codes match run_one_tournament: 1=R32, 2=R16, 3=QF, 4=SF, 5=Final,
    6=Champion. Teams that exited in the group stage stay at 0.
    """
    ties_by_stage = bracket.ties_by_stage
    stage = {t: 0 for t in ALL_TEAMS}

    # 1. Stage floors from the R32 field + every entered tie.
    for t in bracket.r32_teams:
        if t in stage:
            stage[t] = max(stage[t], 1)
    for code, ties in ties_by_stage.items():
        for a, b in ties:
            stage[a] = max(stage[a], code)
            stage[b] = max(stage[b], code)

    # 2. Depth-implied winners: the participants of a stage-(S+1) tie are exactly
    #    the teams that WON their stage-S tie. reached_next[S] = those winners.
    reached_next: Dict[int, Set[str]] = {}
    for code, ties in ties_by_stage.items():
        won_prev = reached_next.setdefault(code - 1, set())
        for a, b in ties:
            won_prev.add(a)
            won_prev.add(b)

    def play_round(entering_pool: List[str], code: int) -> List[str]:
        """Play stage `code`: honour known pairings + bank depth-decided winners,
        shuffle the rest. Returns the teams advancing to stage `code + 1`."""
        pool_set = set(entering_pool)
        # Known pairings whose BOTH teams actually reached this round (a deeper
        # row referencing a team this round didn't produce is a data gap — drop
        # it and let the shuffle handle those teams).
        known = [
            (a, b) for a, b in ties_by_stage.get(code, [])
            if a in pool_set and b in pool_set
        ]
        covered = {t for tie in known for t in tie}
        remainder = [t for t in entering_pool if t not in covered]
        random.shuffle(remainder)
        filler = [
            (remainder[i], remainder[i + 1])
            for i in range(0, len(remainder) - 1, 2)
        ]
        won_set = reached_next.get(code, set())
        winners: List[str] = []
        for a, b in known + filler:
            if a in won_set and b not in won_set:
                w = a                       # a already won this round (deeper row)
            elif b in won_set and a not in won_set:
                w = b
            else:
                ga, gb = sim_match(a, b, knockout=True, ratings=ratings)
                w = a if ga > gb else b
            stage[w] = max(stage[w], code + 1)
            winners.append(w)
        return winners

    # R16 participants are exactly the 16 teams in the R16 rows; deeper rounds
    # take the winners the previous round produced.
    r16_pool = [t for tie in ties_by_stage.get(2, []) for t in tie]
    qf = play_round(r16_pool, 2)   # R16 → QF   (pins real R16 ties, banks decided)
    sf = play_round(qf, 3)         # QF  → SF   (pins any entered QF ties)
    fin = play_round(sf, 4)        # SF  → Final
    play_round(fin, 5)             # Final      → champion
    return stage


def run_one_tournament(
    played: Optional[PlayedResults] = None,
    ratings: Optional[dict] = None,
    bracket: "Optional[KnockoutBracket]" = None,
) -> Dict[str, int]:
    """Returns dict: team → furthest stage (0=group .. 6=champion).

    `played` (from wc.results.load_played_results) banks completed group results;
    None re-simulates the full group stage (pre-tournament / standalone behaviour).
    `ratings` (from wc.form.adjusted_ratings) is form-adjusted strength applied to
    all UNPLAYED fixtures (group + knockout); None uses the frozen TEAMS table.
    `bracket` (from wc.results.load_knockout_bracket) is the real knockout tree;
    once the full Round of 16 is known the bracket is seeded from it (pinning
    every entered round) instead of re-simulated from group standings — see
    _run_pinned_knockout.
    """
    if bracket is not None and bracket.is_pinnable():
        return _run_pinned_knockout(bracket, ratings)
    stage = {t: 0 for t in ALL_TEAMS}
    advancers: List[str] = []
    third_pool: List[Tuple[Tuple[int, int, int], str]] = []

    for letter, teams in GROUPS.items():
        ranked, stats = sim_group(teams, played, ratings)
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
            ga, gb = sim_match(a, b, knockout=True, ratings=ratings)
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
