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

    # Travel fatigue: each side carries a log-rate penalty into this match based on
    # the mileage from its PREVIOUS group match's venue (0 for matchday 1). Keyed by
    # the unordered pair, per team slug. See TRAVEL_LOGADJ builder below.
    travel = TRAVEL_LOGADJ.get((group, tuple(sorted([home_slug, away_slug]))), {})
    h_travel = travel.get(home_slug, 0.0)
    a_travel = travel.get(away_slug, 0.0)
    if h_travel < 0.0 or a_travel < 0.0:
        notes.append("travel")

    return {
        "venue":     city,
        "home_mult": math.exp(h_log + h_travel) * h_heat,
        "away_mult": math.exp(a_log + a_travel) * a_heat,
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


# ── Travel fatigue ────────────────────────────────────────────────────────────
# Real published matchday (1/2/3) for each pairing — orders each team's three
# group games so we can measure venue-to-venue travel. (Transcribed from the same
# published schedule as MATCH_VENUE.)
MATCH_MD: Dict[Tuple[str, Tuple[str, str]], int] = {
    ("A", ("czechia", "korea-republic")): 1, ("A", ("czechia", "mexico")): 3,
    ("A", ("czechia", "south-africa")): 2, ("A", ("korea-republic", "mexico")): 2,
    ("A", ("korea-republic", "south-africa")): 3, ("A", ("mexico", "south-africa")): 1,
    ("B", ("bosnia", "canada")): 1, ("B", ("bosnia", "qatar")): 3,
    ("B", ("bosnia", "switzerland")): 2, ("B", ("canada", "qatar")): 2,
    ("B", ("canada", "switzerland")): 3, ("B", ("qatar", "switzerland")): 1,
    ("C", ("brazil", "haiti")): 2, ("C", ("brazil", "morocco")): 1,
    ("C", ("brazil", "scotland")): 3, ("C", ("haiti", "morocco")): 3,
    ("C", ("haiti", "scotland")): 1, ("C", ("morocco", "scotland")): 2,
    ("D", ("australia", "paraguay")): 3, ("D", ("australia", "turkiye")): 1,
    ("D", ("australia", "united-states")): 2, ("D", ("paraguay", "turkiye")): 2,
    ("D", ("paraguay", "united-states")): 1, ("D", ("turkiye", "united-states")): 3,
    ("E", ("cote-divoire", "curacao")): 3, ("E", ("cote-divoire", "ecuador")): 1,
    ("E", ("cote-divoire", "germany")): 2, ("E", ("curacao", "ecuador")): 2,
    ("E", ("curacao", "germany")): 1, ("E", ("ecuador", "germany")): 3,
    ("F", ("japan", "netherlands")): 1, ("F", ("japan", "sweden")): 3,
    ("F", ("japan", "tunisia")): 2, ("F", ("netherlands", "sweden")): 2,
    ("F", ("netherlands", "tunisia")): 3, ("F", ("sweden", "tunisia")): 1,
    ("G", ("belgium", "egypt")): 1, ("G", ("belgium", "iran")): 2,
    ("G", ("belgium", "new-zealand")): 3, ("G", ("egypt", "iran")): 3,
    ("G", ("egypt", "new-zealand")): 2, ("G", ("iran", "new-zealand")): 1,
    ("H", ("cape-verde", "saudi-arabia")): 3, ("H", ("cape-verde", "spain")): 1,
    ("H", ("cape-verde", "uruguay")): 2, ("H", ("saudi-arabia", "spain")): 2,
    ("H", ("saudi-arabia", "uruguay")): 1, ("H", ("spain", "uruguay")): 3,
    ("I", ("france", "iraq")): 2, ("I", ("france", "norway")): 3,
    ("I", ("france", "senegal")): 1, ("I", ("iraq", "norway")): 1,
    ("I", ("iraq", "senegal")): 3, ("I", ("norway", "senegal")): 2,
    ("J", ("algeria", "argentina")): 1, ("J", ("algeria", "austria")): 3,
    ("J", ("algeria", "jordan")): 2, ("J", ("argentina", "austria")): 2,
    ("J", ("argentina", "jordan")): 3, ("J", ("austria", "jordan")): 1,
    ("K", ("colombia", "dr-congo")): 2, ("K", ("colombia", "portugal")): 3,
    ("K", ("colombia", "uzbekistan")): 1, ("K", ("dr-congo", "portugal")): 1,
    ("K", ("dr-congo", "uzbekistan")): 3, ("K", ("portugal", "uzbekistan")): 2,
    ("L", ("croatia", "england")): 1, ("L", ("croatia", "ghana")): 3,
    ("L", ("croatia", "panama")): 2, ("L", ("england", "ghana")): 2,
    ("L", ("england", "panama")): 3, ("L", ("ghana", "panama")): 1,
}
assert len(MATCH_MD) == 72, f"expected 72 matchday entries, got {len(MATCH_MD)}"

# Venue coordinates (lat, lon) for the 16 host stadiums — public geographic facts.
VENUE_LATLON: Dict[str, Tuple[float, float]] = {
    "Mexico City": (19.30, -99.15), "Guadalajara": (20.68, -103.46), "Monterrey": (25.67, -100.24),
    "Atlanta": (33.75, -84.40), "Dallas": (32.75, -97.09), "Houston": (29.68, -95.41),
    "Kansas City": (39.05, -94.48), "Miami": (25.96, -80.24), "Foxborough": (42.09, -71.26),
    "East Rutherford": (40.81, -74.07), "Philadelphia": (39.90, -75.17), "Toronto": (43.63, -79.42),
    "Vancouver": (49.28, -123.11), "Seattle": (47.59, -122.33), "Santa Clara": (37.40, -121.97),
    "Los Angeles": (33.95, -118.34),
}


def _haversine_miles(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def _travel_logadj(miles: float) -> float:
    """Per skill: 0–500mi → 0, 500–1500 → −0.02, 1500–3000 → −0.04, 3000+ → −0.06."""
    if miles < 500:
        return 0.0
    if miles < 1500:
        return -0.02
    if miles < 3000:
        return -0.04
    return -0.06


# (group, sorted-pair) → {slug: travel log-rate into THIS match}. Built once: for
# each team, order its 3 group games by matchday and measure mileage from the
# previous venue (matchday 1 = 0, no prior match).
def _build_travel() -> Dict[Tuple[str, Tuple[str, str]], Dict[str, float]]:
    # team (group, slug) → list of (md, city, pair_key)
    sched: Dict[Tuple[str, str], list] = {}
    for key, md in MATCH_MD.items():
        group, pair = key
        city = MATCH_VENUE[key]
        for slug in pair:
            sched.setdefault((group, slug), []).append((md, city, key))

    out: Dict[Tuple[str, Tuple[str, str]], Dict[str, float]] = {}
    for (group, slug), games in sched.items():
        games.sort(key=lambda g: g[0])  # by matchday
        prev_city = None
        for _md, city, key in games:
            if prev_city is None or prev_city == city:
                adj = 0.0
            else:
                adj = _travel_logadj(_haversine_miles(VENUE_LATLON[prev_city], VENUE_LATLON[city]))
            out.setdefault(key, {})[slug] = adj
            prev_city = city
    return out


TRAVEL_LOGADJ = _build_travel()
