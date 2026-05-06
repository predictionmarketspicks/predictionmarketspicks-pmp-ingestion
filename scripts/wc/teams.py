"""
WC 2026 team registry. Single source of truth for:
  - strength ratings (Off/Def Elo-tier, Apr 2026 v2 calibration)
  - groups
  - host status
  - display name → DB slug
  - display name → FIFA tri-code (used in match entity_ids)

Ratings + groups ported verbatim from /Users/benny/projects/predictionmarketspicks/
wc2026_sim_v2.py — the script that produced v2_april_2026_seed.
"""

# ── Team strength ratings ─────────────────────────────────────────────────────
# O/D scale: 1500 = average. Calibrated so elite vs minnow ~85-92%, peers ~40-30-30.
# Source: aggregate of FIFA, eloratings.net, SPI tiers as of April 2026.
TEAMS = {
    # Elite contenders
    "Spain":        (1920, 1880),
    "France":       (1905, 1860),
    "England":      (1890, 1850),
    "Brazil":       (1880, 1830),
    "Argentina":    (1875, 1840),
    "Germany":      (1850, 1810),
    "Portugal":     (1830, 1800),
    "Netherlands":  (1820, 1795),
    # Strong
    "Belgium":      (1790, 1760),
    "Croatia":      (1760, 1770),
    "Colombia":     (1760, 1740),
    "Uruguay":      (1770, 1735),
    "Morocco":      (1740, 1790),
    "Switzerland":  (1720, 1760),
    "Japan":        (1730, 1720),
    "Senegal":      (1725, 1710),
    "Mexico":       (1710, 1700),
    "United States":(1700, 1695),
    "Ecuador":      (1680, 1730),
    "Cote d'Ivoire":(1690, 1700),
    # Solid / mid
    "Iran":         (1660, 1700),
    "Egypt":        (1650, 1685),
    "Korea Republic":(1660, 1660),
    "Australia":    (1650, 1680),
    "Canada":       (1655, 1650),
    "Türkiye":      (1665, 1650),
    "Norway":       (1680, 1640),
    "Sweden":       (1650, 1660),
    "Austria":      (1660, 1665),
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
