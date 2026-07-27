# Bitcoin Edge — V2 Physical Cutover + NO-Side Kill (the 07-27 signal fix)

**Date:** 2026-07-27 (Cowork deep-dive session)
**Severity:** HIGH — the public bitcoin signal and the live bot have been trading a
model with a structural directional bias. Bot ledger since 7/15: 1-for-7, −$2.36 net,
every losing leg a NO. Public picks post-7/21: NO side 1-for-15.
**Scope:** `src/engine/{commodities,commodity-base,thresholds,short-horizon-vol}.js`,
`src/delivery/{discord,alert-feed}.js`, tests. Plus one Supabase migration (already
applied) and a one-line bot alignment (see pmp-btc-bot handoff of same date).
**Status: SHIPPED a85f4b1 — deployed to Fly 2026-07-27 22:38 UTC.** 380/380 vitest green at deploy;
pushed to `origin/main`; deployed image verified in-machine (`useV2Cutover: true`,
`noSideEnabled: false`, `shortHorizonMuScale: 1.0`, `shortHorizonMuCapAnnual: 50`).
`tool_changes` id=9 written (`resets_record: true`); `sync_tool_track_from('bitcoin-edge')`
→ `track_from = 2026-07-27T22:38:00Z`. Bot alignment deployed same window (pmp-btc-bot 36fc44f).
**Outstanding: the model_version/mu_source verification query below has NOT run** — deploy landed
Monday 7/27 at 6:38 PM ET, ~2.5h after that day's 4 PM close (last v1 bitcoin snapshot 19:59 UTC).
First warm V2 bitcoin rows arrive **Tuesday 7/28, 10 AM–4 PM ET**.

---

## What was actually wrong (three compounding facts)

1. **Bitcoin never got the V2 physical-measure cutover.** `useV2Cutover: false` since
   05-21 ("drift ≤0.15pp at hourly T — a no-op"). Metals have run V2 for two months;
   bitcoin stayed on zero-drift risk-neutral N(d2). 19,425 bitcoin rows in the last 30
   days: 100% `model_version='v1_riskneutral'`, with `prob_physical` computed in shadow
   the whole time.
2. **The "no-op" rationale was true for the wrong μ.** The ±3.0/yr `MU_CAP` inside
   `short-horizon-vol.js` (sane for 60d drift) crushes intra-hour momentum ~30×:
   ±300%/yr over 30 min moves log-spot ~1.7bp, while a real BTC burst (+0.5%/15min)
   annualizes to ~8,000%/yr. So even the shadow V2 was momentum-blind — and the
   `mu_used`/`mu_source` columns recorded the 60d drift (`realized_60d`), not what the
   TWAP path consumed. The zero-μ live model therefore kept reading "below" while BTC
   trended up, printing fade-the-trend BUY NOs into every trend day: the 7/7, 7/14,
   7/24, and 7/27 0-fers are all the same failure.
3. **Each prior patch amputated a symptom, not the bias.** 6/16 NO floor, 7/14 bot
   guards, 7/21 YES-favorite floor — after all of them the remaining public flow was
   ~6 picks/day skewed to cheap dogs, NO picks 1-for-15, and the bot 1-for-7.

## Evidence (replay backtest, fully reproducible)

Method: faithful port of `probAboveTwap` + the α(T) σ-blend; spot from Coinbase 1-min
candles; σ_short/μ_raw from a 15-min lookback mirroring the Pyth buffer; per-strike IV
from `commodity_edge_signals`; outcomes from `commodity_edge_settles`; picks replayed at
their exact `picked_at` against their recorded `market_price_at_pick`. Reconstruction
fidelity: MAE 0.032 vs the stored v1 `predicted_prob` on 169 settled picks (6/29–7/27).

| Policy (replayed picks kept) | n | hit % | ROI (6/29–7/13) | ROI (7/14–7/27) |
|---|---|---|---|---|
| v1 (live today) | 61 | 49.2% | +27% (n=27) | +12% (n=34) |
| v2 λ=1 cap=50 | 63 | 63.5% | +18% (n=30) | +26% (n=33) |
| **v2 λ=1 cap=50, YES-only (SHIPPED)** | **54** | **72.2%** | **+18% (n=29)** | **+34% (n=25)** |

- Kept-NO hit rate is ≤14% under EVERY μ variant (incl. v2) — no λ rescues the NO
  side; it's pure model error against momentum-priced favorites. Hence the kill switch.
- Of the bot's 6 losing legs since 7/15, the v2 prob at placement flips/kills 3 outright
  (ids 347, 352, 353) and keeps the one winner (348) with a BIGGER edge.
- Grid-calibration caveat (honesty): unconditional Brier on all strike-times slightly
  favors v1 — raw momentum extrapolation adds variance. The value shows up exactly on
  the DECISION set (picks), which is the thing that trades and gets promoted. λ and cap
  are config so this stays tunable as the ledger accumulates v2 fills.

## What changed (file by file)

- `short-horizon-vol.js` — buffer now also returns `mu_annual_raw` (uncapped).
- `thresholds.js` — `BTC_MU_SCALE=1.0`, `BTC_MU_CAP_ANNUAL=50` (+rationale).
- `commodity-base.js` — new pure `resolveTwapMu({muRaw, muClamped, scale, capAnnual})`
  (exported via `__test__`); TWAP warm-buffer path consumes it for the physical μ;
  `mu_used`/`mu_source` now record the μ that actually drove `prob_physical`
  (`pyth_short_horizon_15m` on the warm path).
- `commodities.js` (bitcoin) — `useV2Cutover: true`, `shortHorizonMuScale: 1.0`,
  `shortHorizonMuCapAnnual: 50`, `noSideEnabled: false`.
- `delivery/discord.js` + `delivery/alert-feed.js` — embeds/alert rows display the
  prob that drove the alert (`prob_physical` when `model_version='v2_physical'`).
- Tests: `test/engine.commodity-base.mu-resolve.test.js` (new, 6 tests) +
  `engine.commodities.test.js` cutover pin updated. **380/380 pass.**
- Supabase (APPLIED already, migration `tool_picks_predicted_prob_v2_aware`):
  `_leaderboard_commodity_pick_insert()` records `prob_physical` as `predicted_prob`
  when V2 owns the row (fixes metals' track record too) + `model_version` in
  `regime_tags`. Migration file lives in
  `prediction-marketspicks/supabase/migrations/20260727210000_tool_picks_predicted_prob_v2.sql`.

**Not changed:** all quality gates (post-spread, YES-favorite floor, longshot ban, corr
check, tier ceilings, TWAP window), metals configs (byte-identical path), OPRA
compliance surfaces (prob_physical/model_version are derived outputs, same license
class as options_prob), edge_pp column (stays frozen V1 for A/B).

## Operator: deploy + verify (copy-paste)

```
cd /Users/benny/pmp-ingestion
npx vitest run                        # expect 380 passed
git log -1                            # confirm the 07-27 cutover commit
fly deploy -a pmp-ingestion --remote-only
# next trading session (10 AM–4 PM ET), in Supabase:
#  select model_version, mu_source, count(*),
#         round(avg(abs(fused_edge_pp))::numeric,4) avg_edge,
#         count(*) filter (where direction='BUY NO') buy_no
#  from commodity_edge_signals
#  where commodity='bitcoin' and snapshot_date=current_date
#  group by 1,2;
# EXPECT: model_version='v2_physical', mu_source='pyth_short_horizon_15m'
#         on warm rows, buy_no = 0.
```

## Rollback (each independent, one line + redeploy)

- Full revert: `useV2Cutover: false` (bitcoin block).
- Momentum off, keep v2 plumbing: `shortHorizonMuScale: 0`.
- Momentum quieter: `shortHorizonMuScale: 0.5` (replay-equivalent within noise).
- NO side back: `noSideEnabled: true` (do NOT without a fresh calibration study).

## Soak + promo guidance

Per the §14.7 convention: let it run 2–3 full sessions before pushing the track record
hard. The replayed policy is ~2.5 picks/day at 72% hit / ~54¢ avg YES entry — promote
the RECORD (tool_picks now grades the actual model), not a single day. Watch
`#oracle-picks`/`#premium-alerts` volume: STRONG ≥12pp will stay rare; MODERATE should
reappear at a few/day.

## Follow-ups (small, separate sessions)

1. Site read libs (`lib/tools/*-edge.ts`) still display `options_prob` as "model prob"
   while edge/direction are V2 — add `prob_physical`/`model_version` to the select and
   prefer physical when it owns the row (4 files, cosmetic, non-trivial per site
   CLAUDE.md → needs its own typecheck/push/deploy pass).
2. `calibrated_prob`/`edge_calibration_maps` infra exists but is unused — once ~2 weeks
   of v2 fills accumulate, fit an isotonic map per price band and wire it.
3. Revisit the 7/21 YES-favorite 10pp floor under v2 — it was fitted to v1's saturation
   artifact and may now be over-suppressing the 80–89¢ band that used to carry +22% ROI.
