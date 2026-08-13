# Bitcoin Edge — the drift cap IS the model: mu pinned at ±12/yr displaces the whole CDF

**Status**: Spec — diagnosis complete and evidenced, no code written
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
