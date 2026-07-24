# Handoff — Bitcoin Edge: kill the NO-side bleed (asymmetric, post-spread edge gate)

**Date:** 2026-06-16
**Owner:** Benny
**Repo:** `pmp-ingestion` (engine). One read-side verification in `prediction-marketspicks`.
**Risk:** Low. Config-gated, reversible, no schema change required for Phase 1.

---

## TL;DR

Bitcoin Edge's lifetime profit is a launch-week artifact. Once the June 10 stale-leg
fixes landed (`1dc361e` atomic refetch, `a69214e` ±6% band + WATCH tier), the *real*
edge collapsed to ~0 because hourly KXBTCD is near-efficient. The post-fix P/L is
breakeven-to-negative, and **the entire loss is concentrated in one cluster: BUY NO
positions.** The engine emits a BUY NO whenever its YES-edge is negative, with no check
that the NO contract clears a real edge after its own ask-side spread. Those picks win
~50% (coin flip) and bleed because they're expensive favorites with asymmetric downside.

Fix: make the BUY gate **side-aware and spread-aware** — charge each side its actual
ask-side spread before emitting, and require a higher threshold on the NO side until the
model's low-side bias is recalibrated.

---

## The data that drove this (honest-data era: settled ≥ 2026-06-10, Sat 6/13 data-bug day excluded, n=106)

| Cluster | n | W–L | Win% | P/L | Avg edge |
|---|---|---|---|---|---|
| BUY YES (edge > 0) | 47 | 29–18 | 62% | **+$1.98** | + |
| BUY NO (edge < 0) | 59 | 32–27 | 54% | **−$1.74** | −5.7pp |
| — of which Tier 1 (SPECULATIVE) NO | 36 | 18–18 | 50% | **−$3.55** | −5.7pp |
| Edge ≥ 6pp (any side) | 42 | 29–13 | 69% | +$3.74 | + |
| actionable + edge≥6 + tier2 | 5 | 5–0 | 100% | +$2.71 | +24.6pp |

Read: the **positive-edge / YES signal predicts** (62–69% win, green). The
**negative-edge / NO signal does not** (coin flip, red). NO-side picks are *exactly* the
negative-edge picks (the two rows are byte-identical: same n=59, same −$1.74), confirming
the engine flips to NO purely on edge sign.

Two mechanisms, both real:
1. **One-sided miscalibration.** The IBIT-chain model prob (`optProb`) appears biased low,
   so "YES overpriced → BUY NO" is often a model artifact, not a market mispricing. Avg
   model prob on the NO cluster is 0.343 — these are longshot-YES strikes.
2. **Asymmetric payout.** BUY NO on a low-YES-prob strike = buying the favorite NO at
   ~60–66¢. A 50% win rate on a contract that pays ~35–40¢ but risks the full stake is a
   structural money-loser regardless of model quality.

**Caveat for whoever builds this:** 106 picks, sub-clusters of 5–36. Directionally
consistent and mechanistically explained, but not yet statistically significant. Ship
behind config, then confirm on a fresh gated sample (see Phase 3).

---

## Root cause in code

`src/engine/commodity-base.js`

Edge definition (~line 779):
```js
let edge = null;
if (optProb != null && kalshiProb != null && kalshiProb > 0) edge = optProb - kalshiProb;
// ...
const chosenEdge = v2Available ? physicalEdge : edge;   // bitcoin = V1, chosenEdge === edge
const chosenProb = v2Available ? probPhysical : optProb;
```

Gate + side selection (~lines 826–852):
```js
} else if (Math.abs(chosenEdge) < MIN_EDGE_PP) {        // <-- SYMMETRIC gate, |edge| only
   // ... WATCH lean / low ...
} else if (kalshiView === 'no_market') {
   // ...
} else {
   const dirYes = chosenEdge > 0;
   direction = dirYes ? 'BUY YES' : 'BUY NO';            // <-- flips to NO purely on sign
   // ... confidence by |edge| magnitude ...
}
```

`MIN_EDGE_PP = 0.05`, `WATCH_EDGE_PP = 0.03` (`src/engine/thresholds.js:15,124`).

The gate compares `Math.abs(chosenEdge)` to a **single symmetric threshold** and direction
is set from the **sign only**. Nothing verifies the NO contract clears edge *after the
ask-side spread*, and nothing accounts for the model's demonstrated low-side bias.

`tool_picks` is populated by the Postgres trigger `_leaderboard_commodity_pick_insert()`
(`prediction-marketspicks/supabase/migrations/20260510105509_tool_leaderboard_wave3_commodity_oracle.sql`)
on every `commodity_edge_signals` insert. So suppressing a row at the engine
(`direction = 'PASS'`) flows straight through to the track record — **no track-record code
needs to change** if the engine stops emitting the junk. (Verify the trigger only records
`direction IN ('BUY YES','BUY NO')` — Phase 1 acceptance check below.)

---

## The fix

### Phase 1 — Post-spread, side-aware edge gate (the real fix)

Replace the symmetric `|chosenEdge| < MIN_EDGE_PP` BUY gate with a per-side check that
charges each side its actual ask-side spread, using the Kalshi book already on `market`
(`market.yesBid`, `market.yesAsk`).

For a binary, model NO prob = `1 - chosenProb`; NO ask = `1 - yesBid`. So:
- **YES edge after spread** = `chosenProb - yesAsk`
- **NO edge after spread**  = `(1 - chosenProb) - (1 - yesBid)` = `yesBid - chosenProb`

Proposed logic (pseudocode — adapt to the existing if/else ladder, keep WATCH/`no_market`/
`stale_print`/`wide_spread` branches intact):

```js
// thresholds.js
export const MIN_EDGE_PP = 0.05;          // YES side, unchanged
export const MIN_EDGE_PP_NO = 0.10;       // NO side, stricter until recalibrated

// commodity-base.js — replace the symmetric gate
const hasTwoSidedBook = market.yesBid != null && market.yesAsk != null;
const yesEdgeNet = (chosenProb != null && market.yesAsk != null) ? chosenProb - market.yesAsk : null;
const noEdgeNet  = (chosenProb != null && market.yesBid != null) ? market.yesBid - chosenProb : null;

// side-aware minimum (config override so silver/gold/oil are untouched)
const minNo = config.minEdgePpNoSide ?? MIN_EDGE_PP_NO;

let passesGate = false, dirYes = null;
if (hasTwoSidedBook) {
  if (yesEdgeNet != null && yesEdgeNet >= MIN_EDGE_PP) { passesGate = true; dirYes = true;  }
  else if (noEdgeNet != null && noEdgeNet >= minNo)    { passesGate = true; dirYes = false; }
}

if (!passesGate) {
  // fall through to existing WATCH-lean / 'low' handling (keep |chosenEdge| WATCH band
  // for the amber lean chip — leans are not BUYs so they don't hit tool_picks)
} else if (kalshiView === 'no_market') {
  // unchanged
} else {
  direction = dirYes ? 'BUY YES' : 'BUY NO';
  // confidence/tier: drive magnitude off the NET side edge (yesEdgeNet / noEdgeNet),
  // not raw |chosenEdge|, so spread cost is reflected in the tier too.
}
```

Config wiring — `src/engine/commodities.js`, **bitcoin block only** (~line 180+):
```js
minEdgePpNoSide: 0.10,   // bitcoin-only; silver/gold/oil keep symmetric MIN_EDGE_PP
```
Leave silver/gold/oil reading the symmetric `MIN_EDGE_PP` (no `minEdgePpNoSide` key →
falls back to it via the `??`). **Do not touch their behavior** — they're working.

Notes:
- If the book is one-sided / `wide_spread` / `stale_print`, the existing caveat + `low`
  confidence path should still apply; the net-edge check just won't pass the BUY gate on a
  ghost quote. Keep those guards.
- Keep `edge_pp` column = raw V1 `optProb - kalshiProb` for backtest A/B (the codebase
  already insists on this). The net-edge values are gate inputs, not the stored column —
  but **do** store `yes_edge_net_pp` / `no_edge_net_pp` if cheap (see Phase 3), otherwise
  skip for Phase 1.

### Phase 1b — Fast reversible kill switch (ship in the same PR)

Add a `config.noSideEnabled` (bitcoin: start `true`). If you want an instant rollback lever
without redeploying threshold math, gate the NO branch on it:
```js
else if (noEdgeNet != null && noEdgeNet >= minNo && (config.noSideEnabled ?? true)) { ... }
```
Lets Benny disable BUY NO entirely from config if the gated sample still bleeds.

### Phase 2 — Verify the trigger doesn't record suppressed rows

Confirm `_leaderboard_commodity_pick_insert()` filters to actionable BUY rows only
(`direction IN ('BUY YES','BUY NO')` / `confidence` not in skip/watch/low). The current
data shows only BUY rows in `tool_picks`, so it likely already does — **just confirm**, so
PASS rows from the new gate don't start polluting the ledger.

### Phase 3 — Calibration monitor + gated rollout (confirm before trusting)

No code dependency on Phase 1. Run weekly for 2–3 weeks after deploy:
```sql
-- model-prob calibration by side, post-deploy
SELECT predicted_side,
       width_bucket(predicted_prob, 0, 1, 10) AS prob_decile,
       count(*) n,
       round(avg(predicted_prob),3) avg_model_prob,
       round(avg((s.pnl_cents>0)::int),3) realized_win_rate,
       sum(s.pnl_cents) pnl_cents
FROM tool_picks p JOIN tool_settles s USING (pick_id)
WHERE p.tool_slug='bitcoin-edge' AND s.settled_at >= '2026-06-17'
GROUP BY predicted_side, prob_decile ORDER BY predicted_side, prob_decile;
```
Success = NO-side win rate ≥ model prob (calibrated) AND NO-side P/L ≥ 0 on n ≥ ~40. If NO
still bleeds, flip `noSideEnabled=false` and treat the low-side `optProb` bias as the next
project (recalibrate the IBIT-chain → BTC TWAP prob, likely a systematic shift).

---

## Acceptance criteria

1. `npm run lint` clean in `pmp-ingestion`.
2. Silver / gold / oil snapshot output **byte-identical** before/after (no `minEdgePpNoSide`
   key → symmetric path unchanged). Diff a snapshot for each to prove it.
3. Bitcoin: a strike where `optProb < kalshiProb` by 3–5pp but `yesBid - chosenProb < 0.10`
   now resolves to PASS/WATCH, **not** BUY NO. Add a unit test with a synthetic event.
4. Bitcoin: a genuine ≥10pp post-spread NO dislocation still emits BUY NO.
5. Trigger confirmed to record BUY rows only (Phase 2).
6. No `axios`. Native `fetch` only. No raw OPRA quotes on any persisted public field.

---

## What I verified vs. handed off

**Verified (this session):**
- Daily + clustered P/L from `tool_picks`/`tool_settles` (queries above, Supabase
  `svxqipncfupabpvxtlro`).
- Root cause located: `commodity-base.js` symmetric gate + sign-only side selection
  (lines ~779, ~826–852); thresholds in `thresholds.js:15,124`.
- `tool_picks` write path = trigger on `commodity_edge_signals` insert.
- June 10 / June 13 tweak dates tie exactly to the performance breaks (`1dc361e`,
  `a69214e`, `565a179`).

**Handed off (needs Claude Code in-repo):**
- Implement the side-aware/post-spread gate + config keys + unit tests.
- Confirm the trigger's direction filter (Phase 2).
- `npm run lint` + the silver/gold/oil no-diff regression.
- Deploy to Fly (`pmp-ingestion.fly.dev`), then run the Phase 3 monitor for 2–3 weeks.

---

## Copy-paste starter for Claude Code

```
Read handoffs/BITCOIN_EDGE_NO_SIDE_FIX_2026-06-16.md. Implement Phase 1 + 1b:
add MIN_EDGE_PP_NO to src/engine/thresholds.js and a bitcoin-only
minEdgePpNoSide + noSideEnabled in src/engine/commodities.js, then replace the
symmetric |chosenEdge| < MIN_EDGE_PP BUY gate in src/engine/commodity-base.js
with the side-aware, post-spread net-edge gate (YES: chosenProb - yesAsk;
NO: yesBid - chosenProb). Drive confidence/tier magnitude off the net side edge.
Keep WATCH/no_market/stale_print/wide_spread branches and the V1 edge_pp column
unchanged. Add unit tests for criteria 3 and 4. Prove silver/gold/oil snapshots
are byte-identical (criterion 2). Run npm run lint. Do NOT deploy — stop and
show me the diff.
```
