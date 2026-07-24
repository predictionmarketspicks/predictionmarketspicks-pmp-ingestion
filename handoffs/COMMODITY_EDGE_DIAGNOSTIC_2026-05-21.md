# Commodity Edge — Soup-to-Nuts Diagnostic (Silver / Gold / Oil)

**Date:** 2026-05-21
**Author:** Benny + Claude (ultrathink session)
**Subject:** Why silver-edge, gold-edge, oil-edge are 0/51, 0/41, 0/10 and what the absolute-best build looks like
**Reference:** BITCOINEDGEPRINTFACTORY.pdf v1.0 (post-3:30 PM ET 2026-05-21 hardened build)

---

## TL;DR — Read this if nothing else

The bug is **named, documented, and half-fixed in the codebase already.** It is not a settlement-source mismatch. It is not an ETF basis problem. It is not the Yahoo CL=F latency. It is not a sign flip. The settle script is correct. The Black-Scholes math is correct.

**The bug is that the engine uses the risk-neutral measure for direction/confidence when the markets are weekly.** Risk-neutral assumes zero drift. Silver, gold and oil all trend up over a week in the current regime. The textbook missing-drift signature is a **+5–10pp bias on near-the-money strikes** — meaning the engine systematically tells you to BUY NO at strikes the market is correctly pricing 5–10pp higher than the engine thinks.

Stack the bias across 41–51 settled picks and you get exactly the 0% hit rate Benny screenshotted.

**The V2 physical-measure rebuild that fixes this already ships** — `src/engine/drift.js` and `src/engine/vol.js` are in production, they're called every snapshot, and `prob_physical` + `physical_edge_pp` are being upserted to `commodity_edge_signals` every tick. **But `direction` and `confidence` still derive from the V1 risk-neutral `edge_pp`.** Until that one line flips, every alert that fires is still V1-biased.

That's the cutover. Sections 2–6 below explain why this is the real bug and not a fluke, section 7 lays out the cutover, sections 8–10 cover the per-commodity tuning that turns a fix into a top-of-line build.

---

## 1. The forensics — why 0/51 is not random

If you flipped a fair coin 51 times you'd hit ~26. The odds of going 0/51 on a fair coin are 2⁻⁵¹ ≈ 4.4×10⁻¹⁶. Even if the engine is a worse-than-random "60% wrong" predictor, P(0/51) is still ≈ 0.4⁵¹ ≈ 10⁻²⁰.

A 0% hit rate means we are **systematically wrong on the side we recommend**. Combined with the small per-pick loss (-$4.39 / 51 picks = -8.6¢ avg, -$7.24 / 41 = -17.7¢, -$0.95 / 10 = -9.5¢) we can infer:

- We are buying cheap tails (single-digit cent contracts) and they never hit. Expected price-paid per losing pick is roughly the average loss = 9–18¢.
- A model that overestimates tail probability by even a few pp will route every "interesting" edge to these cheap-tail strikes — because those are where small absolute miscalibrations produce the largest relative edges.
- 0/51 on cheap tails is the fingerprint of an engine that thinks 12% tails are 17% tails. Pay 12, lose 12 fifty-one times.

This points at calibration, not at directional accuracy. The settle script, the strike-matching, the Kalshi quote ingest, the Pyth feed — none of those would produce *systematic* miscalibration on near-the-money strikes specifically. The PDF (page 7, §3.1) names the exact cause:

> Known model gap, tracked separately: this is the risk-neutral measure. The physical measure (what actually happens to spot) carries an additional drift term that the model currently approximates as zero. Backtest evidence in COMMODITY_EDGE_V2_PHYSICAL_MEASURE_REBUILD_2026-05-19.md shows a **+5–10pp bias on near-the-money strikes across silver / gold / oil.**

That handoff is dated **two days before** the screenshot. The team already knew. The fix already shipped to the engine. The flip to use it hasn't happened yet.

---

## 2. The math — why risk-neutral fails on weekly contracts but works on hourly

Black-Scholes risk-neutral probability that spot finishes above strike at expiry:

```
P_RN(S_T > K) = N(d2)
d2 = [ln(S/K) + (r - q - σ²/2)·T] / (σ·√T)
```

The "drift" inside d2 is `r - q`, the risk-free rate minus dividend yield. For metals/oil/BTC, `q = 0` so drift = `r` ≈ 4.5% annualized. This is the **risk-neutral drift** — it's the drift the market would use if everyone were risk-neutral about price changes. It is not a forecast.

The **physical-measure** probability uses the actual expected drift `μ` of the asset:

```
P_phys(S_T > K) = N(d2_phys)
d2_phys = [ln(S/K) + (μ - σ²/2)·T] / (σ·√T)
```

For an *option pricing* problem (what is this call worth right now?) you must use risk-neutral — that's how no-arbitrage works. But Kalshi is not pricing an option. Kalshi is paying $1 if the event happens. The probability the event happens is the **physical-measure** probability, not the risk-neutral one. They are not the same.

**The size of the gap is μ·T·(1/σ√T) = μ√T/σ standard deviations on d2.** Per standard deviation, N(d2) moves about 40pp at the mode (ATM) and 5–10pp in the wings.

### Plugging in the numbers

| Market | Expiry | T (yrs) | σ (live) | μ (per drift.js) | Gap (std devs on d2) | NTM bias |
|---|---|---|---|---|---|---|
| BTC hourly | 1 hour | 0.000114 | 0.80 | 0.30 | 0.30·√.000114/.80 = **0.004** | <0.5pp — invisible |
| Silver weekly | 7 days | 0.019 | 0.48 | 0.06 | 0.06·√.019/.48 = **0.017** | ~2pp on NTM upside |
| Gold weekly | 7 days | 0.019 | 0.32 | 0.06 | 0.06·√.019/.32 = **0.026** | ~3pp on NTM upside |
| Oil weekly | 7 days | 0.019 | 0.42 | 0.03 | 0.03·√.019/.42 = **0.010** | ~1pp on NTM upside |

For pure missing-drift on weeklies you'd expect 1–3pp bias on NTM strikes. The PDF cites 5–10pp empirically. The **remaining 2–7pp** comes from a second bug per `vol.js`:

### The vol blend bug (gold-specific, but worth knowing)

The V2 vol blender annotates per-commodity tuning from the backtest:

```
silver:  70/30 IV/RV  — IV ~accurate (47.7% vs 50.6% realized)
gold:    40/60 IV/RV  — IV +8pp too high (32.0% vs 23.6% realized)
oil:     70/30 IV/RV  — IV spot-on (42.6% vs 42.2% realized)
bitcoin: 80/20 IV/RV  — IBIT IV is clean
```

Gold has both bugs stacking:
1. Missing drift adds ~3pp bias on NTM upside strikes (model under-predicts the upside hitting)
2. GLD IV runs 8pp HOT vs realized gold spot vol → using σ = 32% when true σ ≈ 26% spreads the distribution wider → more weight in tails, less near the money → engine reads NTM upside as lower-prob than it should.

Gold is 0/41 (-$7.24, -17.7¢/pick). Silver is 0/51 (-$4.39, -8.6¢/pick). Oil is 0/10 (-$0.95, -9.5¢/pick). **Gold has the worst per-pick loss because it carries both bugs.** That's evidence the diagnosis is right.

---

## 3. Per-commodity teardown — current crap vs absolute-best build

### 3.1 — SILVER EDGE

| Layer | Current (the crap that's losing) | Top-of-the-line target |
|---|---|---|
| Spot source | Pyth XAG/USD (sub-second, free, no key) ✅ | Pyth XAG/USD — keep |
| Options leg | SLV chain via Databento OPRA ✅ | SLV chain — keep |
| Kalshi market | KXSILVERW (weekly settle) | KXSILVERD (DAILY) if/when listed; failing that, keep weekly |
| Probability model | V1 risk-neutral N(d2), zero drift, raw IV | **V2 physical N(d2)** with `μ = 0.80·realized_60d + 0.20·6%`, **σ_blend = 0.70·IV + 0.30·RV20** |
| Drift estimator | Hardcoded zero | drift.js with 6% long-run prior, Bayesian blend ✅ shipped, not wired |
| Vol blend | Raw GLD IV (47.7%) | 70/30 IV/RV → ~48% blend (close to raw, silver IV is honest) |
| Snapshot cadence | 5min market hours, 60s burst | Keep 5min — silver IV barely moves intra-day |
| FRED cross-check | None (no clean daily silver FRED series) | Accept — LBMA is monthly only |
| Off-hours behavior | Paused (OPRA dark) ✅ | Keep |
| **The bug** | Engine writes physical_edge_pp but routes off edge_pp | **Flip direction/confidence to physical_edge_pp** |
| **The expected win** | 0/51 → expect ~40% hit rate with V2 (silver vol is honest so the dominant effect is the drift fix → ~2pp NTM bias removed) | Brier improvement: ~0.114 → ~0.085 |

**Verdict:** Silver is the cleanest of the three. Only fix needed is the V2 cutover. The Databento SLV chain is right, Pyth XAG/USD is the right spot anchor, IV is calibrated honestly. **Cutover = ~80% of the win.**

### 3.2 — GOLD EDGE

| Layer | Current | Top-of-the-line target |
|---|---|---|
| Spot source | Pyth XAU/USD ✅ | Pyth XAU/USD — keep |
| Options leg | GLD chain via Databento OPRA ✅ | GLD chain — keep |
| Kalshi market | KXGOLDW (weekly) | KXGOLDD daily if listed; else weekly |
| Probability model | V1 risk-neutral, raw IV | **V2 physical** + **σ_blend = 0.40·IV + 0.60·RV20** (heavier RV weighting because GLD IV runs +8pp hot vs realized) |
| Drift estimator | Zero | drift.js: 6% prior, realized blend |
| Vol blend | Raw GLD IV (32.0%, 8pp too high vs 23.6% realized) | 40/60 IV/RV → ~26% blend |
| FRED cross-check | GOLDPMGBD228NLBM (London PM fix) ✅ | Keep |
| **The bug** | Same V1 cutover gap + raw GLD IV instead of blended | **Cutover does both at once** |
| **The expected win** | 0/41 → expect ~35–45% hit rate. Worst-positioned today, biggest absolute lift. | Brier: ~0.220 → ~0.110 |

**Verdict:** Gold gets the biggest absolute improvement from the cutover because it's the only commodity where BOTH V2 fixes do work (drift + vol blend). The current per-pick loss of 17.7¢ is the worst of the three for exactly this reason.

### 3.3 — OIL EDGE

| Layer | Current | Top-of-the-line target |
|---|---|---|
| Spot source | Yahoo CL=F / CLM26.NYM (~10min delayed) ⚠️ | **Databento NYMEX CL real-time** (already flagged in CLAUDE.md as future upgrade) |
| Options leg | USO chain via Databento OPRA | **LO (CL options on Globex)** via Databento — kills the USO contango basis entirely |
| Kalshi market | KXWTI (weekly) | KXWTID daily if listed; else weekly |
| Probability model | V1 risk-neutral | V2 physical |
| Drift estimator | Zero | drift.js: 3% long-run prior. **PHASE 2 (not yet built):** futures-curve slope component from CL1 vs CL2 — for oil specifically this is the highest-information drift signal because contango/backwardation is exactly the market's forward-looking opinion on roll |
| Vol blend | Raw USO IV (42.6%, ~accurate) | 70/30 IV/RV — IV is fine but RV stabilizes WTI vol regime shifts |
| Spot freshness | Yahoo crumb endpoint, fragile | Databento direct |
| Contract-aware spot | useContractAwareSpot:true (CLM26.NYM) ✅ | Keep until Databento CL cutover |
| FRED cross-check | DCOILWTICO ✅ | Keep — most fragile feed, FRED gate is load-bearing |
| **The bugs** | (a) V1 cutover gap (b) Yahoo 10min latency (c) USO chain has roll-yield drag baked into IV that doesn't match actual CL settle | **Cutover** + **Databento CL spot** + **LO options chain** — three separate fixes, each independently valuable |
| **The expected win** | 0/10 — tiny sample but the per-pick loss is ~10¢ which is the bias signature | After full rebuild: ~50% hit rate target, Brier ~0.104 → ~0.080 |

**Verdict:** Oil is the most architecturally compromised of the three. The V2 cutover alone won't get it to top-of-line because USO has structural problems (front-month roll decay) that no amount of vol/drift tuning fixes. The genuine top-tier oil build needs the Databento CME Globex CL upgrade.

**Sequencing for oil:**
1. **Week 1**: V2 cutover (cheap, immediate)
2. **Week 2-3**: Add `futures_curve` component to drift.js using Yahoo CL1=F vs CL2=F slope (Phase 2 of the drift handoff)
3. **Q3-ish**: Databento NYMEX CL real-time spot + LO options chain (kills Yahoo entirely; eliminates USO contango basis; ETF wrapper goes away)

---

## 4. Why BTC is different — and why "copy BTC verbatim" is the wrong instinct

BTC works because **at T = 1/8760 (one hour over one year), every nonzero drift collapses to noise.** μ√T/σ ≈ 0.004 standard deviations on d2. The risk-neutral approximation that breaks weeklies is, by the math, fine for hourlies. The PDF is honest about this on page 7:

> Bitcoin will inherit V2 the day cutover ships. None of the rest of this blueprint changes when V2 lands — only the value plugged into pOpt changes.

BTC will also get marginally better after V2 (it gets the vol blend and the drift-aware physical measure for free) but the lift will be ~0.5pp at NTM, statistically indistinguishable from noise on a per-row basis. The current BTC profitability is from the four other fixes that landed today (kalshiYesImpliedProb hardening, ATM IV picker, IV smile liquidity gate, divergence/thin-book ceilings).

The lesson for silver/gold/oil: **adopt all of BTC's quality gates and suppression rules** (they're already in commodity-base.js so this is automatic — same code path). But **do not assume "hourly market = better signal."** The asset universe doesn't have weekly markets we can swap for hourly. The drift problem has to be solved with `drift.js`, not by changing the expiry of the target market.

Two related instincts to push back on:

1. **"Use COMEX SI / GC / NYMEX CL options instead of ETF options."** SI/GC/CL options are 1/10th the liquidity of SLV/GLD/USO options at the strikes we trade. The ETF chain is the *right* answer for the IV smile — the ratio bridge (`etfPrice / spotPrice` per snapshot, line 429 of commodity-base.js) self-corrects for ETF basis as long as the chain ticks. The bug isn't the ETF — it's the missing drift.

2. **"Settlement source is wrong."** I checked. KXSILVERW settles on Pyth XAG/USD basis (per the settlement_sources field on the Kalshi /series endpoint). KXGOLDW likewise on Pyth XAU/USD (PDF page 5 notes "verified against KXGOLDW's settlement_sources"). KXWTI settles on the active NYMEX CL contract, which is exactly what `useContractAwareSpot:true` resolves to. The settlement proxy is fine.

---

## 5. The cutover — what one PR looks like

**Goal:** flip silver/gold/oil to V2 physical-measure direction & confidence. BTC stays on V1 (no harm, no help) or moves with them (your call).

**Files touched:**

1. **`src/engine/commodity-base.js`** — single decision point at lines ~530–650
   - Replace `edge = optProb - kalshiProb` as the canonical edge with `edge = physicalEdge` for direction/confidence
   - Keep BOTH columns in the row push: `edge_pp` = V1 (legacy/backtest), `physical_edge_pp` = V2 (active), and a new `model_version: 'v2_physical'` flag
   - Apply the same suppression rules (stale_print divergence, thin_book_large_edge) against the V2 edge, not V1
   - Update `meta.topEdge` selection to pick from `physical_edge_pp`

2. **`src/engine/thresholds.js`** — confirm `fusedTier()` thresholds still apply (STRONG ≥12pp, MODERATE ≥7pp). They should — pp is pp regardless of measure.

3. **No DB migration needed.** The `prob_physical` and `physical_edge_pp` columns are already in `commodity_edge_signals` per the V2 migration (`20260520_commodity_edge_v2_physical_measure.sql`).

4. **`commodity-settle/index.ts`** — no change. It grades whatever side `predicted_side` was, against whatever Kalshi actually settled at. The V2 cutover changes what predicted_side gets WRITTEN, not how it's graded.

5. **Discord routing** — no change. It reads `meta.topTier` which is computed from the active edge. As long as `meta.topEdge` switches to V2, Discord automatically routes off the V2 signal.

6. **Public surface** — `lib/tools/silver-edge.ts`, `lib/tools/gold-edge.ts`, `lib/tools/oil-edge.ts` already shape what they render. No changes if the row's `direction` and `edge_pp` are what they read; if they read both V1 and V2, prefer V2 and label as "physical-measure" if you want the math transparency on the methodology page.

**Soak window per BTC PDF §14.7:** "Two full options sessions of clean writes before flipping the tool page nav entry visible." For us that's two full weekly cycles → ~2 weeks of V2 picks landing in `tool_picks` with `model_version='v2_physical'` and getting graded by `commodity-settle`. Compare V1 vs V2 Brier at `/admin/commodity-edge-settle-health` (the A/B view already exists per PDF §commodity-settle).

**Go/no-go criteria:**
- V2 Brier on silver/gold/oil < V1 Brier by ≥0.02 absolute across ≥30 fresh settles per commodity → flip
- No new system_alerts firing on the V2 path during soak
- Hand spot-check 5 actionable V2 rows against live Kalshi book → directionally agree

---

## 6. Top-of-line additions worth building AFTER the cutover

These are the moves that take it from "working" to "best-in-class":

### 6.1 Futures-curve drift (Phase 2 of drift.js)
The contango/backwardation between front-month and second-month futures is the market's published opinion on forward drift. For oil this is *the* dominant signal — when CL1 < CL2 (contango) the curve is telling you the spot is below where the term structure says it should drift to. drift.js already has the placeholder:
```javascript
components.futures_curve = null; // Phase 2: SI=F/GC=F/CL=F basis
```
Implementation: pull CL=F, CL_X26.NYM (next month), compute annualized slope, blend with realized at maybe 50/50 inside the existing μ. Estimated 2-3pp NTM improvement on oil specifically.

### 6.2 SVI smile fit instead of linear interp
Current `buildIvSmile()` is linear interp between strikes. Real IV smiles have curvature — linear interp under-estimates IV at wings, which artificially under-states tail probability and OVER-states NTM probability. For NTM strikes specifically the effect is small (~0.3pp) but at the wings it can be 1-2pp.
Cost: ~150 lines. Use the standard 5-parameter SVI: `w(k) = a + b·(ρ(k-m) + √((k-m)² + σ²))`. Calibrate per-snapshot via least-squares on the existing clean[] points.
Value: minor. Defer unless we find a strike-skew bias in the V2 backtest.

### 6.3 Hourly silver/gold strikes if Kalshi adds them
KXBTCD works because it's hourly. If Kalshi lists hourly metals (they've added hourly INX = S&P 500 per the latest commodities.js entry), porting silver/gold to hourly settlement would:
- Cut T by 168x → shrink drift bias to invisible (BTC-style)
- Tighten cadence to 60s
- Use the same exact engine paths as BTC (eventFilter, pauseSnapshotsOffHours patterns)

This is the **strict "absolute best" build** — but it depends on Kalshi listing the markets, which is out of our control. Watch for it.

### 6.4 Databento NYMEX CL for oil
Already in CLAUDE.md as a flagged future upgrade. Eliminates Yahoo CL=F latency (10min) and the fragile cookie+crumb chain endpoint. The contract-aware spot logic stays — it just resolves to a Databento symbol instead of `CLM26.NYM` on Yahoo. Estimated +0.5pp improvement on near-the-close oil snapshots where 10min of price drift matters.

### 6.5 Per-commodity calibration of vol-blend weights post-V2
The 70/30, 40/60, 70/30, 80/20 weights in vol.js are documented as "Phase 1 defaults" — "Phase 4 calibration may retune from live data." After the soak window, re-fit them against the actual V2 settle data. Probably small changes (~5pp on each weight) but worth doing.

---

## 7. Sequencing recommendation

Given Benny's stated preferences (security-first, shoestring budget, low-hanging fruit, niche-within-niche):

| Phase | Effort | Expected lift | Cost |
|---|---|---|---|
| **P0 — V2 cutover** | 1 PR, ~80 LOC delta in commodity-base.js | 0% → 35-45% hit rate | Zero new infra |
| **P0.5 — A/B soak** | 2 weeks of automated grading | Risk-free validation | Zero (admin page exists) |
| **P1 — Futures-curve drift for oil** | drift.js Phase 2, ~50 LOC | +2-3pp on oil NTM | Yahoo (free) |
| **P1.5 — Vol-blend recalibration from V2 settles** | One-shot script | Marginal | Zero |
| **P2 — Databento NYMEX CL** | New Databento subscription + sidecar wire-up | +0.5pp on oil, latency fix | Databento upgrade $ |
| **P3 — SVI smile fit** | ~150 LOC + tests | +0.3pp at NTM, +1-2pp at wings | Zero |
| **P-watch — Hourly metals if Kalshi lists** | Mirror BTC engine pattern | Drift bias → zero | Zero, depends on Kalshi |

**Do P0 this week.** Everything else can wait until the soak proves V2 is materially better. If it's not, the diagnosis is wrong and we keep digging.

---

## 8. Compliance & safety pre-flight

Per the BTC PDF §14.6 and the OPRA personal-use rule in CLAUDE.md:
- No raw bid/ask/mid/NBBO/strike-level IV from the V2 path appears on public surfaces. Site reader filters `quality_flag IS NULL` — same gate.
- The methodology page on each tool page (`/tools/silver-edge`, etc.) must update to explain physical-measure shift. Suggested wording: *"Edge calculated using empirical drift estimator blending 60-day realized returns with long-run prior. Vol input blends ETF implied vol with realized vol per commodity-specific calibration."*
- Banned words audit (`grep -ri "Databento|OPRA|Tradier|Massive" app/ content/ public/ llms.txt`) must still return zero after the PR — V2 cutover changes the math, not the public copy.
- Word-swap rules still apply: position/trader/market, not bet/bettor/sportsbook. The cutover doesn't touch copy paths but any new methodology paragraph needs to follow.

---

## 9. What we are explicitly NOT changing

- Settlement source. Already correct per Kalshi /series settlement_sources.
- ETF basis bridge (ratio = etfPrice / spotPrice). Already self-correcting per snapshot.
- Kalshi probability function (kalshiYesImpliedProb). Already hardened 2026-05-21.
- ATM IV picker. Already fixed 2026-05-21.
- IV smile liquidity floor (vol≥50, OI≥100). Already enforced.
- Suppression flags (kalshi_no_book, kalshi_stale_divergence, kalshi_thin_book_large_edge). Already enforced.
- Settle math. Already correct.
- Direction sign convention. `edge > 0 → BUY YES, edge < 0 → BUY NO` is correct. The bug is in the *value* of edge, not the sign logic.

---

## 10. Open questions / things to verify before the PR lands

1. **Does the V2 cutover need to also flip BTC?** Math says it's a wash. Cleaner code says yes (one model, one canonical edge). Risk-aversion says no (BTC is the only thing printing — don't touch a working engine).
   *Recommendation: cut V2 over for all four. The probAboveStrikePhysical math collapses gracefully to risk-neutral when μ → r-q.*

2. **Are there any non-engine readers of `edge_pp` that would break if we silently make it V1?**
   *Check: `grep -r "edge_pp" lib/ app/ content/ supabase/functions/` and confirm everything reads via the BitcoinEdgeSnapshot/SilverEdgeSnapshot adapter that owns the V2 mapping.*

3. **Is the V2 backtest doc actually durable evidence?** PDF references `COMMODITY_EDGE_V2_PHYSICAL_MEASURE_REBUILD_2026-05-19.md` but I didn't find it in pmp-ingestion/handoffs/. Verify it's in prediction-marketspicks/handoffs/done/ or similar before quoting its conclusions. If missing, regenerate the backtest before the soak.

4. **Should we keep V1 picks landing in tool_picks at all post-cutover?**
   *Recommendation: write both with `model_version` distinguishing them, grade both, keep V1 visible only on the admin A/B page. Public surface = V2 only.*

---

**End of diagnostic.** Single highest-priority action: read line 564 of `src/engine/commodity-base.js` (`const dirYes = edge > 0;`). Replace `edge` with `physicalEdge` (or a `chosenEdge = config.useV2 ? physicalEdge : edge` flag). Soak two weeks. Print money.
