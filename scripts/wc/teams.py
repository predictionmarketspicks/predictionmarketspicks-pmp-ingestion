"""
WC 2026 team registry. Single source of truth for:
  - strength ratings (Off/Def, v4 market-anchored calibration, May 2026)
  - groups
  - host status
  - display name → DB slug
  - display name → FIFA tri-code (used in match entity_ids)

Groups/slugs/tri-codes are unchanged from the original wc2026_sim_v2.py registry.

Ratings are v4 MARKET-ANCHORED (sim_run_id prefix v4_, replaces v2_april_2026_seed):
each team's overall strength was calibrated so the deterministic sim (10000 iters,
seed=42) reproduces a champion distribution that is a 50/50 blend of the original
Elo model and the de-vigged DraftKings outright market (operator snapshot
2026-05-31; cross-checked vs de-vigged Kalshi KXWORLDCUP). The blend is the target;
calibrate_ratings.py solved for the ratings that produce it (fixed point on overall
strength, preserving each team's Off−Def differential). Market snapshot + weight
live in market_anchor.py (W_MARKET = 0.50). The seed values are the validation
source of truth in validation.py SPOT_CHECKS. To re-anchor: refresh the board in
market_anchor.py, re-run `python -m wc.calibrate_ratings`, paste the new TEAMS +
SPOT_CHECKS, bump the sim_run_id prefix.
"""

# ── Team strength ratings (v4 market-anchored) ───────────────────────────────
# O/D scale: 1500 = average. Off−Def differential preserved from the v2 Elo tiers;
# overall strength shifted toward the 50/50 model-market champion blend.
TEAMS = {
    # Elite contenders
    "Spain":        (1902, 1862),
    "France":       (1894, 1849),
    "England":      (1878, 1838),
    "Brazil":       (1869, 1819),
    "Argentina":    (1857, 1822),
    "Germany":      (1837, 1797),
    "Portugal":     (1834, 1804),
    "Netherlands":  (1813, 1788),
    # Strong
    "Belgium":      (1780, 1750),
    "Croatia":      (1738, 1748),
    "Colombia":     (1763, 1743),
    "Uruguay":      (1764, 1729),
    "Morocco":      (1728, 1778),
    "Switzerland":  (1715, 1755),
    "Japan":        (1740, 1730),
    "Senegal":      (1730, 1715),
    "Mexico":       (1715, 1705),
    "United States":(1724, 1719),
    "Ecuador":      (1686, 1736),
    "Cote d'Ivoire":(1685, 1695),
    # Solid / mid
    "Iran":         (1646, 1686),
    "Egypt":        (1650, 1685),
    "Korea Republic":(1660, 1660),
    "Australia":    (1650, 1680),
    "Canada":       (1655, 1650),
    "Türkiye":      (1709, 1694),
    "Norway":       (1760, 1720),
    "Sweden":       (1699, 1709),
    "Austria":      (1684, 1689),
    "Tunisia":      (1620, 1680),
    "Algeria":      (1640, 1660),
    # Lower-mid
    "Czechia":      (1600, 1630),
    "Ghana":        (1610, 1590),
    "Paraguay":     (1590, 1620),
    "Scotland":     (1605, 1615),
    "Bosnia and Herzegovina": (1590, 1600),
    "Qatar":        (1560, 1610),
    "Saudi Arabia": (1555, 1600),
    "New Zealand":  (1550, 1585),
    "Panama":       (1560, 1580),
    "DR Congo":     (1580, 1570),
    "Jordan":       (1545, 1600),
    "Uzbekistan":   (1570, 1580),
    "South Africa": (1560, 1575),
    # Long shots
    "Iraq":         (1500, 1560),
    "Cape Verde":   (1510, 1540),
    "Haiti":        (1500, 1530),
    "Curacao":      (1450, 1490),
}

# ── Groups ────────────────────────────────────────────────────────────────────
GROUPS = {
    "A": ["Mexico",        "Korea Republic", "South Africa",            "Czechia"],
    "B": ["Canada",        "Switzerland",    "Qatar",                   "Bosnia and Herzegovina"],
    "C": ["Brazil",        "Morocco",        "Scotland",                "Haiti"],
    "D": ["United States", "Australia",      "Paraguay",                "Türkiye"],
    "E": ["Germany",       "Cote d'Ivoire",  "Ecuador",                 "Curacao"],
    "F": ["Netherlands",   "Japan",          "Tunisia",                 "Sweden"],
    "G": ["Belgium",       "Iran",           "Egypt",                   "New Zealand"],
    "H": ["Spain",         "Uruguay",        "Saudi Arabia",            "Cape Verde"],
    "I": ["France",        "Senegal",        "Norway",                  "Iraq"],
    "J": ["Argentina",     "Austria",        "Algeria",                 "Jordan"],
    "K": ["Portugal",      "Colombia",       "Uzbekistan",              "DR Congo"],
    "L": ["England",       "Croatia",        "Ghana",                   "Panama"],
}

ALL_TEAMS = [t for g in GROUPS.values() for t in g]
assert len(ALL_TEAMS) == 48, f"expected 48 teams, got {len(ALL_TEAMS)}"

# Mexico/USA/Canada are the three hosts (FIFA-confirmed).
HOST_SET = {"Mexico", "United States", "Canada"}

# ── Display name → DB slug (matches v2_april_2026_seed entity_ids) ────────────
NAME_TO_SLUG = {
    "Spain": "spain", "France": "france", "England": "england", "Brazil": "brazil",
    "Argentina": "argentina", "Germany": "germany", "Portugal": "portugal",
    "Netherlands": "netherlands", "Belgium": "belgium", "Croatia": "croatia",
    "Colombia": "colombia", "Uruguay": "uruguay", "Morocco": "morocco",
    "Switzerland": "switzerland", "Japan": "japan", "Senegal": "senegal",
    "Mexico": "mexico", "United States": "united-states", "Ecuador": "ecuador",
    "Cote d'Ivoire": "cote-divoire", "Iran": "iran", "Egypt": "egypt",
    "Korea Republic": "korea-republic", "Australia": "australia", "Canada": "canada",
    "Türkiye": "turkiye", "Norway": "norway", "Sweden": "sweden", "Austria": "austria",
    "Tunisia": "tunisia", "Algeria": "algeria", "Czechia": "czechia", "Ghana": "ghana",
    "Paraguay": "paraguay", "Scotland": "scotland",
    "Bosnia and Herzegovina": "bosnia", "Qatar": "qatar", "Saudi Arabia": "saudi-arabia",
    "New Zealand": "new-zealand", "Panama": "panama", "DR Congo": "dr-congo",
    "Jordan": "jordan", "Uzbekistan": "uzbekistan", "South Africa": "south-africa",
    "Iraq": "iraq", "Cape Verde": "cape-verde", "Haiti": "haiti", "Curacao": "curacao",
}

# Display name → FIFA tri-code (used in match entity_ids: match:I-MD1-FRA-SEN).
NAME_TO_TRI = {
    "Spain": "ESP", "France": "FRA", "England": "ENG", "Brazil": "BRA",
    "Argentina": "ARG", "Germany": "GER", "Portugal": "POR", "Netherlands": "NED",
    "Belgium": "BEL", "Croatia": "CRO", "Colombia": "COL", "Uruguay": "URU",
    "Morocco": "MOR", "Switzerland": "SUI", "Japan": "JPN", "Senegal": "SEN",
    "Mexico": "MEX", "United States": "USA", "Ecuador": "ECU", "Cote d'Ivoire": "CIV",
    "Iran": "IRN", "Egypt": "EGY", "Korea Republic": "KOR", "Australia": "AUS",
    "Canada": "CAN", "Türkiye": "TUR", "Norway": "NOR", "Sweden": "SWE",
    "Austria": "AUT", "Tunisia": "TUN", "Algeria": "ALG", "Czechia": "CZE",
    "Ghana": "GHA", "Paraguay": "PAR", "Scotland": "SCO",
    "Bosnia and Herzegovina": "BIH", "Qatar": "QAT", "Saudi Arabia": "KSA",
    "New Zealand": "NZL", "Panama": "PAN", "DR Congo": "COD", "Jordan": "JOR",
    "Uzbekistan": "UZB", "South Africa": "RSA", "Iraq": "IRQ",
    "Cape Verde": "CPV", "Haiti": "HAI", "Curacao": "CUW",
}

# Sanity: every team has a slug + tri-code.
for _t in ALL_TEAMS:
    assert _t in TEAMS, f"team {_t!r} missing strength rating"
    assert _t in NAME_TO_SLUG, f"team {_t!r} missing slug"
    assert _t in NAME_TO_TRI, f"team {_t!r} missing tri-code"
