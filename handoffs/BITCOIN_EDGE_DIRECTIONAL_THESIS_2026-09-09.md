# Bitcoin Edge — the engine cannot express the product's thesis, and throws away the data that would

**Status**: Assessment. Nothing built. Needs Benny's call on scope before any code.
**Date**: 2026-09-09
**Origin**: Benny, on being asked whether "the model reproduces the market's distribution" is the
intended end state: *"the idea is to predict the path… call buying at higher strikes, or down if
put increase, momentum, everything. The idea is to help people be on the right side of the trade
when it's underpriced in either direction."*
**Related**: `BITCOIN_EDGE_MU_CAP_SATURATION_2026-08-13.md` §4.1 (drift zeroed), §11 (width
re-measured)

---

## 1. The gap, in one line

**The product thesis is directional. The engine has no directional term.** It prices a
distribution centred on spot and looks for local disagreement. Asking it to "predict the path" is
asking for something it structurally cannot say.

## 2. Verified state (2026-09-09)

| | |
|---|---|
| `BTC_MU_SCALE` | **0** (`thresholds.js:87`) |
| `commodities.bitcoin.shortHorizonMuScale` | **0** (`commodities.js:363`) |
| Skew / risk-reversal term anywhere in the engine | **none** — `grep -rn "skew" src/engine/` returns only an unrelated leg-skew timing comment |
| Measured median centre shift vs market, 294 ladders | **−0.026σ** (§11) |

The drift term exists and is multiplied by zero. The measured consequence is exactly what the
code says: our median sits on the market's median, always, by construction. **We never say "it
goes up."**

## 3. We already ingest everything the thesis needs, and discard all of it

The options chain (`src/feeds/massive.js:142-143`, Databento/Massive OPRA) carries, per contract:

```
{ strike, contractType: 'call' | 'put', iv, openInterest, volume24h }
```

That is, literally, "call buying at higher strikes" and "put increase." What we do with it:

1. **Collapse it to one IV per strike** for the smile (`smile.ivAt`).
2. **Compute net dealer gamma** — which is *directionless* by construction: calls and puts enter
   with opposite signs and it answers "does dealer hedging amplify or dampen moves," never "which
   way." Persisted to `commodity_gamma_snapshots`, upserted on `(commodity, snapshot_date)` —
   **one row per day**.
3. **Use volume/OI as quality filters only** (`OPTION_QUALITY_MIN_VOLUME`, `..._MIN_OI`) — to
   decide whether a quote is trustworthy, never to read direction.

Then it is thrown away. Every 15 seconds.

**There is no options-chain history table.** Nothing that could answer "is call OI building above
spot today" is retained anywhere.

## 4. Why §4.1 zeroing the drift was right, and why it still left a hole

§3 of the mu-cap doc is correct: a 15-minute momentum estimate annualised to ±12/yr saturated its
own cap on 57–99% of rows and flipped sign daily. That is noise with a sign, and zeroing it fixed
a real bug.

But **the parameterisation was the bug, not the ambition.** Expressing a 15-minute directional
read as an *annualised drift* and then multiplying by T is close to the worst possible encoding:
it takes the noisiest available estimate and scales it by a large constant before it touches the
median. Zeroing the scale fixed the symptom and left the product with no view at all.

A directional signal for a one-hour contract should not be an annualised drift. It should be a
**bounded shift of the median expressed in σ-to-close units** — the same unit §6's acceptance test
already measures. That makes the size of the opinion directly comparable to the thing it must not
exceed, and caps blow-ups structurally rather than by clamping an annualised number.

## 5. What would actually have to be built

In dependency order. Nothing after step 1 is worth starting before step 1 has run for a while.

1. **Capture the chain.** Append-only `options_chain_snapshots`: `(commodity, snapshot_at,
   expiry, strike, contract_type, iv, open_interest, volume_24h, underlying_price)`, TTL like the
   other intraday tables. Cheap, additive, changes no engine decision. **This is the only
   time-sensitive item**: every day it is not running is a day of flow history we do not have.
   (Databento sells historical OPRA, so it is recoverable — but at a cost, versus free going
   forward.)
2. **Derive the candidate signals** off that table, offline, as columns — not yet wired to
   anything: put/call volume imbalance above vs below spot; ΔOI by side and moneyness (note: **OI
   is end-of-day, so intraday flow lives in `volume_24h`, not OI** — this trips people up);
   risk reversal (put IV − call IV at equidistant moneyness); the existing Pyth short-horizon
   momentum, unzeroed but unscaled.
3. **Test each against realised outcomes** using `commodity_edge_intraday` (§10.3 — it already
   has 57k rows across all horizons) joined to settlement. The bar is not accuracy: it is whether
   a signal moves the median in the direction that pays, at horizons we actually trade.
4. **Only then** wire the survivors as a bounded median shift (§4), re-run
   `scripts/measure-btc-width.js`, and require the shift to stay inside a hard cap.

## 6. What this does NOT change

- The band fix and near-expiry guard (mu-cap §9) stand — degenerate T→0 rows are bad under any
  thesis.
- The width work (§11) stands, and is *helpful* here: ratio 1.002 means the distribution's shape
  is right, so a directional shift added on top lands cleanly instead of compounding a width
  error.
- **Do not un-zero `BTC_MU_SCALE` as a shortcut.** That restores the exact estimator §3 of the
  mu-cap doc proved is noise. The scale being 0 is not the problem; the absence of a *better*
  signal is.

## 7. Open question for Benny

Step 1 is small, additive and reversible, and its value decays with every day it is not running.
Steps 2–4 are a research project of real size with no guaranteed payoff — flow-based direction
prediction on a one-hour contract is a hard problem, and the honest prior is that most of the
candidate signals in step 2 will not survive step 3.

**Worth starting step 1 now regardless of whether 2–4 get commissioned?** That is the decision.
