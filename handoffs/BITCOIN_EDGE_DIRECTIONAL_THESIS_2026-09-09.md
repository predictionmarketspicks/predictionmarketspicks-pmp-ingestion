# Bitcoin Edge — the engine cannot express the product's thesis, and throws away the data that would

**Status**: §5 step 1 (chain capture) SHIPPED 2026-09-09 — see §8. **It proved open interest is NOT flowing and that dealer gamma has been silently dead since the Databento cutover (§9). Volume IS flowing — an early read said otherwise and was wrong; see §9.4.** Three of the four candidate signals are live; only ΔOI is blocked.
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

**Worth starting step 1 now regardless of whether 2–4 get commissioned?** Benny said yes; shipped, see §8. Steps 2–4 remain an open decision.

---

## 8. Step 1 shipped (2026-09-09)

**Table** `options_chain_snapshots` — live, RLS enabled, **zero policies** (verified:
`relrowsecurity = true`, `policies = 0`). Migration mirrored at
`prediction-marketspicks/supabase/migrations/20260909120000_options_chain_snapshots.sql`.
Columns: `commodity, underlying, snapshot_at, underlying_price, expiry, strike, contract_type,
iv, delta, open_interest, volume_24h`. **Bid/ask/mid are deliberately absent** — the most
sensitive fields in the feed, and no directional signal needs them.

**Containment** — `options_chain_snapshots` added to `EXT_TABLE_PATTERNS` in
`lib/lint-strings.js`, so naming it anywhere under `app/`, `components/`, `lib/` or `content/`
hard-fails the site build. **Verified the gate actually fires**: a probe file naming the table
produced `lint:source-mask FAILED 1 hit [internal options-chain capture table]`, and the linter
returned to green once removed. A containment rule that does not trip is worthless.

**Writer** `insertOptionsChainSnapshot()` in `src/delivery/supabase.js`, called from the snapshot
loop in `src/index.js`, throttled to one capture per commodity per 5 minutes
(`CHAIN_CAPTURE_INTERVAL_MS`) — the same resolution as `commodity_edge_intraday`, which is what
any join between the two will want. Passive: changes no decision, read by nothing, wrapped in
try/catch, and the writer logs rather than throws.

**End-to-end verified against the live table**, not just unit-tested — the writer swallows errors,
so a wrong `onConflict` would have failed *silently*:

```
writer result:      {"ok":true,"count":2}   # 3 contracts in, zero-strike one dropped
idempotency re-run: {"ok":true,"count":0}   # duplicate ignored
cleanup_options_chain_snapshots() -> 2      # TTL works, probe rows removed
```

Probe rows were dated 2020-01-01 precisely so the 30-day TTL would reclaim them; it did, and the
table is now empty and clean.

**TTL** `cleanup_options_chain_snapshots()`, 30-day whole-day boundary, scheduled as pg_cron
**jobid 172** `options-chain-snapshots-cleanup` at `40 5 * * *` (verified active).

Tests: `test/delivery.options-chain-capture.test.js`, 5 cases (both sides kept at the same strike
— the pair IS the signal; nulls passed through rather than written as 0, since a missing OI is
unknown, not "nobody holds it"; bid/ask never carried). Full suite 44 files / 584 tests pass.

### Two limits to know before building on this

1. ⚠️ **The captured chain is already filtered.** The provider applies a delta filter of
   0.15–0.85 plus quality filters *before* the engine ever sees it (`src/feeds/massive.js`), so
   **the far-OTM wings — where directional call buying typically shows up first — are truncated.**
   Capturing what we already hold costs nothing; widening the fetch is a separate vendor-cost
   decision, and step 2 should decide it early rather than discover it late.
2. ⚠️ **Nothing is captured until the engine runs.** Bitcoin only writes 13:00–19:00 UTC (the
   IBIT chain needs US equity hours), so the first real rows land on the next market open after
   deploy. An empty table before then is expected, not a failure.


---

## 9. Day-one finding: OI and volume are not in the feed (2026-09-09, first live captures)

The capture went live at the 13:30 UTC market open and worked mechanically — 4 snapshots across
bitcoin/silver/gold/oil, calls and puts paired at the same strikes, `iv` and `delta` populated on
62 of 62 rows. **`open_interest` and `volume_24h` are NULL on every row of every snapshot.**

```
snapshot_at                      rows  with_vol  with_oi
2026-09-09 13:34:25.381+00        62      0        0
2026-09-09 13:39:12.705+00        76      0        0
2026-09-09 13:39:13.453+00        89      0        0
2026-09-09 13:39:13.478+00       349      0        0
```

Not cold-start — it is systematic, across all four commodities, and it is **documented in our own
code** at `src/feeds/databento.js:171`:

> *"Volume is the sidecar's 24h rolling sum; **OI is null in Phase 1 (OPRA OI lives on the daily
> statistics schema — wire in Phase 2)**."*

The live provider is Databento (`OPTIONS_PROVIDER` defaults to `databento`; `databento_ibit` is the
connected feed). Phase 2 was never wired. Massive — the other provider behind the same switch —
*does* carry `open_interest` and `day.volume` (`src/feeds/massive.js:142-143`).

### 9.1 This also means dealer gamma has been dead, quietly, for months

`computeDealerGamma` skips any contract with `openInterest == null || <= 0`, so with OI null it
contributes nothing and returns `netDealerGamma = 0`, `gammaEnvironment = 'NEUTRAL'`. Measured
across `commodity_gamma_snapshots`:

| commodity | days | days with non-zero gamma |
|---|---|---|
| bitcoin | 78 | **3** |
| gold | 85 | 16 |
| oil | 86 | 18 |
| silver | 86 | 17 |

Bitcoin's gamma signal has been inert on 96% of days. The non-zero days are the pre-cutover Massive
window. **This is a live bug independent of the directional work** — a signal that silently stopped
producing information and has been feeding a constant NEUTRAL into the engine ever since.

### 9.2 What survives, and what does not

Revising §5 step 2 against what is actually in the feed:

| candidate signal | needs | status |
|---|---|---|
| put/call **volume** imbalance above vs below spot | `volume_24h` | ⛔ **blocked** |
| **ΔOI** by side and moneyness | `open_interest` | ⛔ **blocked** |
| **risk reversal** (put IV − call IV at equidistant delta) | `iv` + `delta` per side | ✅ **available now** — verified: calls and puts pair at the same strike with both fields |
| Pyth short-horizon momentum | already computed | ✅ available (currently multiplied by zero) |

So the thesis is not dead — the skew leg is arguably the cleanest single directional read an
options chain offers, and it is computable from what we are already capturing as of today. But the
two *flow* signals Benny described most directly — "call buying at higher strikes", "put increase"
— are exactly the two that are blocked.

### 9.3 The decision

1. **Wire Databento's daily statistics schema for OI** — the documented Phase 2. Fixes dealer gamma
   as a side effect. OI is end-of-day, so it gives ΔOI as a daily signal, not intraday.
2. **Or flip `OPTIONS_PROVIDER=massive`**, which carries both fields today — but the cutover to
   Databento was presumably deliberate and its rationale is not recorded here. Do not flip it
   without finding out why it moved.
3. **Intraday volume needs its own answer either way.** The Databento comment claims the sidecar
   supplies a 24h rolling sum; it is arriving null. That is worth one probe of the sidecar's
   `/chain/<underlying>` payload before assuming a schema change is required.

⚠️ **Do not start §5 step 2 on the blocked signals.** Building put/call imbalance against columns
that are structurally null produces a signal that is all nulls and looks like "no edge" rather than
"no data" — the same silent-failure shape as the gamma bug above.


---

## 9.4 CORRECTION — volume IS flowing; the first read was a cold sidecar (2026-09-09, same day)

§9 above concluded that both `open_interest` AND `volume_24h` were absent, on the strength of the
first four captures. **The volume half of that was wrong, and the error was mine: I generalised
from two snapshots taken four minutes after the market open.**

Probing the sidecar directly at 15:51 UTC:

```
/chain/IBIT  →  2634 contracts | volume_24h not-null 2634 | volume_24h >0 177 | open_interest not-null 0
                sum volume_24h 24,524
```

And running the engine's own `normalizeAndSolve` + delta filter over that payload gives 60
survivors: **54 with volume > 0, 6 with volume 0, ZERO null**. The captures bear it out — every
snapshot from 13:49 onward is 100% non-null and 100% > 0 on volume, all four commodities:

```
snapshot_at                 commodity  rows  with_vol  vol>0  with_oi
2026-09-09 15:55:10.882+00  bitcoin      25     25       25      0
2026-09-09 15:55:01.524+00  silver       35     35       35      0
2026-09-09 15:54:52.168+00  gold         25     25       25      0
2026-09-09 15:54:51.762+00  oil          30     30       30      0
```

**Cause of the false read:** the sidecar's `volume_24h` is a rolling 24h sum that is not
initialised in the first minutes after the open, so it returns `null` there. `passesQualityFilters`
uses null-passthrough by design (`if (c.volume24h != null && ...)`) precisely so a cold start
doesn't empty the chain — so those contracts survive the filter carrying a null volume, and the
13:34 and 13:39 captures recorded exactly that. **This is a real, if minor, data-quality wrinkle
worth knowing: early-session captures carry null volume and must be excluded from any flow study.**

The writer was separately proven correct end-to-end on-box — fed two live contracts carrying
`volume24h` 16 and 11, it stored 16 and 11.

### 9.5 Revised signal availability — this supersedes the table in §9.2

| candidate signal | needs | status |
|---|---|---|
| put/call **volume** imbalance above vs below spot | `volume_24h` | ✅ **available** (excluding the first ~15 min of the session) |
| **risk reversal** (put IV − call IV at equidistant delta) | `iv` + `delta` | ✅ available |
| Pyth short-horizon momentum | already computed | ✅ available (currently multiplied by zero) |
| **ΔOI** by side and moneyness | `open_interest` | ⛔ **blocked** — Phase 2, and EOD-only even once wired |

**Three of four are live.** The one blocked signal is also the weakest for an intraday product,
since OI only updates end-of-day. So the practical answer to §9.3 is: **do not flip the provider
and do not rush Phase 2 for the directional work** — build on volume, skew and momentum first, and
wire OI later on its own merits.

⚠️ **The gamma finding in §9.1 stands and is unaffected.** OI really is absent, so
`computeDealerGamma` really has been returning a constant NEUTRAL — bitcoin non-zero on 3 of 78
days. That is still a live bug worth fixing on its own, independent of any of this.
