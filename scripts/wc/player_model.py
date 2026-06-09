"""
WC 2026 Golden Boot / scorer projections.

Approach for v3:
  - Fixed 25-player roster ported from v2_april_2026_seed
    (handoffs/WORLD_CUP_2026_PIPELINE_BUILD.md spec calibrated against PDF page 8)
  - Each player has a `share` value: their fraction of the team's group-stage xG
  - exp_g_group        = share × sum(team_λ over 3 group matches) + (0.10 PK boost if PK taker)
  - anytime_pct_group  = 1 - product over 3 matches of P(player scores 0 in match i)
                       = 1 - product of exp(-player_λ_per_match)

  - exp_g_total + golden_boot_pct come from a tournament-long scorer Monte Carlo
    (`_simulate_boot`): each iteration reuses the team-progression realization from
    the main champion sim to decide how many matches each player's team plays
    (3 group + KO matches by furthest stage), samples per-match goals
    ~Poisson(player_λ), and tracks the per-iteration goal leader.
      exp_g_total      = mean tournament goals across iterations
      golden_boot_pct  = share of iterations the player is the (tied) goal leader
    A single calibrated FIELD competitor stands in for the ~575 untracked players
    so the 25 roster boot%s do NOT sum to 100 — see FIELD_* below. golden_boot_pct
    is stored in metadata (no dedicated column); exp_g_total fills the existing column.

The roster is intentionally hardcoded: it represents an editorial decision about
which 25 players to surface as Golden Boot contenders. Adding a player here means
we're publishing a projection for them; removing one means we're not.

2026-06-08 final-squad correction: En-Nesyri → Ayoub El Kaabi (Morocco; El Kaabi is
the striker, pk=False since Brahim Diaz takes Morocco's PKs) and Morata → Mikel
Oyarzabal (Spain PK taker). Both cut players were off their nation's final 26.
Shares/clubs reuse the vacated slot per the clean-sweep placeholder rule.
"""
from __future__ import annotations

import math
import random
from typing import Dict, List

from .teams import TEAMS, GROUPS, NAME_TO_SLUG, HOST_SET
from .simulator import expected_goals, poisson, run_one_tournament

# ── Boot Monte Carlo tunables ─────────────────────────────────────────────────
BOOT_SEED = 20260611            # deterministic goal draws (kickoff date)
BOOT_ITERS_STANDALONE = 10000   # used only when project_all_players() gets no stages
# The FIELD competitor models "the best of the ~575 untracked players." Without it,
# argmax over only our 25 contenders would make their boot%s sum to 100 — wildly
# overstating each. A deep-run field at this per-match rate captures a realistic
# chunk of outcomes (a non-favorite wins the Boot fairly often historically). v1
# assumption — tune FIELD_PER_MATCH_LAMBDA against realized Kalshi golden-boot
# pricing once markets are liquid. exp_g_total is model-robust; golden_boot_pct is
# field-assumption-dependent.
FIELD_PER_MATCH_LAMBDA = 0.95   # calibrated → field wins ~26% (top boot ~24%)
FIELD_MATCHES = 7               # field's best player typically reaches ~SF

# ── Roster: 25 contenders ─────────────────────────────────────────────────────
# Schema: slug, name, team_display_name, share_of_team_group_xg, pk_taker, club
# Shares are calibrated so computed exp_g_group lands within 5% of seed numbers.
ROSTER: List[Dict] = [
    {"slug":"mbappe",        "name":"Kylian Mbappé",        "team":"France",         "share":0.34, "pk":True,  "club":"Real Madrid"},
    {"slug":"haaland",       "name":"Erling Haaland",       "team":"Norway",         "share":0.36, "pk":True,  "club":"Man City"},
    {"slug":"kane",          "name":"Harry Kane",           "team":"England",        "share":0.30, "pk":True,  "club":"Bayern Munich"},
    {"slug":"dzeko",         "name":"Edin Dzeko",           "team":"Bosnia and Herzegovina","share":0.36,"pk":True,"club":"Fenerbahce"},
    {"slug":"son",           "name":"Son Heung-min",        "team":"Korea Republic", "share":0.34, "pk":True,  "club":"Tottenham"},
    {"slug":"vinicius",      "name":"Vinicius Jr",          "team":"Brazil",         "share":0.28, "pk":True,  "club":"Real Madrid"},
    {"slug":"lautaro",       "name":"Lautaro Martinez",     "team":"Argentina",      "share":0.27, "pk":False, "club":"Inter Milan"},
    {"slug":"ronaldo",       "name":"Cristiano Ronaldo",    "team":"Portugal",       "share":0.27, "pk":True,  "club":"Al Nassr"},
    {"slug":"schick",        "name":"Patrik Schick",        "team":"Czechia",        "share":0.36, "pk":True,  "club":"Bayer Leverkusen"},
    {"slug":"lukaku",        "name":"Romelu Lukaku",        "team":"Belgium",        "share":0.27, "pk":True,  "club":"Roma"},
    {"slug":"gyokeres",      "name":"Viktor Gyökeres",      "team":"Sweden",         "share":0.34, "pk":True,  "club":"Arsenal"},
    {"slug":"jonathan-david","name":"Jonathan David",       "team":"Canada",         "share":0.32, "pk":True,  "club":"Lille"},
    {"slug":"gakpo",         "name":"Cody Gakpo",           "team":"Netherlands",    "share":0.27, "pk":True,  "club":"Liverpool"},
    {"slug":"al-hammadi",    "name":"Ali Al-Hammadi",       "team":"Iraq",           "share":0.40, "pk":True,  "club":"Al Ain"},
    {"slug":"gimenez",       "name":"Santiago Gimenez",     "team":"Mexico",         "share":0.28, "pk":True,  "club":"AC Milan"},
    {"slug":"pulisic",       "name":"Christian Pulisic",    "team":"United States",  "share":0.29, "pk":True,  "club":"AC Milan"},
    {"slug":"el-kaabi",      "name":"Ayoub El Kaabi",       "team":"Morocco",        "share":0.28, "pk":False, "club":"Olympiacos"},
    {"slug":"havertz",       "name":"Kai Havertz",          "team":"Germany",        "share":0.24, "pk":True,  "club":"Arsenal"},
    {"slug":"oyarzabal",     "name":"Mikel Oyarzabal",      "team":"Spain",          "share":0.22, "pk":True,  "club":"Real Sociedad"},
    {"slug":"embolo",        "name":"Breel Embolo",         "team":"Switzerland",    "share":0.28, "pk":False, "club":"Monaco"},
    {"slug":"bakambu",       "name":"Cédric Bakambu",       "team":"DR Congo",       "share":0.32, "pk":True,  "club":"Galatasaray"},
    {"slug":"darwin",        "name":"Darwin Nunez",         "team":"Uruguay",        "share":0.25, "pk":True,  "club":"Liverpool"},
    {"slug":"luis-diaz",     "name":"Luis Diaz",            "team":"Colombia",       "share":0.27, "pk":False, "club":"Liverpool"},
    {"slug":"kramaric",      "name":"Andrej Kramaric",      "team":"Croatia",        "share":0.27, "pk":True,  "club":"Hoffenheim"},
    {"slug":"mohanad-ali",   "name":"Mohanad Ali",          "team":"Iraq",           "share":0.30, "pk":False, "club":"Dibba Al-Fujairah"},
]


def _team_group_lambdas(team_name: str) -> List[float]:
    """Return the 3 per-match λ values for a team across its 3 group-stage games."""
    # Find the group this team belongs to.
    group_letter = next(g for g, members in GROUPS.items() if team_name in members)
    members = GROUPS[group_letter]
    opponents = [t for t in members if t != team_name]
    assert len(opponents) == 3
    oa, da = TEAMS[team_name]
    is_host = team_name in HOST_SET
    lams = []
    for opp in opponents:
        ob, db = TEAMS[opp]
        # We use the team_name as the "home" (host gets bump if applicable). For sim
        # purposes neither side is truly home in WC 2026 (mostly neutral venues),
        # but we mirror the simulator's treatment for consistency.
        lam = expected_goals(oa, db, host_a=is_host)
        lams.append(lam)
    return lams


def project_player_group_stage(p: Dict) -> Dict[str, float]:
    """Compute exp_g_group + anytime_pct_group for one roster entry."""
    lams = _team_group_lambdas(p["team"])
    pk_boost = 0.10 if p["pk"] else 0.0
    per_match = [lam * p["share"] + pk_boost / 3 for lam in lams]
    exp_g_group = sum(per_match)
    # P(scores at least once across 3 matches): 1 - product of P(0 goals in match i)
    p_zero_each = [math.exp(-lam) for lam in per_match]
    anytime_any_match = 1 - (p_zero_each[0] * p_zero_each[1] * p_zero_each[2])
    # Spec column anytime_pct_group is "probability of scoring at least one goal
    # in EACH group match" — i.e. average per-match anytime, not anytime-across-three.
    p_any_per_match = [1 - pz for pz in p_zero_each]
    anytime_avg = sum(p_any_per_match) / 3
    return {
        "exp_g_group":       round(exp_g_group, 3),
        "anytime_pct_group": round(anytime_avg * 100, 2),
    }


# Matches played by a team given its furthest stage code (0=group .. 6=champion):
#   3 group games + one KO game per round entered (R32..Final = up to 5).
def _matches_for_stage(stage: int) -> int:
    return 3 + (min(stage, 5) if stage >= 1 else 0)


def _simulate_boot(stages: List[Dict[str, int]]) -> Dict[str, Dict[str, float]]:
    """Tournament-long scorer MC over pre-computed team-progression realizations.

    Returns {slug: {"exp_g_total": float, "golden_boot_pct": float}}. Goal draws
    are seeded (BOOT_SEED) for reproducibility.
    """
    random.seed(BOOT_SEED)

    # Precompute each player's per-match group λ list + a KO per-match rate (the
    # mean of their group rates — KO opponents are unknown, so we reuse their
    # average attacking output).
    players = []
    for p in ROSTER:
        lams = _team_group_lambdas(p["team"])
        pk_per_match = (0.10 if p["pk"] else 0.0) / 3
        per_match = [lam * p["share"] + pk_per_match for lam in lams]
        ko_lam = sum(per_match) / 3
        players.append((p["slug"], p["team"], per_match, ko_lam))

    n = len(stages)
    wins = {slug: 0.0 for slug, *_ in players}
    total = {slug: 0.0 for slug, *_ in players}

    for stage in stages:
        goals: Dict[str, int] = {}
        for slug, team, per_match, ko_lam in players:
            n_ko = _matches_for_stage(stage.get(team, 0)) - 3
            g = sum(poisson(lam) for lam in per_match)
            for _ in range(n_ko):
                g += poisson(ko_lam)
            goals[slug] = g
            total[slug] += g

        # FIELD stand-in for the best untracked player this iteration.
        field_goals = sum(poisson(FIELD_PER_MATCH_LAMBDA) for _ in range(FIELD_MATCHES))

        max_tracked = max(goals.values()) if goals else 0
        # A roster player only wins the Boot if they out-score BOTH the rest of the
        # roster AND the field. Ties with the field go to the field (conservative).
        if max_tracked > 0 and max_tracked > field_goals:
            leaders = [s for s, gg in goals.items() if gg == max_tracked]
            for s in leaders:
                wins[s] += 1.0 / len(leaders)

    return {
        slug: {
            "exp_g_total":     round(total[slug] / n, 3),
            "golden_boot_pct": round(wins[slug] / n * 100, 2),
        }
        for slug, *_ in players
    }


def project_all_players(stages: List[Dict[str, int]] | None = None) -> List[Dict]:
    """Return one dict per roster player ready for DB insert.

    `stages` is the list of per-iteration team-progression dicts from the main
    champion sim (reused so the Boot MC matches the same tournament realizations).
    When omitted (standalone runs), a fresh internal tournament MC is run.
    """
    if stages is None:
        random.seed(BOOT_SEED)
        stages = [run_one_tournament() for _ in range(BOOT_ITERS_STANDALONE)]

    boot = _simulate_boot(stages)

    rows = []
    for p in ROSTER:
        proj = project_player_group_stage(p)
        b = boot[p["slug"]]
        rows.append({
            "player_slug":       p["slug"],
            "player_name":       p["name"],
            "team_slug":         NAME_TO_SLUG[p["team"]],
            "kind":              "golden_boot",
            "exp_g_group":       proj["exp_g_group"],
            "exp_g_total":       b["exp_g_total"],
            "anytime_pct_group": proj["anytime_pct_group"],
            "pk_taker":          p["pk"],
            "club":              p["club"],
            # golden_boot_pct has no dedicated column — carried in metadata.
            "metadata":          {"golden_boot_pct": b["golden_boot_pct"]},
        })
    assert len(rows) == 25
    return rows
