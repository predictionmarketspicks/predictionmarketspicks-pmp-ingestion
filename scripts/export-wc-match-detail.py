#!/usr/bin/env python3
"""Emit data/wc2026-match-detail.json for the brand-indigo match-prediction cards.

Keyed by the slug used in the site's wc2026-matches.json (so the Next.js card can
look up `detail[m.slug]`). Pure analytical path — Dixon-Coles grid via
wc.matches.match_grid_detail; no DB, no RNG, deterministic.

Each match's home/away orientation is taken FROM the site schedule (we call
match_grid_detail(home, away) with the site's home as team_a), so home_xg /
top_scores / W-D-L always match what the page displays — independent of the
engine's internal _matchday_pairs ordering.

Scorer bars are computed site-side (TypeScript) from team profiles + these xG
values, so this file carries only the grid-derived fields.

Run: cd /Users/benny/pmp-ingestion && python3 scripts/export-wc-match-detail.py
"""
from __future__ import annotations

import json
import os
import sys

# Make sibling `wc/` package importable (mirrors run-wc-sim.py).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from wc.matches import match_grid_detail  # noqa: E402
from wc.teams import TEAMS, NAME_TO_SLUG, HOST_SET  # noqa: E402
from wc.venues import match_env  # noqa: E402
from wc.simulator import KO_GOALS_MULT  # noqa: E402  # knockout goals damp (lower-scoring stage)

HERE = os.path.dirname(os.path.abspath(__file__))
SITE_DATA = os.path.normpath(
    os.path.join(HERE, "..", "..", "prediction-marketspicks", "data")
)
MATCHES_PATH = os.path.join(SITE_DATA, "wc2026-matches.json")
OUT_PATH = os.path.join(SITE_DATA, "wc2026-match-detail.json")

# Site display-name → model team-name aliases (only where the strings differ).
NAME_ALIAS = {
    "Bosnia & Herzegovina": "Bosnia and Herzegovina",
}


def model_name(site_name: str) -> str:
    return NAME_ALIAS.get(site_name, site_name)


def main() -> int:
    with open(MATCHES_PATH, encoding="utf-8") as f:
        matches = json.load(f)["matches"]

    detail: dict = {}
    skipped: list = []
    for m in matches:
        home = model_name(m["home"])
        away = model_name(m["away"])
        # Honest skip for unresolved/placeholder slots → site renders empty-state.
        if home not in TEAMS or away not in TEAMS:
            skipped.append(m["slug"])
            continue
        home_slug = NAME_TO_SLUG[home]
        away_slug = NAME_TO_SLUG[away]
        # Knockout fixtures carry an empty group ("") in wc2026-matches.json; they
        # score lower than the group stage, so damp both λ via the existing env
        # mult mechanism (mirrors sim_match's KO_GOALS_MULT in simulator.py).
        ko = KO_GOALS_MULT if m["group"] == "" else 1.0
        env = match_env(m["group"], home_slug, away_slug)
        d = match_grid_detail(
            home,
            away,
            host_a=(home in HOST_SET),
            host_b=(away in HOST_SET),
            home_mult=env["home_mult"] * ko,
            away_mult=env["away_mult"] * ko,
        )
        detail[m["slug"]] = {
            "home_xg": d["home_xg"],
            "away_xg": d["away_xg"],
            "total_xg": d["total_xg"],
            # W/D/L from the same Dixon-Coles grid (site home = team_a), so the
            # match page's model line stays live-accurate for knockout rows the
            # group matview never covers — no hand-set hw/d/aw to go stale.
            "home_win": d["hw"],
            "draw": d["d"],
            "away_win": d["aw"],
            "o15": d["o15"],
            "o25": d["o25"],
            "o35": d["o35"],
            "btts": d["btts"],
            "top_scores": d["top_scores"],
        }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(detail, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write("\n")

    print(f"wrote {len(detail)} matches -> {OUT_PATH}")
    if skipped:
        print(f"skipped {len(skipped)} (team not in model): {skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
