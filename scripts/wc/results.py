"""
Completed-match results loader for the standings-aware WC sim.

The nightly Monte Carlo (simulator.run_one_tournament) used to re-run the whole
group stage from pre-tournament priors every night, ignoring games that have
already been played. That made every `advance` / progression probability frozen
at kickoff values while the markets had fully repriced on the actual results —
the staleness documented in
prediction-marketspicks/handoffs/WC_MISPRICINGS_STALE_SIM_2026-06-18.md.

This module loads the completed group-stage results from the site's
`data/wc2026-matches.json` (the hand-maintained source of truth, same file that
powers the public standings via lib/wc/standings.ts) and returns them in a form
the simulator can use to (a) bank real points/GD/GF and (b) lock the played
fixtures so only the remaining games are simulated.

Source resolution (first that works wins):
  1. WC_MATCHES_URL env  — HTTP GET (default: the production /api/wc/matches route)
  2. WC_MATCHES_PATH env — local file path
  3. sibling-repo path   — ../prediction-marketspicks/data/wc2026-matches.json
                           (works for local dev runs next to the site checkout)

In GitHub Actions only the engine repo is checked out, so option 1 (the public
route) is the path that runs in CI. Options 2/3 keep local runs working with no
network. If NOTHING loads, an empty result set is returned and the caller
decides whether that is fatal (see run-wc-sim.py --require-results): we never
silently fall back to a stale full re-sim during the tournament.
"""
from __future__ import annotations

import json
import os
import urllib.request
from typing import Dict, FrozenSet, List, Tuple

from .teams import NAME_TO_SLUG

DEFAULT_MATCHES_URL = "https://predictionmarketspicks.com/api/wc/matches"

# Site display name → model display name, only where the strings differ.
# Mirrors scripts/export-wc-match-detail.py NAME_ALIAS.
SITE_NAME_ALIAS = {
    "Bosnia & Herzegovina": "Bosnia and Herzegovina",
}

# A played group fixture, keyed by the unordered pair of team slugs.
# Value maps each team's slug → goals scored by that team.
PlayedResults = Dict[FrozenSet[str], Dict[str, int]]


def _site_name_to_slug(site_name: str) -> str:
    model_name = SITE_NAME_ALIAS.get(site_name, site_name)
    slug = NAME_TO_SLUG.get(model_name)
    if slug is None:
        raise KeyError(
            f"WC results: team name {site_name!r} (model {model_name!r}) has no "
            f"slug in teams.NAME_TO_SLUG — fix the alias map in wc/results.py"
        )
    return slug


def _load_raw(source: str | None) -> dict:
    """Return the parsed matches JSON, trying URL then local paths."""
    candidates: List[Tuple[str, str]] = []
    if source:
        kind = "url" if source.startswith("http") else "path"
        candidates.append((kind, source))
    else:
        url = os.environ.get("WC_MATCHES_URL", DEFAULT_MATCHES_URL)
        candidates.append(("url", url))
        path_env = os.environ.get("WC_MATCHES_PATH")
        if path_env:
            candidates.append(("path", path_env))
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # scripts/
        sibling = os.path.normpath(
            os.path.join(here, "..", "..", "prediction-marketspicks",
                         "data", "wc2026-matches.json")
        )
        candidates.append(("path", sibling))

    last_err: Exception | None = None
    for kind, loc in candidates:
        try:
            if kind == "url":
                req = urllib.request.Request(
                    loc, headers={"User-Agent": "pmp-ingestion-wc-sim/1.0"}
                )
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
            else:
                if not os.path.exists(loc):
                    continue
                with open(loc, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            print(f"[wc-sim] results source OK ({kind}): {loc}")
            return data
        except Exception as e:  # noqa: BLE001 — try the next candidate
            last_err = e
            print(f"[wc-sim] results source failed ({kind} {loc}): {e!s}")

    raise RuntimeError(
        f"WC results: no source readable (tried {len(candidates)}); "
        f"last error: {last_err!s}"
    )


def load_played_results(source: str | None = None) -> PlayedResults:
    """Load completed group-stage results, keyed by frozenset of the two slugs.

    Only group-stage fixtures (group A-L, matchday 1-3) with a full-time result
    are returned. Knockout fixtures, if/when present, are ignored — the sim only
    conditions the group stage on real results; the bracket is still simulated.
    """
    raw = _load_raw(source)
    matches = raw.get("matches", [])
    played: PlayedResults = {}
    for m in matches:
        group = m.get("group")
        if not group:
            continue
        if str(m.get("md")) not in ("1", "2", "3"):
            continue
        result = m.get("result") or {}
        if result.get("status") != "FT":
            continue
        hs, as_ = result.get("home_score"), result.get("away_score")
        if hs is None or as_ is None:
            continue
        home_slug = _site_name_to_slug(m["home"])
        away_slug = _site_name_to_slug(m["away"])
        key = frozenset((home_slug, away_slug))
        played[key] = {home_slug: int(hs), away_slug: int(as_)}
    return played


def describe(played: PlayedResults) -> str:
    return f"{len(played)} completed group fixtures loaded"
