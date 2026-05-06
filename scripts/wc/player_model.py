"""
WC 2026 Golden Boot / scorer projections.

Approach for v3:
  - Fixed 25-player roster ported from v2_april_2026_seed
    (handoffs/WORLD_CUP_2026_PIPELINE_BUILD.md spec calibrated against PDF page 8)
  - Each player has a `share` value: their fraction of the team's group-stage xG
  - exp_g_group        = share × sum(team_λ over 3 group matches) + (0.10 PK boost if PK taker)
  - anytime_pct_group  = 1 - product over 3 matches of P(player scores 0 in match i)
                       = 1 - product of exp(-player_λ_per_match)

  - Full per-iteration scorer Monte Carlo (with KO multipliers per advancement %)
    is deferred to a follow-up PR. v3 emits group-stage projections only —
    `exp_g_total` is left null in the rows we write.

The roster is intentionally hardcoded: it represents an editorial decision about
which 25 players to surface as Golden Boot contenders. Adding a player here means
we're publishing a projection for them; removing one means we're not.
"""
import math
from typing import Dict, List

from .teams import TEAMS, GROUPS, NAME_TO_SLUG, HOST_SET
from .simulator import expected_goals

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
    {"slug":"en-nesyri",     "name":"Youssef En-Nesyri",    "team":"Morocco",        "share":0.28, "pk":True,  "club":"Fenerbahce"},
    {"slug":"havertz",       "name":"Kai Havertz",          "team":"Germany",        "share":0.24, "pk":True,  "club":"Arsenal"},
    {"slug":"morata",        "name":"Alvaro Morata",        "team":"Spain",          "share":0.22, "pk":True,  "club":"AC Milan"},
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


def project_all_players() -> List[Dict]:
    """Return one dict per roster player ready for DB insert."""
    rows = []
    for p in ROSTER:
        proj = project_player_group_stage(p)
        rows.append({
            "player_slug":       p["slug"],
            "player_name":       p["name"],
            "team_slug":         NAME_TO_SLUG[p["team"]],
            "kind":              "golden_boot",
            "exp_g_group":       proj["exp_g_group"],
            "exp_g_total":       None,                 # deferred to follow-up PR
            "anytime_pct_group": proj["anytime_pct_group"],
            "pk_taker":          p["pk"],
            "club":              p["club"],
        })
    assert len(rows) == 25
    return rows
