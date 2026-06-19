# KXBTC15M — vol-side calibration investigation (findings)

**Date:** 2026-06-19 · **Branch:** `bitcoin-edge-phase2-horizons` · **Script:** `scripts/btc15m_calibrate.py`
**Scope:** Item #1 of the 15-min build ("vol-side fix" for the near-close under-confidence seen in `btc15m_backtest.py`). Offline analysis only; live hourly KXBTCD engine untouched.

## Premise (going in)
Backtest showed the model well-calibrated at T-10min but UNDER-confident as τ→0 (T-2min: model 0.85 → realized 0.98). Working hypothesis: σ from single-exchange 1-min candles overstates the effective vol over a 2–10 min horizon (microstructure + sqrt-time projection error). Fix: shrink σ by `k(τ)=√VR(τ)`, validated two ways that must agree.

## What the data actually said
1. **Hypothesis REFUTED.** Variance ratio `VR(h)=Var(h)/(h·Var(1))` ≈ **0.93–1.0** across h=1…15 min (`√VR ≈ 0.97–1.0`). BTC 1-min returns are ~i.i.d.; path variance scales ~linearly. σ is **not** materially overstated. The model-free √VR (≈0.97) and the log-loss-fit k (0.58 at 120s) **disagree hard** → the shrink is curve-fitting a different problem, not a principled vol correction.
2. **σ-shrink is ineffective OOS.** Chronological 70/30 split (train Apr16–May31, test June). TEST Brier 0.1218 (baseline) → 0.1202 (k(τ)) — ~1%. Not a fix.
3. **Drift can't be it either.** Over a 2-min horizon the BS drift contribution `μ·(T−τ/2)` is ~1e-5 in log-space regardless of μ (caps mathematically near 0) — which is exactly why adding μ in the backtest did nothing.
4. **The real defect is shape: persistent mid-bucket under-confidence** (~−0.055 to −0.085 gap in the 0.5–0.9 buckets) — the leading side near close wins more than Φ(d2) says. Plausible mechanism: short-horizon serial correlation / continuation in the BRTI settle series that Black-Scholes (driftless martingale) can't represent. Not vol-scale, not drift.

## The validated fix: per-offset isotonic recalibration
Fit baseline_prob → outcome via PAV on TRAIN, apply to TEST. OOS:

| Method | log-loss | Brier | dir-acc |
|---|---|---|---|
| baseline (k=1) | 0.3798 | 0.1218 | 82.7% |
| σ-shrink k(τ) | 0.3752 | 0.1202 | 82.7% |
| isotonic pooled | 0.3739 | 0.1201 | 82.6% |
| **isotonic per-offset** | **0.3711** | **0.1192** | 82.6% |

Per-offset isotonic collapses the mid-bucket gaps from ~−0.08 to ~−0.02 OOS. Aggregate Brier moves only ~2% because the high-n confident extremes dominate the score and were already fine — but the fix lands exactly where tradeable decisions live (close games, 0.5–0.9). Direction/ranking unchanged (isotonic is monotone), as expected.

## Caveat that gates productionization
**Non-stationary:** mid-bucket gap = −0.055 (train) vs −0.078 (test). A static recalibration under-corrects in a new regime. Any production recalibration must be **refit on a rolling window** — extend the existing `ic-calibrate` Monday cron (jobid 135), do not bake a frozen map.

## Recommendation / next steps
- The "vol fix" is closed as a **negative result** — don't pursue σ-scaling further.
- Recalibration is real but modest; its value is concentrated in the tradeable mid-band. **Measure its actual ROI impact with fees** (build item #2) before deciding to productionize — raw vs recalibrated probs on the side-aware post-spread gate, Kalshi fees included, regime-split.
- Trading-relevant insight regardless: the raw model **under-prices the leading side near close** by ~5–8pp. That, not a vol tweak, is where any 15-min edge would come from — and it must clear fees + spread.
