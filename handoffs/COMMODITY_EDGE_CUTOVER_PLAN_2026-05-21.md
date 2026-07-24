# Commodity Edge — Cutover Plan (V2 + Oil USO-Synthetic Spot)

**Date:** 2026-05-21
**Executor:** Claude Code (CLI session)
**Companion doc:** `handoffs/COMMODITY_EDGE_DIAGNOSTIC_2026-05-21.md` (the *why*; this file is the *how*)
**Scope:** Single bundled execution covering silver-edge, gold-edge, oil-edge, bitcoin-edge
**Status:** Ready to execute. Two phases. Phase A is the critical fix; Phase B is the oil-specific quality lift.

---

## 0. TL;DR for the executing session

You are fixing two things in one handoff:

1. **Phase A — V2 cutover for silver/gold/oil ONLY.** Flip direction/confidence/tier in `src/engine/commodity-base.js` from V1 risk-neutral `edge` to V2 physical-measure `physicalEdge` — **gated by a `useV2Cutover` config flag set true ONLY for silver/gold/oil. Bitcoin keeps `useV2Cutover: false` and rides the exact same code path it runs today.** Single PR. ~110 LOC delta.
2. **Phase B — Oil USO-synthetic spot.** Replace Yahoo CL=F as oil's intraday spot anchor with a synthetic derived from Databento's real-time USO underlyingPrice + a daily FRED DCOILWTICO calibration ratio. Oil only. New file `src/feeds/uso-synthetic.js` + a config flag in `src/engine/commodities.js`. ~150 LOC. Separate PR, lands right after Phase A.

**Ship-it-and-track approach — no artificial soak gates.** Deploy both phases when the diff is clean and tests pass. Track live performance via the existing `/admin/commodity-edge-settle-health` A/B view + the SQL queries in §2.8. If V2 doesn't trend toward beating V1 in the first ~10–15 fresh settles per commodity, iterate on weights (vol.js blend, drift.js prior). The gated approach is what kept the bleeding going — we're done with that.

**🛡 BITCOIN EDGE IS LOAD-BEARING — DO NOT TOUCH ITS BEHAVIOR.** The bitcoin engine is currently profitable and is the only commodity engine printing. Every change in this handoff is gated by a per-commodity `useV2Cutover` flag so bitcoin's runtime code path is byte-for-byte identical post-merge. Math confirms V2 would only shift BTC edges by ≤0.15pp anyway (hourly T makes drift contribution invisible), but we still carve it out explicitly because operational risk > mathematical certainty. §2.4 contains the hard verification steps that MUST pass before merge.

Yahoo CL=F stays in the codebase as a **tertiary fallback only** (not the primary spot source) — preserves the rollover sanity-check and gives us a free divergence telemetry signal. No new backup feed is added; the existing fallback chain already handles every failure mode. The user explicitly does NOT want Databento NYMEX CL upgrade (paid).

**Non-goals** (do NOT touch in this handoff):
- Bitcoin engine — runtime behavior must be unchanged (see §2.4 for verification)
- Settlement-source plumbing (already correct per Kalshi /series)
- Silver/gold spot path (Pyth XAG/USD and XAU/USD stay — those ARE the Kalshi settlement anchors)
- ETF basis ratio bridge (self-corrects, leave alone)
- Settle script (correct)
- Suppression rules, IV smile, ATM picker (already hardened 2026-05-21)
- Discord routing logic (it auto-routes off fused_edge_pp which we'll repoint for Ag/Au/Oil only)

---

## 1. Pre-flight — verify before touching code

```bash
cd /Users/benny/pmp-ingestion

# Confirm V2 inputs are flowing
grep -n "probPhysical\|physicalEdge\|estimateDrift\|estimateVol" src/engine/commodity-base.js
# Expect: drift estimator called ~L448, vol cache warm ~L454, probPhysical computed ~L516, physicalEdge ~L533

# Confirm drift.js + vol.js ship
test -f src/engine/drift.js && test -f src/engine/vol.js && echo "OK: V2 files present"

# Confirm Databento USO chain returns underlyingPrice
grep -n "underlyingPrice" src/feeds/databento.js src/feeds/options-provider.js src/engine/commodity-base.js

# Confirm FRED feed is wired and oil's fredSeriesId is DCOILWTICO
grep -n "DCOILWTICO\|getFredDailyClose" src/engine/commodities.js src/feeds/fred.js

# Confirm Yahoo prev close fallback exists for USO
grep -n "fetchPrevClose" src/feeds/options-provider.js src/feeds/yahoo-oil.js

# Sanity: no axios anywhere (CLAUDE.md security rule)
grep -rn "axios" package.json package-lock.json src/ && echo "FAIL: axios found" || echo "OK: axios-free"

# Confirm we're on main with clean tree
git status
git log --oneline -5
```

All should pass before proceeding. If any fail, stop and report.

---

## 2. Phase A — V2 cutover (the critical fix)

### 2.1 What changes semantically

| Field on row | Before | After |
|---|---|---|
| `options_prob` | V1 risk-neutral P(S_T > K) | unchanged (kept for backtest) |
| `prob_physical` | V2 physical-measure prob | unchanged (already written) |
| `edge_pp` | V1 edge = options_prob − kalshi | unchanged (frozen for backtest) |
| `physical_edge_pp` | V2 edge | unchanged (already written) |
| `fused_edge_pp` | V1 edge (same as edge_pp) | **V2 edge** (= physical_edge_pp when available) |
| `direction` | derived from V1 edge sign | **derived from V2 edge sign** |
| `confidence` | derived from V1 edge magnitude | **derived from V2 edge magnitude** |
| `fused_confidence` | fusedTier(abs(V1 edge)) | **fusedTier(abs(V2 edge))** |
| `model_version` | always `'v1_riskneutral'` | `'v2_physical'` when V2 active, `'v1_riskneutral'` when V2 falls back |
| `rationale` | quotes optProb % and V1 edge pp | quotes chosenProb % and V2 edge pp |

The schema does NOT change. We are repurposing the existing `fused_edge_pp` column to mean "the active edge that drives tier and routing" (which was already its semantic intent — see commodity-base.js header comment near line 685).

### 2.2 The single decision point — gated by per-commodity flag

In `src/engine/commodity-base.js`, inside the per-market loop in `computeSnapshot()`, immediately after `physicalEdge` is computed (currently ~L533), introduce a single chosen-edge variable that everything downstream reads from. **The cutover is gated by `config.useV2Cutover` so bitcoin stays on V1 even though its drift/vol estimators still run and write to the parallel columns.**

```javascript
// V2 cutover: physicalEdge drives direction/confidence/tier/routing — but only
// for commodities where config.useV2Cutover === true (silver/gold/oil). Bitcoin
// is explicitly carved out (useV2Cutover undefined/false) so its runtime
// behavior is unchanged. The drift estimator + vol blend still run for bitcoin
// because the parallel V2 column writes (prob_physical, physical_edge_pp) are
// free backtest data and cost ~5ms per snapshot.
//
// Graceful fallback to V1 even when useV2Cutover is true: if drift estimator
// or vol blend failed this tick (estimateDrift returned mu=0/fallback_zero,
// OR probAboveStrikePhysical returned null because iv/T degenerate), fall
// back to V1 silently. Keep edge_pp column = V1 always for backtest A/B.
const v2Eligible = config.useV2Cutover === true;
const v2Available = v2Eligible && physicalEdge != null && probPhysical != null;
const chosenEdge = v2Available ? physicalEdge : edge;
const chosenProb = v2Available ? probPhysical : optProb;
const activeModelVersion = v2Available ? 'v2_physical' : 'v1_riskneutral';
```

Set the flag in `src/engine/commodities.js` — **add `useV2Cutover: true` to silver, gold, oil entries.** Do NOT add it to bitcoin (or set it to `false` explicitly for documentation):

```javascript
silver: {
  // ... existing config
  useV2Cutover: true,  // NEW — V2 physical-measure drives direction/confidence
},
gold: {
  // ... existing config
  useV2Cutover: true,
},
oil: {
  // ... existing config
  useV2Cutover: true,
},
bitcoin: {
  // ... existing config
  useV2Cutover: false,  // EXPLICIT — bitcoin stays on V1 risk-neutral. Hourly
                        // T makes drift contribution ≤0.15pp (invisible vs the
                        // 7pp MODERATE threshold). Math says V2 is a no-op for
                        // BTC; operational risk-aversion says keep it untouched
                        // until silver/gold/oil prove V2 is correct in production.
},
```

### 2.3 Exact replacements in commodity-base.js

Search-and-replace each of these. Do NOT do a blanket `s/edge/chosenEdge/` — only the listed sites. Keep `edge` as the V1-only variable for the legacy column write.

**Site 1 — null-check branch (currently ~L546):**

```javascript
// BEFORE
if (edge == null) {

// AFTER
if (chosenEdge == null) {
```

**Site 2 — threshold gate (currently ~L558):**

```javascript
// BEFORE
} else if (Math.abs(edge) < MIN_EDGE_PP) {
  confidence = 'low';
  rationale = `Edge ${(edge * 100).toFixed(1)}pp below ${(MIN_EDGE_PP * 100).toFixed(0)}pp threshold`;

// AFTER
} else if (Math.abs(chosenEdge) < MIN_EDGE_PP) {
  confidence = 'low';
  rationale = `Edge ${(chosenEdge * 100).toFixed(1)}pp below ${(MIN_EDGE_PP * 100).toFixed(0)}pp threshold`;
```

**Site 3 — direction + rationale + confidence block (currently ~L563–579):**

```javascript
// BEFORE
const dirYes = edge > 0;
direction = dirYes ? 'BUY YES' : 'BUY NO';
const optPct = (optProb * 100).toFixed(0);
const kpPct = (kalshiProb * 100).toFixed(0);
const edgePct = Math.abs(edge * 100).toFixed(1);
rationale = `Options imply ${optPct}% chance ${config.commodity} above $${kSpot.toFixed(2)}, market prices it at ${kpPct}%. ${dirYes ? 'YES' : 'NO'} is underpriced by ${edgePct}pp.`;
const mag = Math.abs(edge);

// AFTER
const dirYes = chosenEdge > 0;
direction = dirYes ? 'BUY YES' : 'BUY NO';
const modelPct = (chosenProb * 100).toFixed(0);
const kpPct = (kalshiProb * 100).toFixed(0);
const edgePct = Math.abs(chosenEdge * 100).toFixed(1);
rationale = `Model implies ${modelPct}% chance ${config.commodity} above $${kSpot.toFixed(2)}, market prices it at ${kpPct}%. ${dirYes ? 'YES' : 'NO'} is underpriced by ${edgePct}pp.`;
const mag = Math.abs(chosenEdge);
```

(Note: "Options imply" → "Model implies" since the V2 prob is no longer purely options-implied — it's options vol + empirical drift + RV blend. Honest framing.)

**Site 4 — stale-print divergence ceiling (currently ~L613–626):**

```javascript
// BEFORE
if (
  kalshiView === 'stale_print' &&
  optProb != null &&
  kalshiProb != null &&
  Math.abs(optProb - kalshiProb) > STALE_PRINT_DIVERGENCE_CEILING
) {
  qualityFlag = 'kalshi_stale_divergence';
  direction = 'PASS';
  confidence = 'skip';
  rationale =
    `kalshi: stale print ${(kalshiProb * 100).toFixed(0)}c diverges ` +
    `${(Math.abs(optProb - kalshiProb) * 100).toFixed(1)}pp from live ` +
    `options ${(optProb * 100).toFixed(0)}% — likely stale lastPrice from prior spot regime`;
}

// AFTER
if (
  kalshiView === 'stale_print' &&
  chosenProb != null &&
  kalshiProb != null &&
  Math.abs(chosenProb - kalshiProb) > STALE_PRINT_DIVERGENCE_CEILING
) {
  qualityFlag = 'kalshi_stale_divergence';
  direction = 'PASS';
  confidence = 'skip';
  rationale =
    `kalshi: stale print ${(kalshiProb * 100).toFixed(0)}c diverges ` +
    `${(Math.abs(chosenProb - kalshiProb) * 100).toFixed(1)}pp from live ` +
    `model ${(chosenProb * 100).toFixed(0)}% — likely stale lastPrice from prior spot regime`;
}
```

**Site 5 — thin-book large-edge ceiling (currently ~L636–648):**

```javascript
// BEFORE
if (
  qualityFlag == null &&
  !gate.ok &&
  edge != null &&
  Math.abs(edge) > THIN_BOOK_EDGE_CEILING
) {
  qualityFlag = 'kalshi_thin_book_large_edge';
  direction = 'PASS';
  confidence = 'skip';
  rationale =
    `kalshi: ${gate.reason} + |edge|=${(Math.abs(edge) * 100).toFixed(1)}pp ` +
    `— thin-book mid likely stale relative to live options-implied prob`;
}

// AFTER
if (
  qualityFlag == null &&
  !gate.ok &&
  chosenEdge != null &&
  Math.abs(chosenEdge) > THIN_BOOK_EDGE_CEILING
) {
  qualityFlag = 'kalshi_thin_book_large_edge';
  direction = 'PASS';
  confidence = 'skip';
  rationale =
    `kalshi: ${gate.reason} + |edge|=${(Math.abs(chosenEdge) * 100).toFixed(1)}pp ` +
    `— thin-book mid likely stale relative to live model prob`;
}
```

**Site 6 — fusedTier computation (currently ~L651):**

```javascript
// BEFORE
let fusedTierStr = edge != null ? fusedTier(Math.abs(edge)) : 'NO_EDGE';

// AFTER
let fusedTierStr = chosenEdge != null ? fusedTier(Math.abs(chosenEdge)) : 'NO_EDGE';
```

**Site 7 — row push (currently ~L668–712):**

```javascript
// BEFORE
edge_pp: edge ?? null,
fused_edge_pp: edge ?? null,
direction,
confidence,
fused_confidence: fusedTierStr,
rationale,
...
model_version: 'v1_riskneutral',

// AFTER
edge_pp: edge ?? null,                           // V1 frozen for backtest A/B
fused_edge_pp: chosenEdge ?? null,               // V2 active — Discord routes off this, fusedTier reads this
direction,                                       // now V2-driven
confidence,                                      // now V2-driven
fused_confidence: fusedTierStr,                  // now V2-driven via chosenEdge above
rationale,                                       // now references chosenProb
...
model_version: activeModelVersion,               // 'v2_physical' or 'v1_riskneutral' depending on V2 availability
```

**Site 8 — meta.topEdge selection (currently ~L744–748):**

```javascript
// BEFORE
const actionable = filteredRows.filter((r) => r.edge_pp != null && (r.direction === 'BUY YES' || r.direction === 'BUY NO'));
let topEdge = null;
if (actionable.length > 0) {
  topEdge = actionable.reduce((best, cur) => (Math.abs(cur.edge_pp) > Math.abs(best.edge_pp) ? cur : best));
}

// AFTER
const actionable = filteredRows.filter((r) => r.fused_edge_pp != null && (r.direction === 'BUY YES' || r.direction === 'BUY NO'));
let topEdge = null;
if (actionable.length > 0) {
  topEdge = actionable.reduce((best, cur) => (Math.abs(cur.fused_edge_pp) > Math.abs(best.fused_edge_pp) ? cur : best));
}
```

**Site 9 — meta.topTier (currently ~L764–765):**

```javascript
// BEFORE
const rawTopTier = topEdge ? fusedTier(Math.abs(topEdge.edge_pp)) : 'NO_EDGE';

// AFTER
const rawTopTier = topEdge ? fusedTier(Math.abs(topEdge.fused_edge_pp)) : 'NO_EDGE';
```

### 2.4 No schema migration

`commodity_edge_signals` already has `edge_pp`, `fused_edge_pp`, `physical_edge_pp`, `model_version`, `prob_physical`, `options_prob` columns. Verified via `supabase/migrations/20260520_commodity_edge_v2_physical_measure.sql` (per BTC PDF Appendix A). No DDL required.

### 2.4 🛡 Bitcoin Edge protection — non-negotiable verification

Bitcoin is profitable and is the only commodity engine currently printing. Every change in this PR is gated by `config.useV2Cutover === true` so bitcoin's runtime behavior is byte-for-byte identical post-merge. Verify with both static analysis and dynamic checks before merging:

**Static checks (must all pass):**

```bash
cd /Users/benny/pmp-ingestion

# Confirm useV2Cutover is FALSE/undefined for bitcoin in the config registry
grep -A2 "bitcoin: {" src/engine/commodities.js | grep -E "useV2Cutover"
# Expected output: "useV2Cutover: false," with comment

# Confirm v2Eligible gate exists in commodity-base.js and references config flag
grep -n "useV2Cutover\|v2Eligible" src/engine/commodity-base.js
# Expected: at least one match showing the gate reads from config.useV2Cutover

# Confirm no code path bypasses the gate for bitcoin
grep -n "commodity === 'bitcoin'\|bitcoin.*physicalEdge" src/engine/commodity-base.js
# Expected: NO matches (bitcoin should not be referenced by name in cutover logic)
```

**Dynamic checks (must all pass against staging snapshot):**

```bash
# Run a one-shot for all four commodities and capture the rows
WRITER_TAG=delayed_test FORCE_DRY_RUN=1 node src/index.js --once --commodities silver,gold,oil,bitcoin > /tmp/v2-verify.log 2>&1

# Bitcoin's model_version MUST be v1_riskneutral on every row
grep "commodity.*bitcoin" /tmp/v2-verify.log | grep -v "v1_riskneutral" && echo "FAIL: bitcoin row not on V1" || echo "PASS: all bitcoin rows on V1"

# Bitcoin's edge_pp MUST equal fused_edge_pp on every row (no V2 divergence)
node -e "
const log = require('fs').readFileSync('/tmp/v2-verify.log','utf8');
const btcRows = log.split('\\n').filter(l => l.includes('commodity\":\"bitcoin'));
let mismatch = 0;
for (const l of btcRows) {
  try {
    const r = JSON.parse(l.match(/\\{.*\\}/)[0]);
    if (r.edge_pp !== r.fused_edge_pp) { mismatch++; console.log('mismatch:', r); }
  } catch {}
}
console.log(mismatch === 0 ? 'PASS: edge_pp == fused_edge_pp on all BTC rows' : 'FAIL: ' + mismatch + ' BTC rows have edge_pp != fused_edge_pp');
"
```

**Post-deploy first-snapshot check (run within 5 min of deploy landing):**

```sql
-- Bitcoin sanity: model_version, edge_pp, fused_edge_pp parity
SELECT
  commodity,
  model_version,
  COUNT(*) AS rows,
  SUM(CASE WHEN edge_pp = fused_edge_pp THEN 1 ELSE 0 END) AS parity_rows,
  SUM(CASE WHEN edge_pp <> fused_edge_pp THEN 1 ELSE 0 END) AS DELTA_ROWS_MUST_BE_ZERO
FROM commodity_edge_signals
WHERE commodity = 'bitcoin'
  AND snapshot_at > NOW() - INTERVAL '15 minutes'
GROUP BY commodity, model_version;
```

**If `DELTA_ROWS_MUST_BE_ZERO > 0` on bitcoin: REVERT IMMEDIATELY.** The carve-out flag is not working as intended. Use `git revert <commit>` and re-investigate before retrying.

**Post-deploy 24h check:**
- BTC alert volume in `#oracle-picks` and `#premium-alerts` should match the prior 24h baseline (±20% normal variance)
- BTC hit rate in `tool_settles` should match its baseline trend
- BTC `meta.topTier` distribution unchanged

Set a calendar reminder for 24h post-deploy to spot-check these. If BTC behavior has drifted, the flag isn't fully isolating the V2 path.

### 2.5 Public surface — touch only if needed

`lib/tools/silver-edge.ts`, `lib/tools/gold-edge.ts`, `lib/tools/oil-edge.ts`, `lib/tools/bitcoin-edge.ts` in the prediction-marketspicks repo read from `commodity_edge_signals`. After cutover:

- Direction/confidence/rationale/fused_confidence reflect V2 automatically — no change needed in adapter code if those columns are what's surfaced (they are, per BTC PDF §7).
- `edge_pp` on the public surface should now read **fused_edge_pp** (the V2 active edge), not the legacy `edge_pp` column. Audit each adapter:

```bash
cd /Users/benny/prediction-marketspicks
grep -n "edge_pp\|fused_edge_pp\|physical_edge_pp" lib/tools/silver-edge.ts lib/tools/gold-edge.ts lib/tools/oil-edge.ts lib/tools/bitcoin-edge.ts
```

If any adapter reads `edge_pp` for display, change it to `fused_edge_pp`. If it already reads `fused_edge_pp`, no change.

### 2.6 Methodology paragraph update

In each of the four `app/tools/<commodity>-edge/page.tsx` files (prediction-marketspicks), add or replace the methodology paragraph with:

> Edge is computed using a physical-measure probability model. The model blends ETF options implied volatility with 20-day realized volatility (per-commodity weighting) and applies an empirical drift estimator (60-day realized return blended with a long-run prior). This corrects a known +5–10pp bias on near-the-money strikes that affects pure risk-neutral models on weekly commodity contracts.

Per CLAUDE.md compliance rules: no mentions of Databento, OPRA, Tradier, Massive, "real-time options chain", "live options feed". The above phrasing is compliant.

### 2.7 Pre-merge validation — Phase A

```bash
cd /Users/benny/pmp-ingestion

# Lint + tests
npm run lint
npm test -- commodity-base

# Smoke run against staging Kalshi (or local with FORCE_DRY_RUN=1)
WRITER_TAG=delayed_test FORCE_DRY_RUN=1 node src/index.js --once --commodities silver,gold,oil,bitcoin 2>&1 | tee /tmp/v2-smoke.log

# CRITICAL: Verify BTC rows have model_version=v1_riskneutral and edge_pp == fused_edge_pp
grep -E "bitcoin.*model_version|bitcoin.*fused_edge" /tmp/v2-smoke.log | head -10

# Verify silver/gold/oil rows have model_version=v2_physical
grep -E "(silver|gold|oil).*model_version" /tmp/v2-smoke.log | head -10
```

Then in Supabase SQL editor, after one live snapshot lands per commodity:

```sql
SELECT
  commodity,
  COUNT(*) AS rows,
  COUNT(*) FILTER (WHERE model_version = 'v2_physical') AS v2_rows,
  COUNT(*) FILTER (WHERE model_version = 'v1_riskneutral') AS v1_rows,
  AVG(ABS(COALESCE(edge_pp,0) - COALESCE(fused_edge_pp,0)))
    FILTER (WHERE edge_pp IS NOT NULL AND fused_edge_pp IS NOT NULL) AS avg_v1_v2_delta_pp
FROM commodity_edge_signals
WHERE snapshot_at > NOW() - INTERVAL '1 hour'
GROUP BY commodity
ORDER BY commodity;
```

**Required outcomes — Phase A merge is blocked if any of these fail:**
- silver: v2_rows > 0, v1_rows ≈ 0 (graceful fallback only)
- gold: v2_rows > 0, v1_rows ≈ 0
- oil: v2_rows > 0, v1_rows ≈ 0
- **bitcoin: v1_rows = 100%, v2_rows = 0, avg_v1_v2_delta_pp = 0.0** ← non-negotiable
- No new entries in `system_alerts` table within the validation window
- `/health` endpoint on Fly returns green for all four commodities

### 2.8 Post-deploy live tracking — Phase A

Ship immediately when §2.7 passes. No artificial soak window. Instead, run these queries on a recurring basis (daily for first week, then weekly) to watch live performance:

```sql
-- Per-commodity V2 vs V1 Brier comparison on settled markets
-- (commodity_edge_settles + commodity_edge_signals join)
WITH settled_signals AS (
  SELECT
    s.commodity,
    s.event_ticker,
    s.strike,
    s.snapshot_at,
    s.model_version,
    s.direction,
    s.confidence,
    s.options_prob AS v1_prob,
    s.prob_physical AS v2_prob,
    se.outcome,
    CASE WHEN se.outcome = 'yes' THEN 1 ELSE 0 END AS yes_settled
  FROM commodity_edge_signals s
  JOIN commodity_edge_settles se
    ON se.commodity = s.commodity
   AND se.event_ticker = s.event_ticker
   AND se.strike = s.strike
  WHERE se.outcome IN ('yes', 'no')
    AND se.last_seen_at > NOW() - INTERVAL '30 days'
)
SELECT
  commodity,
  COUNT(*) AS settled_strikes,
  AVG(POW(v1_prob - yes_settled, 2)) FILTER (WHERE v1_prob IS NOT NULL) AS brier_v1,
  AVG(POW(v2_prob - yes_settled, 2)) FILTER (WHERE v2_prob IS NOT NULL) AS brier_v2,
  AVG(POW(v1_prob - yes_settled, 2)) FILTER (WHERE v1_prob IS NOT NULL)
    - AVG(POW(v2_prob - yes_settled, 2)) FILTER (WHERE v2_prob IS NOT NULL) AS brier_improvement_v2_over_v1
FROM settled_signals
GROUP BY commodity
ORDER BY commodity;
```

```sql
-- Live win-rate by tool_slug since cutover
SELECT
  p.tool_slug,
  COUNT(*) AS settled,
  SUM(CASE WHEN ts.resolution = 'won' THEN 1 ELSE 0 END) AS won,
  ROUND(100.0 * SUM(CASE WHEN ts.resolution = 'won' THEN 1 ELSE 0 END) / COUNT(*), 1) AS hit_rate_pct,
  SUM(ts.pnl_cents) / 100.0 AS total_pnl_usd,
  ROUND(AVG(ts.pnl_cents), 1) AS avg_pnl_cents
FROM tool_picks p
JOIN tool_settles ts ON ts.pick_id = p.pick_id
WHERE p.tool_slug IN ('silver-edge', 'gold-edge', 'oil-edge', 'bitcoin-edge')
  AND p.picked_at > '<DEPLOY_TIMESTAMP>'::timestamptz
GROUP BY p.tool_slug
ORDER BY p.tool_slug;
```

**Decision rules — apply continuously, not at a soak-window endpoint:**
- If a tool's hit rate after 15+ settled picks is still <30%, fire an investigation — likely a vol-blend weight or drift prior that needs retuning per-commodity (see §7 parking lot for the calibration knobs)
- If V2 Brier is *worse* than V1 on ≥20 settled markets per commodity → the drift estimator may be overfit to the backtest period; consider lowering W_REALIZED in drift.js or rolling back to V1 for that specific commodity via `useV2Cutover: false`
- If V2 Brier improves over V1 by ≥0.02 absolute on a commodity → consider also tightening fusedTier thresholds for that commodity (currently STRONG ≥12pp; with a calibrated model maybe ≥10pp)
- **Bitcoin should show ZERO change to win rate, pnl, or row volume.** If anything moves on BTC, stop and check the carve-out flag.

Live tracking is the new soak. Adjust in flight; don't gate.

---

## 3. Phase B — Oil USO-synthetic spot (lands after Phase A soak)

### 3.1 What changes

Oil currently pulls intraday spot from Yahoo CL=F (or contract-aware CLM26.NYM) — both ~10–15 min delayed and structurally fragile (cookie+crumb endpoint). Replace with a synthetic WTI spot derived from Databento's real-time USO underlyingPrice (already flowing into the engine), calibrated daily against FRED DCOILWTICO.

Architecture:

```
Yahoo CL=F (delayed)            ── DROP from primary path, KEEP as tertiary fallback
   ↓
Databento USO underlyingPrice (real-time during OPRA hours)  ← NEW PRIMARY
   ×
wti_per_uso ratio = FRED.DCOILWTICO_yesterday / USO_yesterday_close  ← NEW DAILY ANCHOR
   ↓
synthetic_wti_spot = USO_realtime × wti_per_uso
   ↓
FRED divergence gate (>150bp → tier demote) ← EXISTING SAFETY NET
   ↓
Snapshot guards (min strikes, smile coherence, cold-start) ← EXISTING
```

### 3.2 New file — `src/feeds/uso-synthetic.js`

```javascript
// Synthetic WTI spot — derived from real-time USO ETF mid (already flowing
// from Databento as underlyingPrice on every contract in the chain) and
// anchored daily to FRED's DCOILWTICO official EIA close.
//
// Why this exists: Yahoo CL=F is the only previously-available free real-time
// WTI source and it's ~10-15 min delayed with a fragile cookie+crumb endpoint.
// Databento's OPRA feed for USO returns the live USO mid in underlyingPrice;
// we get it for free with the options subscription. Multiplying by a daily
// ratio gives us sub-second WTI spot tracking during the only hours we
// actually write snapshots (OPRA-hours: 9:30 AM–4:00 PM ET).
//
// Roll-day caveat: USO rolls front-month to second-month over 4 trading days
// each month (typically days 8-11 of the month). During roll, USO is partially
// exposed to two CL contracts simultaneously and the per-USO WTI ratio drifts.
// The FRED divergence gate in commodity-base.js catches this — if synthetic
// diverges from DCOILWTICO by >150bp the row's tier is demoted automatically,
// no roll-window detection logic needed here.

import { getFredDailyClose } from './fred.js';
import { fetchPrevClose } from './options-provider.js';

const RATIO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6h — refreshes ~once per session
let _ratioCache = null;  // { wtiPerUso, asOf, ts }

const USO_SYMBOL = 'USO';
const FRED_WTI = 'DCOILWTICO';

// Compute (or return cached) wti_per_uso ratio from yesterday's official EIA
// WTI close + yesterday's USO close. Returns null when either feed fails;
// caller falls back to upstream Yahoo CL=F path.
export async function getWtiPerUsoRatio({ now = new Date() } = {}) {
  if (_ratioCache && now.getTime() - _ratioCache.ts < RATIO_CACHE_TTL_MS) {
    return _ratioCache;
  }
  try {
    const [fred, usoPrev] = await Promise.all([
      getFredDailyClose(FRED_WTI),
      fetchPrevClose(USO_SYMBOL),
    ]);
    if (!fred || !(fred.price > 0) || !(usoPrev > 0)) {
      console.warn(
        `[uso-synthetic] insufficient anchor data — fred=${fred?.price} uso=${usoPrev}`,
      );
      return null;
    }
    const wtiPerUso = fred.price / usoPrev;
    _ratioCache = {
      wtiPerUso,
      asOf: fred.observation_date,
      usoPrevClose: usoPrev,
      wtiPrevClose: fred.price,
      ts: now.getTime(),
    };
    console.log(
      `[uso-synthetic] anchor refreshed: WTI ${fred.price.toFixed(2)} / USO ${usoPrev.toFixed(2)} = ${wtiPerUso.toFixed(4)} (as_of ${fred.observation_date})`,
    );
    return _ratioCache;
  } catch (err) {
    console.warn(`[uso-synthetic] ratio fetch failed: ${err?.message || err}`);
    return null;
  }
}

// Synthesize WTI spot from a live USO underlyingPrice quote.
// Returns { price, source, publishTimeMs, anchor } or null on failure.
export async function synthesizeWtiSpot(usoUnderlyingPrice, opts = {}) {
  if (!(usoUnderlyingPrice > 0)) return null;
  const ratio = await getWtiPerUsoRatio(opts);
  if (!ratio) return null;
  return {
    price: usoUnderlyingPrice * ratio.wtiPerUso,
    source: 'uso_synthetic_v1',
    publishTimeMs: opts.publishTimeMs ?? Date.now(),
    anchor: {
      wti_per_uso: ratio.wtiPerUso,
      as_of: ratio.asOf,
      uso_prev_close: ratio.usoPrevClose,
      wti_prev_close: ratio.wtiPrevClose,
    },
  };
}

export const __test__ = {
  _ratioCache,
  RATIO_CACHE_TTL_MS,
};
```

### 3.3 `src/engine/commodities.js` — oil entry

Add a new flag to the oil entry. Do NOT remove the Yahoo flags — they stay as tertiary fallback.

```javascript
oil: {
  commodity: 'oil',
  seriesTicker: 'KXWTI',
  underlyingEtf: 'USO',
  pythSymbol: 'WTI',
  spotUnit: '$/bbl',
  spotLabel: 'USO-synthetic (Databento USO × FRED DCOILWTICO daily anchor)', // updated
  enabled: true,
  useUsoSynthetic: true,    // NEW — primary path, takes precedence over useYahooSpot
  useYahooSpot: true,        // KEPT — tertiary fallback only
  useContractAwareSpot: true, // KEPT — used only if Yahoo path is taken
  bypassWriterTag: true,
  fredSeriesId: 'DCOILWTICO',
  snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
  snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
  snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
  pauseSnapshotsOffHours: true,
},
```

### 3.4 `src/engine/commodity-base.js` — spot resolution

Modify the spot resolution block at the top of `computeSnapshot()` (currently L348–395) to add USO-synthetic as the new primary path for oil. Existing Yahoo paths become fallbacks.

```javascript
// BEFORE — current order is Yahoo (with contract-aware) OR Pyth
const useYahooSpot = config.useYahooSpot === true;
let spot = null;
if (useYahooSpot && config.useContractAwareSpot === true) {
  // ... existing contract-aware Yahoo path
}
if (!spot) {
  spot = useYahooSpot ? getOilSpot() : getPrice(config.pythSymbol);
}

const chain = getChain(config.underlyingEtf);
// ... existing chain handling

// AFTER — USO-synthetic primary, Yahoo as tertiary fallback
import { synthesizeWtiSpot } from '../feeds/uso-synthetic.js';  // ADD at top of file

// (inside computeSnapshot)
const useUsoSynthetic = config.useUsoSynthetic === true;
const useYahooSpot = config.useYahooSpot === true;

// Chain must be fetched first when using USO-synthetic — we need the live
// USO underlyingPrice off the chain to synthesize spot. Pyth/Yahoo paths
// don't depend on chain so order doesn't matter for them.
const chain = getChain(config.underlyingEtf);

let spot = null;

// PRIMARY: USO-synthetic (oil only)
if (useUsoSynthetic && chain?.contracts?.length > 0) {
  const usoLive = chain.contracts.find((c) => c.underlyingPrice != null)?.underlyingPrice;
  if (usoLive > 0) {
    const synthetic = await synthesizeWtiSpot(usoLive);
    if (synthetic) {
      spot = synthetic;
      console.log(
        `[${config.commodity}] USO-synthetic spot: USO $${usoLive.toFixed(2)} × ${synthetic.anchor.wti_per_uso.toFixed(4)} = $${synthetic.price.toFixed(2)} WTI (anchor ${synthetic.anchor.as_of})`,
      );
    }
  }
}

// SECONDARY: contract-aware Yahoo (oil-only, existing path retained)
if (!spot && useYahooSpot && config.useContractAwareSpot === true) {
  try {
    const settle = await getActiveSettleContract(config.seriesTicker, event.closeTime);
    if (settle) {
      const cSpot = await getContractSpot(settle.yyyymm);
      if (cSpot && cSpot.price > 0) {
        spot = {
          price: cSpot.price,
          publishTimeMs: cSpot.publishTimeMs,
          source: cSpot.source,
        };
        console.log(
          `[${config.commodity}] FALLBACK contract-aware Yahoo spot ${settle.contract} (${cSpot.symbol}) = $${cSpot.price.toFixed(2)}`,
        );
      }
    }
  } catch (err) {
    console.warn(`[${config.commodity}] contract-aware spot failed: ${err?.message || err}`);
  }
}

// TERTIARY: Yahoo continuous CL=F (oil) or Pyth (silver/gold/btc)
if (!spot) {
  spot = useYahooSpot ? getOilSpot() : getPrice(config.pythSymbol);
  if (spot) {
    console.log(`[${config.commodity}] TERTIARY spot ${spot.source} = $${spot.price.toFixed(2)}`);
  }
}

if (!spot) {
  console.warn(`[${config.commodity}] all spot paths failed — skipping snapshot`);
  return null;
}

// (existing chain validation continues below)
if (!chain || !chain.contracts || chain.contracts.length === 0) {
  console.warn(
    `[${config.commodity}] empty chain — skipping snapshot (chain=${chain ? 'present' : 'null'}, contracts=${chain?.contracts?.length ?? 0})`,
  );
  return null;
}

// ... rest unchanged
```

### 3.5 Validation — Phase B

```bash
# Unit-test the synthesizer
cat > /tmp/test-uso-synth.js << 'EOF'
import { synthesizeWtiSpot, getWtiPerUsoRatio } from './src/feeds/uso-synthetic.js';
const ratio = await getWtiPerUsoRatio();
console.log('ratio:', ratio);
const spot = await synthesizeWtiSpot(70.50);
console.log('synthetic spot from $70.50 USO:', spot);
EOF
node --experimental-vm-modules /tmp/test-uso-synth.js

# Smoke run with synthetic enabled
WRITER_TAG=delayed_test FORCE_DRY_RUN=1 node src/index.js --once --commodities oil 2>&1 | tee /tmp/uso-synth-smoke.log
grep "USO-synthetic\|FALLBACK\|TERTIARY" /tmp/uso-synth-smoke.log
```

After a live snapshot:

```sql
-- Verify spot_source has switched to uso_synthetic_v1
SELECT
  commodity,
  spot_source,
  COUNT(*) AS rows,
  AVG(spot_price) AS avg_spot,
  MIN(snapshot_at) AS first,
  MAX(snapshot_at) AS last
FROM commodity_edge_signals
WHERE commodity = 'oil'
  AND snapshot_at > NOW() - INTERVAL '1 hour'
GROUP BY commodity, spot_source;

-- Cross-check synthetic vs FRED — divergence should be <150bp 95% of the time
SELECT
  date_trunc('hour', snapshot_at) AS hr,
  AVG(ABS(fred_divergence_bp)) AS avg_div_bp,
  MAX(ABS(fred_divergence_bp)) AS max_div_bp,
  COUNT(*) FILTER (WHERE divergence_warning = true) AS warn_count
FROM commodity_edge_signals
WHERE commodity = 'oil'
  AND spot_source = 'uso_synthetic_v1'
  AND snapshot_at > NOW() - INTERVAL '24 hours'
GROUP BY hr
ORDER BY hr DESC;
```

Expect average divergence well under 150bp. If avg_div_bp > 100bp consistently, the daily ratio anchor is drifting more than expected — could indicate a USO roll window or NAV deviation. Roll windows are auto-handled by the FRED gate demoting tier.

### 3.6 Methodology paragraph for oil

Replace the oil-edge methodology blurb to be honest about the spot source:

> Edge is computed using a physical-measure probability model with a synthetic WTI spot derived from real-time USO ETF mid quotes anchored daily to the EIA WTI Cushing daily close (FRED DCOILWTICO). This approach eliminates the latency in continuous-futures quote services while preserving accuracy against the official settlement reference.

---

## 4. Order of operations — ship it

```
1. Open new branch                    git checkout -b commodity-edge-v2-cutover
2. PHASE A — V2 cutover               edit src/engine/commodities.js per §2.2 (add useV2Cutover flags)
                                       edit src/engine/commodity-base.js per §2.2, §2.3
3. Local lint + tests                  npm run lint && npm test
4. BTC SAFETY CHECKS                  §2.4 static + dynamic checks (BLOCKING)
5. Local smoke run                     §2.7
6. Commit, push, open PR              "feat(engine): V2 physical-measure cutover (silver/gold/oil; BTC carved out)"
7. Merge after CI green                ship it
8. Post-deploy first-snapshot check   §2.4 BTC parity SQL — MUST pass within 5 min of deploy
9. Watch first live writes per cmdty   §2.7 SQL queries
10. PHASE B — USO-synthetic            new branch, new file per §3.2
11. Wire into commodities.js + commodity-base.js per §3.3, §3.4
12. Local smoke + spot-check          §3.5
13. BTC re-verify post-Phase-B        run §2.4 dynamic checks again — Phase B touches commodity-base.js
14. Commit, push, open PR             "feat(oil): USO-synthetic spot replaces Yahoo CL=F as primary"
15. Merge after CI green               ship it
16. Watch oil writes                  confirm spot_source = uso_synthetic_v1 dominates
17. Update methodology copy           per §2.6, §3.6
18. Final compliance pass             per §5
19. Live tracking                     §2.8 queries, daily for first week
20. 24h BTC re-check                  §2.4 post-deploy 24h checklist
```

**No soak window. No gates.** Ship Phase A, watch the data, ship Phase B, watch the data. If a commodity isn't trending toward winning after ~15 settled picks, iterate on the tuning knobs (vol blend weights in `vol.js`, drift prior in `drift.js`). The right loop is ship-measure-adjust, not gate-and-wait.

---

## 5. Compliance pre-flight (block the PR if these fail)

```bash
# OPRA — must return zero
grep -rn "Databento\|OPRA\|Tradier\|Massive\|real-time options chain\|live options feed" \
  /Users/benny/prediction-marketspicks/app \
  /Users/benny/prediction-marketspicks/content \
  /Users/benny/prediction-marketspicks/public \
  /Users/benny/prediction-marketspicks/llms.txt 2>/dev/null \
  | grep -v ".next\|node_modules"

# Word-swap — no bet/bettor/wager/sportsbook in new copy
grep -rn -wE "bet|bettor|wager|sportsbook|gambling|gambler|bookmaker|bookie" \
  app/tools/silver-edge app/tools/gold-edge app/tools/oil-edge app/tools/bitcoin-edge

# axios — must return zero
grep -rn "axios" package.json package-lock.json app/ lib/

# Build passes clean
npm run build && npm run lint
```

---

## 6. Backout — fast and per-commodity

If V2 cutover hurts a specific commodity (Brier worsens after ≥20 settles, or Discord noise spikes, or unit tests catch a sign flip), back out PER COMMODITY via the config flag — no git revert needed, no full rollback:

```javascript
// In src/engine/commodities.js
// To pull just gold back to V1 while leaving silver/oil on V2:
gold: {
  // ... existing config
  useV2Cutover: false,  // was true — flip back to V1
},
```

Commit, redeploy, that commodity is back on V1 within the next snapshot cycle. The other commodities are unaffected.

If V2 cutover is catastrophically broken across all three (rare — would mean the cutover logic itself has a bug):

```bash
git revert <V2 cutover commit SHA>
# No DB changes to roll back — schema is unchanged, V1 columns were preserved
# Existing rows from V2 era keep their values; future rows revert to V1
```

**🛡 If bitcoin behavior changes at all post-deploy: REVERT IMMEDIATELY** via the full git revert above. Do not attempt to debug in-flight — restore the known-good BTC code path first, then investigate from a clean baseline. The carve-out flag should make this impossible, but if it happens it means something deeper is wrong.

If USO-synthetic causes a regression on oil specifically:

```javascript
// In src/engine/commodities.js oil entry:
useUsoSynthetic: false,  // back to Yahoo CL=F primary
```

---

## 7. Open items / parking lot (NOT this PR)

- Futures-curve drift component for oil (`drift.js` Phase 2 — uses CL1 vs CL2 slope)
- Vol-blend re-calibration from V2 settled data (after soak)
- SVI smile fit replacing linear interp (minor lift at wings)
- Hourly KXSILVERH / KXGOLDH if Kalshi lists them
- Public surface display of `physical_edge_pp` alongside legacy `edge_pp` on admin pages
- Updating `docs/COMMODITY_FEEDS.md` to reflect USO-synthetic as primary oil spot

---

## 8. Quick reference — files touched

**Phase A (V2 cutover):**
- `src/engine/commodity-base.js` (edit ~10 sites, ~100 LOC delta)

**Phase B (USO-synthetic):**
- `src/feeds/uso-synthetic.js` (new, ~80 LOC)
- `src/engine/commodities.js` (edit oil entry, ~5 LOC delta)
- `src/engine/commodity-base.js` (edit spot resolution block, ~40 LOC delta)

**Prediction-marketspicks (methodology copy):**
- `app/tools/silver-edge/page.tsx`
- `app/tools/gold-edge/page.tsx`
- `app/tools/oil-edge/page.tsx`
- `app/tools/bitcoin-edge/page.tsx`

**Tests/docs:**
- `test/engine/commodity-base.test.js` (extend with V2 cutover assertion + fallback test)
- `test/feeds/uso-synthetic.test.js` (new, smoke test the synthesizer + ratio cache)
- `docs/COMMODITY_FEEDS.md` (update oil section)

---

**End of plan.** Drive this top-to-bottom. Phase A is the critical fix and lands first. Phase B is the quality lift and lands after Phase A soaks for two weeks. Backup is overkill — the existing fallback architecture handles every failure mode the new code path can produce.
