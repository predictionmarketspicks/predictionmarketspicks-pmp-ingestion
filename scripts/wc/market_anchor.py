"""
Market anchor for the v4 market-anchored ratings calibration.

This module is the FROZEN record of the de-vigged outright-winner market used to
calibrate teams.py away from pure Elo toward market-implied strength. It is a
one-time calibration input, NOT a live feed — the resulting ratings are baked
into teams.py and reproduced deterministically (seed=42). Re-running the sim does
not re-read this file; it exists so the calibration is auditable and repeatable.

Source: DraftKings outright "World Cup 2026 Winner" board, operator snapshot
2026-05-31 (full 48-team coverage). Cross-checked against the de-vigged Kalshi
KXWORLDCUP champion market (27 teams) — agreement at the top is tight: both have
Spain/France as co-favorites, Portugal elevated well above model, Norway as the
dark-horse. DraftKings is used as the anchor only because it prices all 48 teams;
Kalshi leaves the bottom 21 unpriced. (The corrupted DraftKings rows in
world_cup_market_latest — Sweden 99c, Austria 66c — are a Fly-writer
entity-mapping bug and are bypassed entirely by this hand-verified board.)

Blend weight W_MARKET = 0.50 (operator sign-off 2026-05-31): the calibrated
champion seed is 50% de-vigged market, 50% Elo model, renormalized to 100.
"""
from typing import Dict

# Blend weight: fraction of the de-vigged market in the champion-seed target.
W_MARKET = 0.50

# ── DraftKings outright board, keyed by teams.py canonical display name ────────
# American odds, operator snapshot 2026-05-31.
DK_OUTRIGHT_AMERICAN: Dict[str, int] = {
    "Spain": 475, "France": 500, "England": 650, "Brazil": 850, "Argentina": 900,
    "Portugal": 1000, "Germany": 1400, "Netherlands": 2200, "Belgium": 3500,
    "Norway": 3500, "Colombia": 4000, "Morocco": 5000, "Uruguay": 5000,
    "United States": 6000, "Switzerland": 6500, "Japan": 6500, "Ecuador": 8000,
    "Croatia": 8000, "Mexico": 8000, "Senegal": 9000, "Türkiye": 10000,
    "Sweden": 10000, "Austria": 15000, "Scotland": 20000, "Canada": 20000,
    "Czechia": 25000, "Cote d'Ivoire": 25000, "Ghana": 30000, "Egypt": 30000,
    "Paraguay": 30000, "Algeria": 35000, "Korea Republic": 40000, "Tunisia": 50000,
    "Bosnia and Herzegovina": 50000, "Australia": 60000, "Iran": 70000,
    "DR Congo": 100000, "South Africa": 100000, "Cape Verde": 100000,
    "Saudi Arabia": 100000, "Panama": 100000, "Uzbekistan": 150000,
    "Qatar": 150000, "New Zealand": 150000, "Iraq": 150000, "Haiti": 250000,
    "Curacao": 250000, "Jordan": 250000,
}


def american_to_prob(odds: int) -> float:
    """American odds → raw (vigged) implied probability. Positive odds only here."""
    if odds >= 0:
        return 100.0 / (odds + 100.0)
    return -odds / (-odds + 100.0)


def market_champ_pct() -> Dict[str, float]:
    """De-vigged market champion probability per team, in percent, summing to 100.

    Multiplicative (proportional) de-vig: normalize raw implied probs to sum 1.
    """
    raw = {team: american_to_prob(o) for team, o in DK_OUTRIGHT_AMERICAN.items()}
    overhead = sum(raw.values())  # > 1.0 by the vig
    return {team: p / overhead * 100.0 for team, p in raw.items()}


if __name__ == "__main__":
    pct = market_champ_pct()
    overhead = sum(american_to_prob(o) for o in DK_OUTRIGHT_AMERICAN.values())
    print(f"teams: {len(DK_OUTRIGHT_AMERICAN)}  overhead: {overhead:.4f}  "
          f"de-vig factor: {1/overhead:.4f}  sum(devig): {sum(pct.values()):.2f}")
    for team, p in sorted(pct.items(), key=lambda kv: -kv[1])[:12]:
        print(f"  {team:<26} {p:5.2f}%")
