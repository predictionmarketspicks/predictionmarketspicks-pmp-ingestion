"""
WC 2026 venue + environmental model.

Maps each of the 72 group-stage matches to its published 2026 venue and exposes
per-match λ adjustments for altitude and heat, per
`.claude/skills/wc-2026-edge/reference/environmental-adjustments.md`.

Venue assignments are real schedule data: transcribed from the published 2026
group-stage schedule (mirrored in the site's `data/wc2026-matches.json`; group
membership verified identical to `teams.GROUPS`). Keyed order-independently by
`(group_letter, tuple(sorted([home_slug, away_slug])))` since each pair meets
once in the group stage — robust to home/away ordering between the engine's
`_matchday_pairs` and the schedule feed.

CONTAINMENT (same strategy as the Dixon-Coles correction): these adjustments are
applied ONLY to the analytical match grid in `matches.py`. The Monte Carlo
champion% loop (`simulator.py`) stays venue-free, so the v2 champion seed and its
tight `validation.py` bands are unaffected — no seed rebuild, no `sim_run_id`
bump required for this change. (The KO bracket is a random-shuffle approximation
with no venue, so a group-only env there would be internally inconsistent for
marginal champion% effect.)

NOT modeled here (staged follow-ups, documented in the continuation handoff):
  - Travel fatigue (needs per-team match sequencing + inter-venue mileage).
  - Market-anchored ratings (changes `expected_goals` → breaks the seed; needs
    a de-vigged outright-odds pull).
"""
import math
from typing import Dict, List, Tuple

# ── Altitude ──────────────────────────────────────────────────────────────────
# (home_boost, visitor_penalty) log-rate adds per skill table. Only the three
# Mexican venues carry a non-trivial altitude effect; all US/Canada venues are
# <300m → 0. Boost goes to the altitude-acclimatized side; everyone else gets the
# penalty. If neither side is acclimatized (a non-Mexico match at a Mexican
# venue), BOTH sides take the visitor penalty (symmetric thin-air suppression).
ALTITUDE_LOGRATE: Dict[str, Tuple[float, float]] = {
    "Mexico City": (0.06, -0.04),   # Estadio Azteca ~2,240m
    "Guadalajara": (0.04, -0.03),   # Estadio Akron  ~1,566m
    "Monterrey":   (0.01, -0.01),   # Estadio BBVA   ~540m
}

# Mexico is the only altitude-acclimatized national side at the Mexican venues.
ALTITUDE_HOME_SLUG = "mexico"

# ── Heat ────────────────────────────────────────────────────────────────────
# Representative June/July afternoon-high climate normals for the hot venues
# (mirrors the site EnvironmentalModifierCallout heat set). Heat multiplies BOTH
# λ (slower tempo, fewer late high-xG chances): factor = 1 − 0.04·(temp−25)/10.
# We HALVE the raw penalty because kickoff time isn't in the schedule feed — only
# ~half the games at these venues are noon/15:00 kicks; evening kicks run cool.
HOT_VENUE_TEMP_C: Dict[str, int] = {
    "Dallas": 35, "Houston": 35, "Monterrey": 35,   # extreme afternoon heat
    "Miami": 32, "Atlanta": 31, "Kansas City": 31,  # moderate
}

# Heat-acclimated nations get a reduced penalty (skill §Heat).
HEAT_PENALTY_SCALE: Dict[str, float] = {
    "saudi-arabia": 0.5, "qatar": 0.5,   # Gulf schedules — penalty halved
    "mexico": 0.75, "brazil": 0.75,      # warm-weather sides — penalty −25%
}


def _heat_factor(team_slug: str, city: str) -> float:
    temp = HOT_VENUE_TEMP_C.get(city)
    if not temp or temp <= 25:
        return 1.0
    raw_penalty = 0.04 * (temp - 25) / 10.0
    penalty = (raw_penalty / 2.0) * HEAT_PENALTY_SCALE.get(team_slug, 1.0)
    return 1.0 - penalty


def match_env(group: str, home_slug: str, away_slug: str) -> dict:
    """Per-match environmental λ multipliers.

    Returns {"venue": city|None, "home_mult": float, "away_mult": float,
             "notes": [str, ...]}. Multipliers are 1.0 when the venue carries no
    altitude/heat effect. Apply as: λ_adj = λ * mult.
    """
    city = MATCH_VENUE.get((group, tuple(sorted([home_slug, away_slug]))))
    h_log = a_log = 0.0
    h_heat = a_heat = 1.0
    notes: List[str] = []

    if city:
        if city in ALTITUDE_LOGRATE:
            boost, pen = ALTITUDE_LOGRATE[city]
            h_log = boost if home_slug == ALTITUDE_HOME_SLUG else pen
            a_log = boost if away_slug == ALTITUDE_HOME_SLUG else pen
            notes.append(f"altitude:{city}")
        h_heat = _heat_factor(home_slug, city)
        a_heat = _heat_factor(away_slug, city)
        if h_heat < 1.0 or a_heat < 1.0:
            notes.append(f"heat:{city}")

    return {
        "venue":     city,
        "home_mult": math.exp(h_log) * h_heat,
        "away_mult": math.exp(a_log) * a_heat,
        "notes":     notes,
    }


# ── Match → venue city (published 2026 group-stage schedule) ──────────────────
# Key: (group_letter, tuple(sorted([home_slug, away_slug]))). Value: venue city.
MATCH_VENUE: Dict[Tuple[str, Tuple[str, str]], str] = {
    ("A", ("czechia", "korea-republic")): "Guadalajara",
    ("A", ("czechia", "mexico")): "Mexico City",
    ("A", ("czechia", "south-africa")): "Atlanta",
    ("A", ("korea-republic", "mexico")): "Guadalajara",
    ("A", ("korea-republic", "south-africa")): "Monterrey",
    ("A", ("mexico", "south-africa")): "Mexico City",
    ("B", ("bosnia", "canada")): "Toronto",
    ("B", ("bosnia", "qatar")): "Seattle",
    ("B", ("bosnia", "switzerland")): "Los Angeles",
    ("B", ("canada", "qatar")): "Vancouver",
    ("B", ("canada", "switzerland")): "Vancouver",
    ("B", ("qatar", "switzerland")): "Santa Clara",
    ("C", ("brazil", "haiti")): "Philadelphia",
    ("C", ("brazil", "morocco")): "East Rutherford",
    ("C", ("brazil", "scotland")): "Miami",
    ("C", ("haiti", "morocco")): "Atlanta",
    ("C", ("haiti", "scotland")): "Foxborough",
    ("C", ("morocco", "scotland")): "Foxborough",
    ("D", ("australia", "paraguay")): "Santa Clara",
    ("D", ("australia", "turkiye")): "Vancouver",
    ("D", ("australia", "united-states")): "Seattle",
    ("D", ("paraguay", "turkiye")): "Santa Clara",
    ("D", ("paraguay", "united-states")): "Los Angeles",
    ("D", ("turkiye", "united-states")): "Los Angeles",
    ("E", ("cote-divoire", "curacao")): "Philadelphia",
    ("E", ("cote-divoire", "ecuador")): "Philadelphia",
    ("E", ("cote-divoire", "germany")): "Toronto",
    ("E", ("curacao", "ecuador")): "Kansas City",
    ("E", ("curacao", "germany")): "Houston",
    ("E", ("ecuador", "germany")): "East Rutherford",
    ("F", ("japan", "netherlands")): "Dallas",
    ("F", ("japan", "sweden")): "Dallas",
    ("F", ("japan", "tunisia")): "Monterrey",
    ("F", ("netherlands", "sweden")): "Houston",
    ("F", ("netherlands", "tunisia")): "Kansas City",
    ("F", ("sweden", "tunisia")): "Monterrey",
    ("G", ("belgium", "egypt")): "Seattle",
    ("G", ("belgium", "iran")): "Los Angeles",
    ("G", ("belgium", "new-zealand")): "Vancouver",
    ("G", ("egypt", "iran")): "Seattle",
    ("G", ("egypt", "new-zealand")): "Vancouver",
    ("G", ("iran", "new-zealand")): "Los Angeles",
    ("H", ("cape-verde", "saudi-arabia")): "Houston",
    ("H", ("cape-verde", "spain")): "Atlanta",
    ("H", ("cape-verde", "uruguay")): "Miami",
    ("H", ("saudi-arabia", "spain")): "Atlanta",
    ("H", ("saudi-arabia", "uruguay")): "Miami",
    ("H", ("spain", "uruguay")): "Guadalajara",
    ("I", ("france", "iraq")): "Philadelphia",
    ("I", ("france", "norway")): "Foxborough",
    ("I", ("france", "senegal")): "East Rutherford",
    ("I", ("iraq", "norway")): "Foxborough",
    ("I", ("iraq", "senegal")): "Toronto",
    ("I", ("norway", "senegal")): "East Rutherford",
    ("J", ("algeria", "argentina")): "Kansas City",
    ("J", ("algeria", "austria")): "Kansas City",
    ("J", ("algeria", "jordan")): "Santa Clara",
    ("J", ("argentina", "austria")): "Dallas",
    ("J", ("argentina", "jordan")): "Dallas",
    ("J", ("austria", "jordan")): "Santa Clara",
    ("K", ("colombia", "dr-congo")): "Guadalajara",
    ("K", ("colombia", "portugal")): "Miami",
    ("K", ("colombia", "uzbekistan")): "Mexico City",
    ("K", ("dr-congo", "portugal")): "Houston",
    ("K", ("dr-congo", "uzbekistan")): "Atlanta",
    ("K", ("portugal", "uzbekistan")): "Houston",
    ("L", ("croatia", "england")): "Dallas",
    ("L", ("croatia", "ghana")): "Philadelphia",
    ("L", ("croatia", "panama")): "Toronto",
    ("L", ("england", "ghana")): "Foxborough",
    ("L", ("england", "panama")): "East Rutherford",
    ("L", ("ghana", "panama")): "Toronto",
}

assert len(MATCH_VENUE) == 72, f"expected 72 venue entries, got {len(MATCH_VENUE)}"
