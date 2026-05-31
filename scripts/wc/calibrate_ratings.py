#!/usr/bin/env python3
"""
v4 market-anchored ratings calibration (one-time, reproducible).

Bakes teams.py strength ratings so the deterministic sim (10000 iterations,
seed=42 — the exact production config) reproduces a champion distribution that is
a 50/50 blend of the Elo model and the de-vigged DraftKings outright market
(see market_anchor.py). The blend is the TARGET; this script solves for the
ratings that produce it.

Method — damped fixed point on overall strength:
  target_i  = renormalize( (1-W)*model_i + W*market_i )        # sums to 100
  loop:
    cur_i   = champ%(current ratings, 10k, seed=42)            # deterministic
    delta_i = clamp( GAIN * SENS * ln((target_i+eps)/(cur_i+eps)), ±CLAMP )
    Off_i += delta_i ; Def_i += delta_i                        # preserve O/D gap
  until max contender error < TOL.

SENS ≈ 76 rating points per unit ln(champ%), derived empirically from the v2 seed
spread (Spain 1900 avg / 18.6% vs Germany 1830 avg / 7.4%: 70 pts ≈ 0.92 ln).
Adding the SAME delta to Off and Def shifts overall strength while preserving each
team's attacking/defensive differential (a team's identity).

Champion% always sums to 100 (one winner per tournament) and the target sums to
100, so the system is self-consistent. Minnows whose model AND market are both
near zero are left at their Elo values (delta≈0).

Run:  PYTHONPATH=scripts python3 -m wc.calibrate_ratings
Prints the new TEAMS block + the post-rounding champion% for the 6 spot-check
teams (paste into validation.py SPOT_CHECKS) and the full champion seed.
"""
from __future__ import annotations

import math
import random
from typing import Dict, Tuple

from wc import teams as T
from wc.simulator import run_one_tournament, aggregate_team_progression
from wc.market_anchor import W_MARKET, market_champ_pct

ITERS = 10000      # MUST match production (run-wc-sim.py default) for reproducibility
SEED = 42          # MUST match production
SENS = 76.0        # rating points per unit ln(champ%)
GAIN0 = 0.55       # initial damping on each Newton step (annealed below)
CLAMP = 22.0       # max rating move per team per iteration
EPS = 0.12         # smoothing so tiny-prob teams don't blow up the log
TOL = 0.20         # convergence: max |cur-target| over contenders (pp)
MAX_ITERS = 60
CONTENDER_FLOOR = 0.30  # only chase teams whose target or current exceeds this


def champ_pct(precise: bool = False) -> Dict[str, float]:
    """Deterministic champion% per team at the production config.

    precise=True bypasses aggregate's 0.1pp rounding (smooth objective for the
    optimizer — avoids quantization-induced limit cycles). precise=False mirrors
    production exactly (run-wc-sim.py uses the rounded aggregate), so the baked
    SPOT_CHECKS match what the nightly run will actually produce.
    """
    random.seed(SEED)
    stages = [run_one_tournament() for _ in range(ITERS)]
    if precise:
        counts = {t: 0 for t in T.ALL_TEAMS}
        for stage in stages:
            for t, s in stage.items():
                if s >= 6:
                    counts[t] += 1
        return {t: counts[t] / ITERS * 100.0 for t in T.ALL_TEAMS}
    agg = aggregate_team_progression(stages)
    return {team: agg[team]["champion"] for team in T.ALL_TEAMS}


def build_target() -> Dict[str, float]:
    """50/50 blend of model and de-vigged market, renormalized to sum 100."""
    model = champ_pct(precise=True)
    market = market_champ_pct()
    blended = {
        t: (1 - W_MARKET) * model[t] + W_MARKET * market.get(t, model[t])
        for t in T.ALL_TEAMS
    }
    s = sum(blended.values())
    return {t: v / s * 100.0 for t, v in blended.items()}


def calibrate() -> Tuple[Dict[str, Tuple[int, int]], Dict[str, float]]:
    target = build_target()
    print(f"[calib] W_MARKET={W_MARKET}  ITERS={ITERS}  seed={SEED}")
    print(f"[calib] target champ% (top): " +
          ", ".join(f"{t.split()[0]} {target[t]:.1f}"
                    for t in sorted(target, key=lambda k: -target[k])[:8]))

    # Work on float ratings; round only at the end.
    ratings = {t: [float(o), float(d)] for t, (o, d) in T.TEAMS.items()}
    best_err = float("inf")
    best_ratings = {t: list(v) for t, v in ratings.items()}

    for it in range(1, MAX_ITERS + 1):
        cur = champ_pct(precise=True)
        contenders = [t for t in T.ALL_TEAMS
                      if target[t] >= CONTENDER_FLOOR or cur[t] >= CONTENDER_FLOOR]
        max_err = max(abs(cur[t] - target[t]) for t in contenders)
        if max_err < best_err:
            best_err = max_err
            best_ratings = {t: list(v) for t, v in ratings.items()}
        if it == 1 or it % 5 == 0 or max_err < TOL:
            worst = max(contenders, key=lambda t: abs(cur[t] - target[t]))
            print(f"[calib] iter {it:2d}  max_err {max_err:.2f}pp  best {best_err:.2f}pp "
                  f"(worst {worst.split()[0]}: cur {cur[worst]:.2f} vs tgt {target[worst]:.2f})")
        if max_err < TOL:
            print(f"[calib] converged at iter {it} (max_err {max_err:.2f} < {TOL})")
            break
        # Anneal the gain so we settle into the basin instead of limit-cycling.
        gain = GAIN0 / (1.0 + it / 12.0)
        for t in contenders:
            ratio = (target[t] + EPS) / (cur[t] + EPS)
            delta = max(-CLAMP, min(CLAMP, gain * SENS * math.log(ratio)))
            ratings[t][0] += delta
            ratings[t][1] += delta
            T.TEAMS[t] = (ratings[t][0], ratings[t][1])  # live, for next eval
    else:
        print(f"[calib] stopped at MAX_ITERS={MAX_ITERS}; baking best (max_err {best_err:.2f}pp)")

    # Bake the BEST float state seen (not the last), round to int, then re-evaluate
    # at the PRODUCTION config so the baked ratings' actual rounded champ% becomes
    # the validation source of truth (expected == actual ⇒ validation passes).
    final = {t: (int(round(best_ratings[t][0])), int(round(best_ratings[t][1])))
             for t in T.ALL_TEAMS}
    for t, od in final.items():
        T.TEAMS[t] = od
    final_pct = champ_pct(precise=False)
    return final, final_pct


def main() -> int:
    final, pct = calibrate()
    print("\n" + "=" * 64)
    print("FINAL champion seed (10k, seed=42) — these ARE the v4 ratings:")
    print("=" * 64)
    s = sum(pct.values())
    for t in sorted(pct, key=lambda k: -pct[k]):
        if pct[t] >= 0.05:
            print(f"  {t:<26} O/D {final[t][0]}/{final[t][1]:<6} champ {pct[t]:5.2f}%")
    print(f"  champion% sum = {s:.2f}")

    print("\n--- validation.py SPOT_CHECKS expected values ---")
    spot = ["Spain", "France", "England", "Brazil", "Argentina", "Germany"]
    for t in spot:
        slug = T.NAME_TO_SLUG[t]
        band = (round(pct[t] - 1.0, 1), round(pct[t] + 1.0, 1))
        print(f'    "team:{slug}": {{"kind": "champion", "expected": {pct[t]:.1f}, '
              f'"tol": 0.5, "spec_band": {band}}},')

    print("\n--- teams.py TEAMS dict (paste, preserving comments/order) ---")
    for t in T.ALL_TEAMS:  # ALL_TEAMS is group-order; we want source order though
        pass
    # Emit in the original TEAMS insertion order for a clean diff.
    for t in final:
        o, d = final[t]
        print(f'    {("%r:" % t):<28} ({o}, {d}),')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
