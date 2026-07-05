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
import urllib.error
from dataclasses import dataclass, field
from typing import Dict, FrozenSet, List, Set, Tuple

from .teams import NAME_TO_SLUG

DEFAULT_MATCHES_URL = "https://predictionmarketspicks.com/api/wc/matches"

# Valid model slugs (the python namespace). The world_cup_results table stores
# wc-shared.js slugs, which are reconciled to be identical to these (hard gate
# in the autofeed handoff). We still validate each table slug against this set
# so a future drift surfaces as a dropped row + warning rather than a phantom.
VALID_SLUGS: Set[str] = set(NAME_TO_SLUG.values())

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


def _load_from_json(source: str | None = None) -> PlayedResults:
    """Load completed group-stage results from the hand-maintained matches JSON.

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


def _load_from_results_table() -> PlayedResults:
    """Load FT rows from the world_cup_results Supabase table (autofeed Phase 4).

    This is the fast path that needs no JSON commit + redeploy: the Fly engine
    persists ESPN finals here within one 30-min scan. Never raises — any failure
    (no env, network, bad shape) returns {} so the JSON path still satisfies
    --require-results. Slugs are validated against VALID_SLUGS; an unknown slug
    drops that row + warns rather than seeding a phantom.
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print("[wc-sim] results table skipped: SUPABASE_URL/SERVICE_KEY unset")
        return {}

    endpoint = (
        f"{url.rstrip('/')}/rest/v1/world_cup_results"
        "?status=eq.FT&select=match_id,home_slug,away_slug,home_score,away_score"
    )
    req = urllib.request.Request(
        endpoint,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": "pmp-ingestion-wc-sim/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            rows = json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001 — table is a best-effort overlay
        print(f"[wc-sim] results table read failed (non-fatal): {e!s}")
        return {}

    played: PlayedResults = {}
    skipped = 0
    for r in rows or []:
        hs, as_ = r.get("home_score"), r.get("away_score")
        h_slug, a_slug = r.get("home_slug"), r.get("away_slug")
        if hs is None or as_ is None or not h_slug or not a_slug:
            skipped += 1
            continue
        if h_slug not in VALID_SLUGS or a_slug not in VALID_SLUGS:
            print(
                f"[wc-sim] results table: unknown slug in {r.get('match_id')!r} "
                f"({h_slug!r} vs {a_slug!r}) — dropped (slug-namespace drift?)"
            )
            skipped += 1
            continue
        key = frozenset((h_slug, a_slug))
        played[key] = {h_slug: int(hs), a_slug: int(as_)}
    print(f"[wc-sim] results table: {len(played)} FT rows loaded ({skipped} skipped)")
    return played


def load_played_results(source: str | None = None) -> PlayedResults:
    """Completed group-stage results, table-first with JSON authoritative.

    Precedence (autofeed handoff):
      1. world_cup_results table (fast path; no redeploy needed).
      2. hand-maintained matches JSON.
    On key conflict the JSON wins — a human verified + committed it, and the
    table only ever fills the gap until that commit lands. Keyed by frozenset of
    the two team slugs, so home/away ordering between the two sources is moot.
    """
    table = _load_from_results_table()  # {} on any failure
    json_played = _load_from_json(source)
    merged: PlayedResults = dict(table)
    merged.update(json_played)  # JSON overrides table on conflict
    return merged


# Site knockout-stage string → internal stage code. Matches the simulator's
# stage ladder: 1=R32, 2=R16, 3=QF, 4=SF, 5=Final. Both 'F' (WcStage type) and
# 'Final' (older rows) map to 5.
_KO_STAGE_CODE: Dict[str, int] = {
    "R32": 1, "R16": 2, "QF": 3, "SF": 4, "F": 5, "Final": 5,
}
# How many ties a stage has when fully known (used to decide the deepest round
# that can be pinned with certainty).
_KO_STAGE_FULL: Dict[int, int] = {2: 8, 3: 4, 4: 2, 5: 1}


@dataclass
class KnockoutBracket:
    """The real bracket as entered in the site's matches JSON, in MODEL NAMES.

    ``ties_by_stage`` maps a stage code (2=R16, 3=QF, 4=SF, 5=Final) to the
    (home, away) pairings present so far. R32 rows contribute only the
    ``r32_teams`` floor — the R16 rows already encode who won the R32. Every name
    is a key of teams.TEAMS / ALL_TEAMS (the namespace sim_match + the stage dict
    operate in), NOT a slug.

    Partial rounds are first-class: a stage carries however many ties are known,
    and the simulator pins those while shuffling the remainder. As results roll
    in and the detector writes deeper rows, the bracket auto-deepens R16 → QF →
    SF → Final with no code change — that is the whole point of this shape.
    """
    r32_teams: List[str] = field(default_factory=list)
    ties_by_stage: Dict[int, List[Tuple[str, str]]] = field(default_factory=dict)

    @property
    def r16_ties(self) -> List[Tuple[str, str]]:
        return self.ties_by_stage.get(2, [])

    def is_pinnable(self) -> bool:
        """True once the full Round of 16 (8 ties) is known — the minimum to
        seed the knockout bracket instead of re-simulating it from group
        standings."""
        return len(self.r16_ties) == 8

    def deepest_full_stage(self) -> int:
        """Deepest stage whose complete complement of ties is present (0 if
        none). Purely for logging — the simulator pins every known tie at every
        stage regardless."""
        deepest = 0
        for code in (2, 3, 4, 5):
            if len(self.ties_by_stage.get(code, [])) == _KO_STAGE_FULL[code]:
                deepest = code
        return deepest


_STAGE_NAME = {2: "R16", 3: "QF", 4: "SF", 5: "Final"}


def load_knockout_bracket(source: str | None = None) -> KnockoutBracket:
    """Real knockout bracket (every stage present) from the matches JSON.

    Returns a :class:`KnockoutBracket`. The simulator uses it to seed the bracket
    from the actual pairings once the R32 is complete, instead of re-simulating
    it from group standings — which lets eliminated teams re-advance (the
    phantom-progression bug). Rows whose names don't resolve to a model team
    (unfilled placeholders like "Winner Match 89") are skipped, so a
    partially-known deeper round simply carries fewer ties.
    """
    raw = _load_raw(source)
    matches = raw.get("matches", [])
    bracket = KnockoutBracket()
    seen: Set[str] = set()

    def to_model_name(site_name: str) -> str | None:
        model = SITE_NAME_ALIAS.get(site_name, site_name)
        return model if model in NAME_TO_SLUG else None

    for m in matches:
        code = _KO_STAGE_CODE.get(m.get("stage"))
        if code is None:
            continue
        home = to_model_name(m.get("home", ""))
        away = to_model_name(m.get("away", ""))
        if home is None or away is None:
            continue  # unresolved placeholder slot — skip, not fatal
        if code == 1:  # R32 → floor only (R16 rows encode the R32 winners)
            for s in (home, away):
                if s not in seen:
                    seen.add(s)
                    bracket.r32_teams.append(s)
        else:
            bracket.ties_by_stage.setdefault(code, []).append((home, away))
    return bracket


def describe(played: PlayedResults) -> str:
    return f"{len(played)} completed group fixtures loaded"
