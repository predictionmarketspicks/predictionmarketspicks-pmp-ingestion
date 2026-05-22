# Commodity Edge — Oil USO-Synthetic Rollback + Bitcoin TWAP Guard

**Date**: 2026-05-22
**Severity**: P0 — both bugs are actively producing fake actionable signals on production tool pages and Discord alerts
**Status**: Partial work applied to local working copy (NOT pushed). Handoff to Claude Code to validate, finish tests, commit, push.

---

## TL;DR for the next agent

Two independent bugs in the commodity edge engine surfaced today:

1. **Oil Edge** is producing a synthetic WTI spot of ~$111.62 when real WTI is ~$98 (per Kalshi market pricing). Every "BUY YES" at strikes $88–99 with HIGH/STRONG confidence today is false. Root cause: commit `79c6410` (shipped 06:27 ET today) made the engine multiply Databento's parity-derived USO `underlyingPrice` (~$142, systemically wrong by ~1.8× since well before today) by a `wti_per_uso` ratio anchored to FRED. The bad USO number only mattered for IV-smile *relative* moneyness before today; the new synthetic path treats it as truth.

2. **Bitcoin Edge** fires 100% of its actionable signals in the final 1.6 minutes before each KXBTCD hourly TWAP settle. At t-30s, the BS prob collapses to 0.00 or 1.00 (T→0 + IV-implied 60s std-dev ≈ $5 on a $76k spot) while real BTC routinely moves $200-500 in the final minute. Several "in the money" STRONG positions lost to last-minute moves that the 60s TWAP absorbed.

Two patches already applied to the working copy. One more file edit + tests + commits + push remain.

---

## What's already done (verify before continuing)

### Patch 1 — Oil: disable USO-synthetic spot, fall back to Yahoo CL=F path that was working yesterday

File: `src/engine/commodities.js`

`commodities.oil.useUsoSynthetic` flipped from `true` to `false`. `spotLabel` updated to reflect the active path. Long comment block explains the why and warns against re-enabling until `deriveEtfSpotByParity` in `feeds/databento.js` returns a USO underlying price that matches reality (~$77, not ~$142).

Effect: oil engine drops through the existing fallback ladder — SECONDARY (contract-aware Yahoo, CLM26.NYM) → TERTIARY (Yahoo CL=F continuous). Both paths were running cleanly through 2026-05-21 with sensible 0.5–2.5pp edges. No other files need to change for this rollback.

Verify with: `git diff src/engine/commodities.js` — should show only the oil block changed.

### Patch 2 — Bitcoin: TWAP settlement-window guard

Files: `src/engine/commodities.js` + `src/engine/commodity-base.js`

**`commodities.js`** — added `minMinutesToClose: 15` (widened from 5 → 15 same session after a live t-7.4min sighting on KXBTCD-26MAY2216 produced engine "BUY NO STRONG -92pp" while BTC was rising and Kalshi correctly priced the strike YES at 94c) to the bitcoin config with a long comment explaining the TWAP-window collapse pattern.

**`commodity-base.js`** — added a guard block immediately after the `let direction = 'PASS'; let confidence = 'skip'; let rationale = null;` initialization inside the per-market loop in `computeSnapshot`. When `config.minMinutesToClose != null` and `minutesToClose < config.minMinutesToClose`, the row is pushed with `direction='PASS' confidence='skip' fused_confidence='NO_EDGE' quality_flag='twap_settle_window'` and the loop `continue`s — bypassing all the edge/confidence/tier math below.

The pushed row carries every column the downstream writer expects (including the V2 physical-measure parallel-write columns, quote_age_seconds, mu_*/sigma_* fields, etc.) so the supabase writer doesn't NOT-NULL-explode. Site readers already filter `quality_flag IS NULL`, so these rows exist in the table for audit but never reach the public surface or Discord routing (the existing `actionable` filter on `direction in ('BUY YES','BUY NO')` also drops them).

Verify with: `git diff src/engine/commodity-base.js` — search for `TWAP settlement-window guard 2026-05-22` and confirm the inserted block is intact, no syntax errors, and the existing chain (`if (chosenEdge == null) { ... } else if (...) { ... } else { ... }`) is untouched after the new block.

---

## What still needs to happen (your job)

### 1. Sanity-check the diffs

```bash
cd /Users/benny/pmp-ingestion
git diff src/engine/commodities.js src/engine/commodity-base.js
```

Look for:
- `useUsoSynthetic: false` (was `true`) in the oil block
- `minMinutesToClose: 15` (widened from 5 → 15 same session after a live t-7.4min sighting on KXBTCD-26MAY2216 produced engine "BUY NO STRONG -92pp" while BTC was rising and Kalshi correctly priced the strike YES at 94c) added to the bitcoin block
- A new guard block in `commodity-base.js` right after the per-market `let direction = 'PASS' ...` initialization, BEFORE the existing `if (chosenEdge == null)` branch
- No accidental edits anywhere else

### Live evidence at t-7.4min that forced the widening (KXBTCD-26MAY2216, observed 19:52 UTC)

BTC spot $75,695 and rising. Engine flagged:

| Strike | Above spot | Kalshi YES | Model prob | Engine direction | Edge |
|---|---|---|---|---|---|
| $75,700 | +$5 | 0.98 | 0.48 | BUY NO STRONG | -51pp |
| $75,900 | +$205 | 0.94 | 0.01 | BUY NO STRONG | -92pp |
| $76,100 | +$405 | 0.67 | 0.00 | BUY NO STRONG | -66pp |
| $76,200 | +$505 | 0.45 | 0.00 | BUY NO STRONG | -44pp |
| $76,400 | +$705 | 0.09 | 0.00 | BUY NO MODERATE | -8pp |

Kalshi (i.e. the market reading the uptrend) pricing $75,900 YES at 94c. Engine wanted to fade the entire move. The 5-minute guard would not have caught this. 15-min does.

### 2. Write unit tests for both guards

Tests live in `test/` (vitest, ESM). Create `test/twap-window-guard.test.js` covering:

| Test | Setup | Expected |
|---|---|---|
| `bitcoin row at t-2min suppressed` | mock event with `closeTime = now + 2min`, bitcoin config, a market with chosenEdge of 0.20 | row in result has `direction='PASS'`, `confidence='skip'`, `quality_flag='twap_settle_window'` |
| `bitcoin row at t-10min unaffected` | same but `closeTime = now + 10min` | row goes through the normal edge math; quality_flag is null or another value |
| `silver row at t-2min unaffected` | silver config (no `minMinutesToClose`), `closeTime = now + 2min` | row goes through normal edge math; no `twap_settle_window` flag |
| `oil USO-synthetic disabled` | call `computeSnapshot(COMMODITIES.oil, ...)` with mocked chain + spot fallback | `spot.source` is one of `yahoo_clm26_nym` / `yahoo_cl_f` / `yahoo_*` — never `uso_synthetic_v1` |

Use the existing test-seam `__test__` exports from `commodity-base.js`. If you need to mock `synthesizeWtiSpot` or `getOilSpot`, vitest's `vi.mock` against `../src/feeds/uso-synthetic.js` and `../src/feeds/yahoo-oil.js` is the pattern used elsewhere in the suite.

### 3. Patch 3 — Strip the schema-vs-code lie on `/tools/oil-edge`

File: `/Users/benny/prediction-marketspicks/app/tools/oil-edge/page.tsx`

The `faqSchema` "Where do the options-implied probabilities come from?" answer claims:

> "The engine applies a roll-cost drag of 0.985 to USO's reported price before computing the K_etf / K_spot ratio used for IV lookup, so the smile is queried at the right moneyness."

`grep -rE "0\.985|roll[_-]?cost|rollCost|rollDrag" /Users/benny/pmp-ingestion` returns zero matches. The 0.985 multiplier does not exist in the engine code. The schema is asserting a methodology we don't actually use, which is a small but real compliance/SEO honesty issue.

Two options — pick the safer one:

**Option A (recommended for now)**: delete the sentence from the FAQ answer. Replace with: "The engine reads the live USO mid from the options chain and uses it directly in the K_etf = K_spot × (USO / WTI) scaling for IV smile lookup. No additional roll-cost adjustment is currently applied; USO's natural contango drag is small relative to the 5pp round-trip cost gate."

**Option B (only if you have time)**: actually implement the 0.985 drag in `commodity-base.js` where `ratio = etfPrice / spotPrice` is computed. Apply as `ratio = (etfPrice * 0.985) / spotPrice`. Add a vitest case asserting the multiplier is applied. Update the FAQ answer to reference the *current* code.

Go with A. Don't ship engine math changes on a P0 cleanup night.

### 4. Validation before committing

```bash
cd /Users/benny/pmp-ingestion
npm test                           # vitest run — should pass all existing + new tests
npm run lint:no-axios              # safety check from CLAUDE.md
```

The full vitest suite was passing on the parent commit (`79c6410` claimed "All 293 tests pass"). Anything red now is on these changes — fix before pushing.

### 5. Commit + push

Single commit is fine — both fixes are tied to the same P0:

```bash
cd /Users/benny/pmp-ingestion
git add src/engine/commodities.js src/engine/commodity-base.js test/twap-window-guard.test.js handoffs/COMMODITY_EDGE_OIL_BITCOIN_FIX_2026-05-22.md
git commit -m "fix(commodity-edge): rollback oil USO-synthetic + add bitcoin TWAP-window guard

Oil: useUsoSynthetic flipped to false. The Databento parity-derived USO
underlyingPrice has been reporting ~\$142 (real USO ~\$77) for days — the
new synthetic path that shipped this morning treated it as truth and
multiplied by wti_per_uso, producing fake +20-50pp BUY YES signals across
in-money WTI strikes. Engine falls through to the existing contract-aware
Yahoo (CLM26.NYM) + CL=F continuous fallbacks that ran cleanly yesterday.

Bitcoin: new config.minMinutesToClose knob (set to 5 for bitcoin only).
When inside the TWAP settlement window the row is forced to PASS/skip
with quality_flag='twap_settle_window' regardless of apparent edge.
Today 100% of actionable bitcoin signals fired in the final 1.6 minutes
because BS prob with T→0 collapses to 0.00/1.00 while CF Benchmarks
BRTI moves \$200-500 in 60s — directly responsible for the late-runner
losses Benny flagged.

Tests: test/twap-window-guard.test.js covers both guards.
Handoff: handoffs/COMMODITY_EDGE_OIL_BITCOIN_FIX_2026-05-22.md"
git push origin main
```

Fly engine auto-deploys on push to main. Vercel auto-deploys the Next app on push too (separate trigger — only matters if you took Patch 3, i.e. edited `app/tools/oil-edge/page.tsx`).

### 6. Post-deploy verification (3-5 minutes after push)

```bash
# Confirm oil rows no longer use uso_synthetic_v1
curl -s "https://svxqipncfupabpvxtlro.supabase.co/rest/v1/commodity_edge_signals?commodity=eq.oil&order=snapshot_at.desc&limit=5&select=snapshot_at,spot_price,spot_source,direction,confidence" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" | jq .

# Should show spot_source = yahoo_clm26_nym OR yahoo_cl_f, spot_price ~$98, no STRONG signals at $88-99 strikes.

# Confirm bitcoin TWAP-window rows are now being suppressed
curl -s "https://svxqipncfupabpvxtlro.supabase.co/rest/v1/commodity_edge_signals?commodity=eq.bitcoin&order=snapshot_at.desc&limit=20&select=snapshot_at,event_close_at,strike,direction,confidence,quality_flag" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" | jq '[.[] | select((.event_close_at | fromdateiso8601) - (.snapshot_at | fromdateiso8601) < 300)]'

# Any row inside 5min of close should have quality_flag = 'twap_settle_window', direction = PASS, confidence = skip.
```

If either check shows the bug persisting, **revert immediately**: `git revert HEAD && git push origin main`. The previous state is bad but not novel-bad; rollback is safe.

---

## Diagnostic evidence (for your reference, not for the commit)

### Oil — what production looked like before/after USO-synthetic shipped

| Field | 2026-05-21 evening (Yahoo CL=F) | 2026-05-22 today (USO-synthetic) | Real (per Kalshi market) |
|---|---|---|---|
| `spot_price` | $97.29 | $111.62 | ~$98 |
| `spot_source` | `yahoo_cl_f` | `uso_synthetic_v1` | — |
| `underlying_price` (USO) | $142.63 | $141.74 | (also wrong but didn't matter on the old path) |
| Top actionable edge | -4pp PASS / SPECULATIVE | **+54pp BUY YES STRONG** at $98.99 | bogus |

Kalshi's own KXWTI-26MAY2614 book was pricing the $97.99 strike YES at 45c — the *market* knows WTI is right around $98. The engine claims 90%+ above $97.99 because synthetic spot is $111.62.

### Bitcoin — actionable signal timing today (6 events)

| Event close | Total snapshots | Actionable | First signal | Last signal | % in final 3min |
|---|---|---|---|---|---|
| 10:00 ET | 179 | 2 | t-1.6min | t-0.6min | 100% |
| 11:00 ET | 188 | 7 | t-0.9min | t-0.9min | 100% |
| 12:00 ET | 188 | 6 | t-0.3min | t-0.3min | 100% |
| 13:00 ET | 188 | 1 | t-0.2min | t-0.2min | 100% |
| 14:00 ET | 188 | 5 | t-0.3min | t-0.3min | 100% |
| 15:00 ET | 69 (active) | 0 | — | — | — |

Sample row from the 11:00 close, t-0.93min, spot $76,692:
- $76,500 strike → model 1.00 → "BUY YES STRONG +15pp"
- $76,700 strike → model 0.39 → "BUY NO STRONG -32pp"
- $76,800 strike → model 0.00 → "BUY NO STRONG -51pp"
- $77,000 strike → model 0.00 → "BUY NO STRONG -17pp"

Three opposite-direction STRONG signals across a $300 strike range, with 56 seconds left until a 60s-TWAP settle. BS prob with T = 0.93/60/24/365 ≈ 1.77e-6 years and IV ≈ 50% implies BTC can only move ±$5 in the remaining minute. Empirically BTC moves $200-500 in the final minute regularly.

---

## What I deliberately did NOT touch

- **Databento `deriveEtfSpotByParity`** — the root-cause USO price-derivation in `src/feeds/databento.js`. Fixing it is the proper long-term resolution but it's a separate investigation (could be stale option quotes feeding parity, wrong-unit bid/ask, contract-type swap on one leg, or a USO event we missed). Don't bundle into this hotfix.
- **V2 physical-measure cutover** (`1e3e474`, shipped yesterday). Silver and gold both look healthy on V2 today. Leave it alone.
- **Discord post log audit / 14-day backtest** of late-minute bitcoin signals. Worth doing once the bleeding is stopped but not a hotfix step.
- **Migrating bitcoin to a TWAP-aware probability model** (realized-vol-aware, simulate TWAP outcome distribution instead of point-in-time BS). The 5-minute guard is the conservative band-aid; the proper model is a follow-on.

---

## Files in scope

| File | Status | Action |
|---|---|---|
| `src/engine/commodities.js` | Edited | Verify diff, run tests, commit |
| `src/engine/commodity-base.js` | Edited | Verify diff, run tests, commit |
| `test/twap-window-guard.test.js` | NOT created | Write per Section 2 above |
| `/Users/benny/prediction-marketspicks/app/tools/oil-edge/page.tsx` | NOT edited | Patch 3 (Option A): delete the 0.985 sentence |
| `handoffs/COMMODITY_EDGE_OIL_BITCOIN_FIX_2026-05-22.md` | Created (this file) | Include in commit |
