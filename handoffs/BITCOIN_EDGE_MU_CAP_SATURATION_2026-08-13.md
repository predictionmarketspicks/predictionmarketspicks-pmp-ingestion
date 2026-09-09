# Bitcoin Edge — the drift cap IS the model: mu pinned at ±12/yr displaces the whole CDF

**Status**: §4.1 SHIPPED + DEPLOYED `49113ed` (2026-08-13) — centre fixed as predicted.
**§7.4 #1 (band union) and #2 (near-expiry guard) SHIPPED 2026-09-09 — see §9, which is the
current state of this doc.** §7.4 #3 (persist intraday ladders) and #4 / §4.2 (the 1.64× width
error) remain open and are now the binding problem. §4.3 stays blocked behind them.
§5 loose thread RESOLVED — not a bug. §7 is the 2026-08-13 measurement that motivated §9.
**Date**: 2026-08-13
**Files implicated**: `src/engine/thresholds.js` (`BTC_MU_SCALE`, `BTC_MU_CAP_ANNUAL`), `src/engine/commodity-base.js` (`resolveTwapMu`, ~L800), `src/engine/short-horizon-vol.js`
**Related**: `BITCOIN_V2_CUTOVER_2026-07-27.md` (introduced the physical-measure mu path)
**Companion**: `BITCOIN_EDGE_GATE_REASON_CODES_2026-08-13.md`

---

## 1. Symptom

Public board, 2026-08-13 16:08 UTC, event `KXBTCD-26AUG1313`: **12 strikes, 12 PASS,
zero actionable.** Eight were NO-side rejections. Benny flagged four of the cards as
feeling wrong; the cards were the visible edge of the whole ladder being one-directional.

A directional edge appearing at *every strike simultaneously* is not a mispricing. Both
curves integrate to a single distribution each. Disagreement at all 12 strikes in the
same direction is **one location error observed 12 times**. A genuine mispricing is
local — a kink at one or two strikes, not a uniform tilt.

## 2. Measurement

Fitting a lognormal to each CDF across the 12 strikes (probit regression of `z` on
`ln K`; script preserved at §6):

| | implied median | σ to close |
|---|---|---|
| Market (bid/ask mid) | 63,356 = spot **+$6** | 0.350% |
| Model (`v2_physical`) | 63,246 = spot **−$104** | 0.419% |

Market median sits on spot — a correct 52-minute forward. **The model's median sits
−0.49σ below it, and its distribution is 1.20× too wide.** Wrong centre and wrong
width. Every negative edge on that page falls out of those two numbers mechanically.

## 3. Root cause: the drift cap binds, and it is the dominant term

`mu_used` on that snapshot was **exactly −12.0** — `BTC_MU_CAP_ANNUAL` (`thresholds.js:66`),
saturated. Contribution to the median over T = 51.6 min = 9.817e-5 yr:

```
Δln S = mu · T = −12 × 9.817e-5 = −1.178e-3  →  −$74.6 on $63,350  =  −0.34σ
```

That is **~70% of the measured −$104 shift**; the −σ²/2 term and IBIT→BTC basis carry the
rest. The centre error is not a subtle calibration drift. It is one constant.

**The cap is not a guardrail — it is the model's opinion.** Share of persisted bitcoin
rows sitting at |mu| ≥ 11.99:

| date | snaps | % at cap | % at −12 | % at +12 | avg mu |
|---|---|---|---|---|---|
| 08-03 | 6 | **100** | 50 | 50 | −16.22 |
| 08-04 | 19 | 38 | 33 | 4 | −11.57 |
| 08-05 | 21 | 57 | 14 | 43 | +1.71 |
| 08-06 | 23 | 16 | 14 | 1 | +1.47 |
| 08-07 | 30 | 71 | 57 | 14 | −5.89 |
| 08-10 | 32 | 45 | 45 | 0 | −6.76 |
| 08-11 | 27 | 57 | 15 | 42 | +5.72 |
| 08-12 | 25 | 71 | 57 | 14 | −6.12 |
| 08-13 | 30 | **99** | 83 | 17 | −7.91 |

Reproduce:

```sql
select date_trunc('day', snapshot_at)::date d, count(distinct snapshot_at) snaps,
  round((100.0*count(*) filter (where abs(mu_used) >= 11.99)/count(*))::numeric,0) pct_at_cap,
  round(avg(mu_used)::numeric,2) avg_mu
from commodity_edge_signals
where commodity='bitcoin' and mu_used is not null and snapshot_at > now() - interval '10 days'
group by 1 order by 1;
```

Read the table as three findings:

1. **The cap binds on a majority of rows most days** (median ~57%, 99% today). A sanity
   clamp that fires on the majority of observations is no longer a clamp; it is the
   estimator, and it is a square wave with two values.
2. **Its sign flips day to day** — avg mu +5.72 on 8/11, −7.91 on 8/13. So the entire
   model CDF is being displaced by roughly ±0.34σ, direction set by a 15-minute momentum
   reading. That displacement, not any options-chain information, is producing most of
   what the tool prints as "edge".
3. **The 14-day mean is −2.10**, i.e. tilted negative on net — which is precisely why the
   rejections pool on the NO side, and a sufficient explanation for NO going 1-for-15
   live and ≤14% in replay without needing any story about model bias in the smile.

The mechanism is documented and deliberate — `short-horizon-vol.js` clamps `mu_annual`
to ±`MU_CAP` (3.0) but also exports `mu_annual_raw` "for consumers with their own
horizon-appropriate clamp", and `resolveTwapMu` consumes the **raw** value, scales it by
`BTC_MU_SCALE` (0.4) and re-caps at 12. The intent was to let intra-hour momentum speak.
The result is that a 15-minute drift estimate, annualised, saturates its own 4×-widened
cap most of the time.

**A 15-minute momentum estimate annualised to ±12/yr is noise with a sign.** BTC log
returns have effectively no exploitable autocorrelation at that horizon; the estimator's
sampling error alone is far larger than any real drift, and the cap converts that noise
into a two-valued square wave applied to the median.

## 4. Recommended fix, in order of confidence

1. **Set `BTC_MU_SCALE = 0` (or `BTC_MU_CAP_ANNUAL` ≈ 0.5) and re-measure.** One constant,
   no math changes, instantly revertible. This is the highest-information move: it tests
   "is the mu term the whole story?" in one deploy. Prediction if correct — the median
   shift collapses from −0.49σ toward ~−0.15σ, edges stop being one-directional across
   the ladder, and both YES and NO signals reappear.
2. **Then attack the residual width error.** Model σ is 1.20× market's; even at mu = 0
   that alone manufactures fake tail edges. Suspect the σ blend (`sigma_blend` 0.545 vs
   `sigma_iv` 0.627 on the 8/13 snapshot) and the IBIT→BTC vol translation.
3. **Only after 1 and 2, revisit `noSideEnabled`.** The 7/27 kill switch was the correct
   emergency stop but it treated a symptom — the NO side was losing because the *centre*
   was wrong, not because the NO floor was too loose. Re-enabling before fixing the
   centre would just resume the 1-for-15.
4. **Add a board-level invariant.** If ≥90% of live-book strikes in a snapshot share an
   edge sign, that is a location error, not N opportunities — flag the snapshot
   `quality_flag='one_sided_ladder'` and suppress publication. This is the cheap
   monitor that would have caught it on 8/3 instead of 8/13, and it generalises to
   silver/gold/oil.

## 5. Loose thread worth one query

On the 18:38 UTC snapshot, `edge_pp` reconciled exactly against `options_prob` (v1
shadow) while `calibrated_prob` differed materially (0.7013 vs 0.5853 at strike 63,000)
— under `model_version = 'v2_physical'`. On the 16:08 snapshot `model_prob ≈ options_prob`,
so it did not show. **Untested**: whether the edge is ever computed off the v1 prob while
the row is labelled v2. If so it is a separate and larger bug than anything above. Check
before starting §4.1 so the baseline is trustworthy:

```sql
select snapshot_at, strike, options_prob, calibrated_prob, prob_physical, edge_pp,
       edge_pp - (options_prob - (kalshi_yes_bid+kalshi_yes_ask)/2) as resid_vs_v1,
       edge_pp - (calibrated_prob - (kalshi_yes_bid+kalshi_yes_ask)/2) as resid_vs_cal
from commodity_edge_signals
where commodity='bitcoin' and model_version='v2_physical'
  and snapshot_at > now() - interval '2 days'
  and kalshi_yes_bid > 0 and kalshi_yes_ask < 1
order by snapshot_at desc limit 40;
```

## 6. Fit script (reproduces §2)

```python
import json, math, urllib.request
from statistics import NormalDist
N = NormalDist()
d = json.load(urllib.request.urlopen('https://predictionmarketspicks.com/api/tools/bitcoin-edge'))
def fit(pairs):
    xs, ys = [], []
    for K, p in pairs:
        if p is None or p <= 0.02 or p >= 0.98: continue
        xs.append(math.log(K)); ys.append(N.inv_cdf(p))
    n = len(xs); mx = sum(xs)/n; my = sum(ys)/n
    b = sum((a-mx)*(c-my) for a, c in zip(xs, ys)) / sum((a-mx)**2 for a in xs)
    s = -1/b
    return math.exp((my - b*mx)*s), s
rows = [(e['strike'], e['model_prob'], (e['kalshi_yes_bid']+e['kalshi_yes_ask'])/2) for e in d['edges']]
mm, ms = fit([(K, mp) for K, mp, _ in rows])
km, ks = fit([(K, md) for K, _, md in rows])
print(f'market median {km:,.0f}  sigma {ks*100:.3f}%')
print(f'model  median {mm:,.0f}  sigma {ms*100:.3f}%')
print(f'shift ${mm-km:,.0f} = {(mm-km)/(km*ks):.2f} sigma   width ratio {ms/ks:.3f}')
```

Healthy output: shift within ±0.10σ, width ratio 0.95–1.05. Treat this as the acceptance
test for §4.1 and §4.2 — run it on three separate snapshots before declaring a fix.

---

## 7. Measured result after §4.1 (added 2026-08-13, same day)

`BTC_MU_SCALE` 0.4 → 0 in `thresholds.js` AND `commodities.js` (both carried the
value; changing only one would have left the config override winning silently).
Commit `49113ed`, Fly worker v145. Verified in the DB, not just in the diff:
`mu_used = 0.000000` across all 128 rows of the 18:57:10Z snapshot at
`mu_source = pyth_short_horizon_15m`.

> ⚠️ For ~5 min after a worker restart the Pyth buffer is cold, `shStats` is null,
> and `rowMuUsed` keeps its `muUsed` seed (`commodity-base.js:755`) — the 18:55Z
> snapshot read `-0.597` at `mu_source=realized_60d` and looked like a failed
> deploy. It is not. Always check `mu_source` before judging `mu_used`.

### §6 acceptance test, first post-change snapshot (KXBTCD-26AUG1316, 8 strikes)

| | median | σ to close |
|---|---|---|
| Market | 63,410 = spot **+$24** | 0.314% |
| Model | 63,385 = spot **+$0** | 0.516% |

**shift −0.12σ (was −0.49σ) · width ratio 1.642 (was 1.20)**

**The centre prediction was correct and is confirmed.** The model median now sits
*exactly* on spot (63,385 vs spot 63,385.92). The residual −0.12σ is no longer the
model sitting low — it is the *market* carrying a small premium over spot. The mu
term was ~70% of the old error and removing it removed ~75% of the displacement,
as §3 predicted.

**The second prediction was wrong.** §4.1 predicted edges would "stop being
one-directional across the ladder". They have not: this snapshot is still **75%
one-directional (6 of 8 negative)**. The cause is now unambiguous — §4.2's width
error, and it is materially bigger than the 1.20× this doc estimated. At **1.64×**
the model is putting far too much mass in the tails, which underprices deep-ITM
strikes and overprices OTM ones in exactly the lopsided pattern still on the board.

**So the tool is NOT fixed and the acceptance test does NOT pass.** §4.1 was
necessary, is verified, and should stay. §4.2 is now the whole remaining problem
and is the next piece of work — suspect the σ blend and the IBIT→BTC vol
translation, per §4.2.

**Owed:** the acceptance test is defined over THREE snapshots and only ONE has been
run. Re-run `§6` on two more windows before treating either number as settled — a
single mid-life fit on 8 strikes is suggestive, not conclusive.

## 8. §5 loose thread — resolved, NOT a bug

The §5 query found `resid_vs_v1` identically 0.0000 and `calibrated_prob` differing.
That is correct by construction, not a v1/v2 mislabel: **`edge_pp` is the frozen V1
column**, labelled as such in the writer — `commodity-base.js:1245`,
`edge_pp: edge ?? null, // V1 frozen for backtest A/B`. The edge that actually
drives decisions is `fused_edge_pp` on the next line. Re-run against that column and
it reconciles against `prob_physical` to ±0.005, as it should under `v2_physical`.

Baseline was trustworthy; §4.1 was safe to start. **Query `fused_edge_pp`, never
`edge_pp`, when asking what the engine decided.**

---

# §7. Post-deploy verification (2026-08-13, ~20:30 UTC) — why the board reads long-only-YES

Triggered by: "I feel like we are still long only yes sides." The instinct is correct.
The mu change is implemented correctly; it is not the thing driving what's on screen.

## 7.1 The mu-off change deployed and works

`mu_used = 0` on every row from the **18:59:44 UTC** snapshot onward; 17:59:45 still
carried `-12`. Deploy landed between 18:00 and 19:00 UTC. `49113ed` touches only the
lambda + comments in `commodities.js`/`thresholds.js` — no collateral change to the
strike band or gate. `4de804f` (gate reason codes) is committed and `main` is in sync
with `origin/main`. **Both changes are properly implemented.** Centre error fell
−0.49σ → −0.12σ as predicted.

## 7.2 But 99.98% of persisted history is the final seconds before close

| time to close | rows (30d) | avg abs edge | rows ≥20pp | max |
|---|---|---|---|---|
| **< 1 min** | **16,174** | 0.011 | 24 | **0.99** |
| 1–5 min | 0 | — | — | — |
| > 5 min | **3** | 0.010 | 0 | 0.01 |

Full multi-strike ladders (116–127 rows) are written **only** in the final minute.
Intraday snapshots persist **exactly one row each**, with `fused_edge_pp` NULL and no
liquid book — confirmed at 57, 50, 46, 37, 35, 32, 31, 27, 26, 23, 22, 16, 14, 13, 11
minutes to close, all `rows=1, liquid=0, fe_null=1`.

At T→10s the lognormal CDF collapses toward a step function while the market still
prices real uncertainty. That manufactures edges of a size no model should ever print:

| snapshot | strike | market bid/ask | model prob | reported edge |
|---|---|---|---|---|
| 08-13 15:59:50 | 63,400 | 0.45 / 0.55 | **0.0011** | **−54.9pp** |
| 08-03 13:59:49 | 63,300 | 0.07 / 0.08 | 0.7004 | **+62.5pp** |
| 07-31 13:59:46 | 63,200 | 0.08 / 0.10 | 0.5121 | +42.2pp |
| 07-27 19:59:50 | 64,900 | 0.82 / 0.83 | 0.1495 | −67.6pp |

A model claiming 0.1% while a two-sided market quotes 45/55 is not an edge, it is a
numerical artifact of T→0. **These are pure degeneracy, and they are what the backtest
sees.**

**This reframes the 7/27 decision.** `BITCOIN_V2_CUTOVER` concluded NO "hit ≤14% under
EVERY mu variant including v2 — there is no lambda that rescues it." That is exactly the
signature of a dataset dominated by T→0 rows: no drift parameter can rescue them because
drift is not what is wrong with them. The NO side went 1-for-15 because it was buying
step-function artifacts at the bell, not because the NO floor was too loose.

Note the 08-13 row above: `yesNet = 0.0011 − 0.55 = −0.55` (no YES), `noNet = 0.45 −
0.0011 = 0.449` — a **44.9pp** "BUY NO" that only `noSideEnabled: false` is suppressing.
**Re-enabling the NO side without fixing T→0 first would immediately resume the 1-for-15.**
This supersedes §4.3: the NO side is not merely "not ready", it is actively dangerous.

## 7.3 The actual cause of the long-only-YES appearance

Live board, 19:59:45 UTC: **94 rows, every one PASS, every one `edge_pp = +0.01`,
rationale "Edge 0.5pp below 5pp threshold".** Strikes run 54,100–67,000 against spot
63,338 — i.e. **−14.6% to +5.8%**, far outside the ±6% band that is supposed to apply.

Cause is `commodity-base.js:722`:

```js
const withinBand = Math.abs(m.floorStrike / spotPrice - 1) <= band;   // ±6%
const liveBook   = (m.yesBid ?? 0) > 0 && (m.yesAsk ?? 0) > 0;
return withinBand || liveBook;                                        // union
```

Every deep-ITM strike permanently carries a 0.99 / 1.00 quote, so `liveBook` is **always
true** for them and the `||` readmits every strike the band just excluded. The band is
effectively inert on the ITM wing. Each readmitted strike then shows model `1.0000` vs
market mid `0.995` = **+0.5pp, positive, on all ~90 of them**.

That is the long-only-YES wall — roughly ninety dead deep-ITM strikes each contributing
an identical small positive tilt. It is a **display/persistence defect, not a model
tilt**, and it is independent of both the mu fix and the 1.64× width error.

## 7.4 Revised priority

1. **Fix the band union** — require a *tradeable* book, not any book:
   `yesBid > 0.01 && yesAsk < 0.99 && (yesAsk - yesBid) <= someMaxSpread`, or simply
   `withinBand && liveBook` for the ITM wing. Smallest change, biggest visible effect:
   drops ~90 of 94 rows off the board and removes the false YES lean. **Do this first.**
2. **Stop treating the final-minute snapshot as signal.** Add a `min_seconds_to_close`
   guard (suggest 120s) below which the engine emits PASS and writes
   `quality_flag='near_expiry'`. Then re-run the NO-side study on T>2min data only —
   the existing 1-for-15 verdict is not trustworthy evidence about the NO side.
3. **Persist intraday ladders.** One row per intraday snapshot means there is no usable
   history at the horizons the tool actually trades. Every calibration study to date has
   been fit on the 10-second-to-close slice.
4. Width error 1.64× (§6 acceptance test) — still open, but now ranks behind the above.
5. `BTC_MU_SCALE = 0` — **done and verified**, leave it.

## 7.5 Verify commands

```sql
-- 1. band leak: strikes persisted outside ±6% of spot
select count(*) filter (where abs(strike/spot_price - 1) > 0.06) outside_band, count(*) total
from commodity_edge_signals where commodity='bitcoin'
  and snapshot_at=(select max(snapshot_at) from commodity_edge_signals where commodity='bitcoin');
-- expect outside_band = 0 after fix 1; was 90+/124 on 8/13

-- 2. near-expiry concentration
select count(*) filter (where extract(epoch from (event_close_at-snapshot_at)) < 60) under_1min,
       count(*) total
from commodity_edge_signals where commodity='bitcoin' and snapshot_at > now() - interval '7 days';
-- was 16174/16177 on 8/13
```


---

# §9. §7.4 #1 and #2 shipped (2026-09-09, Claude Code)

## 9.1 Both defects re-measured before touching anything

The §7.5 verify queries, run against the last 7 days of `commodity_edge_signals` on 2026-09-09:

| signal | measured | §7 said |
|---|---|---|
| rows outside ±6% of spot | **1,704 / 4,390 (39%)** | 90+/124 on the 8/13 board |
| rows inside 120s of close | **4,349 / 4,390 (99.1%)** | 16,174 / 16,177 (99.98%) over 30d |

Both defects were still live and neither had drifted away. The latest single snapshot read
11 rows / 0 outside band / 11 near-expiry, which is why a single-snapshot check is not the
test — the band leak only shows on the fuller ladders.

## 9.2 #1 — the band union now requires a tradeable book

`commodity-base.js` used `withinBand || (yesBid > 0 && yesAsk > 0)`. The second arm is
permanently true for deep-ITM strikes pinned at 0.99/1.00, so it readmitted every strike the
band had just excluded. The predicate is now `keepStrike()` in `thresholds.js` — pure and
exported, so the invariant has a test instead of living inside a 900-line snapshot function:

```js
export function keepStrike(market, spotPrice, band) {
  if (market?.floorStrike == null || !(spotPrice > 0)) return false;
  if (Math.abs(market.floorStrike / spotPrice - 1) <= band) return true;
  const bid = market.yesBid ?? 0;
  const ask = market.yesAsk ?? 0;
  return bid >= BTC_WING_MIN_BID && ask <= BTC_WING_MAX_ASK && ask - bid <= BTC_WING_MAX_SPREAD;
}
```

`BTC_WING_MIN_BID = 0.01`, `BTC_WING_MAX_ASK = 0.99`, `BTC_WING_MAX_SPREAD = 0.15`. The wing
arm still does what Benny asked for on 2026-06-10 — cascade-hour strikes traders are actively
quoting beyond ±6% survive — it just no longer counts a permanently-pinned quote as activity.

## 9.3 #2 — near-expiry guard at 120s

`BTC_MIN_SECONDS_TO_CLOSE = 120`, wired bitcoin-only as `config.minSecondsToClose`. Seconds to
close is computed once per snapshot (T is constant across an event's strikes); inside the
window every row takes `quality_flag='near_expiry'`, which is added to `HARD_SUPPRESS_FLAGS`
so it forces PASS even for a consumer that doesn't filter on `quality_flag`.

**Rows still persist.** They are the only intraday history that exists (§7.4 #3 is still open),
so deleting them would destroy the record rather than fix it. They are flagged, suppressed, and
must be excluded from every future calibration study — which is the real point, since §7.2
established that every calibration fit to date was unknowingly fit on this slice.

## 9.4 Tests

`test/engine.btc-strike-band.test.js`, 9 cases — the pinned 0.99/1.00 deep-ITM regression, its
dead-OTM mirror, a genuine crossable wing quote, an uncrossable spread, both bid/ask rails, the
band edges, and degenerate inputs. Full suite: **43 files / 579 tests pass**.

## 9.5 Not done — and it is the whole remaining problem

- **§4.2 / §7.4 #4 — the 1.64× width error.** Untouched. The model still puts far too much mass
  in the tails, and the §6 acceptance test still does not pass. This is now the binding error.
- **§7.4 #3 — persist intraday ladders.** Untouched. One row per intraday snapshot means there
  is still no usable history at the horizons the tool actually trades.
- **§4.3 — the NO side stays off.** §7.2 is unchanged by this work: re-enabling before the width
  error is fixed would resume the 1-for-15.
- ⚠️ **Not deployed.** `pmp-ingestion` has no auto-deploy; this needs `fly deploy --remote-only`.
- ⚠️ **The §6 three-snapshot acceptance test has NOT been re-run** against these changes. What is
  verified here is the predicate (unit tests) and that both defects were live at the measured
  rates above — not that the board's shape improved. Re-run §6 after deploy.
