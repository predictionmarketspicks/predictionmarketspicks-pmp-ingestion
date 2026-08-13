# Bitcoin Edge — Suppressed NO rows published a false "below the floor" claim

**Status**: Code applied in working tree, unit-verified, NOT committed / NOT deployed — see §5
**Date**: 2026-08-13
**Files**: `src/engine/commodity-base.js`, `test/engine.commodity-base.no-side-gate.test.js`
**Related**: `BITCOIN_EDGE_NO_SIDE_FIX_2026-06-16.md` (introduced the gate), `BITCOIN_V2_CUTOVER_2026-07-27.md` (set `noSideEnabled: false`)
**Companion**: `BITCOIN_EDGE_MU_CAP_SATURATION_2026-08-13.md` — the reason those rows exist at all

---

## 1. What was wrong

`postSpreadSideGate` ANDed the kill switch into the floor test:

```js
if (noNet != null && noNet >= minEdgeNo && noSideEnabled) { ... }
return { pass: false, ... };   // no reason — caller cannot tell the two apart
```

So "failed the 10pp net NO floor" and "NO side is switched off" collapsed into the
same `pass: false`. The rationale builder (`commodity-base.js` ~L1002) then *guessed*
the first, and printed the floor sentence unconditionally:

> NO underpriced by 17.4pp gross, but only 16.9pp after the NO ask-side spread
> (BUY NO disabled) — below the 10pp net NO floor. Not actionable.

16.9 is not below 10. The `(BUY NO disabled)` parenthetical held the true reason but
sat subordinate to a clause that contradicted it.

**Live blast radius, 2026-08-13 16:08 UTC snapshot** (`KXBTCD-26AUG1313`): 12 of 12
strikes PASS, 8 of them NO-side rejections, **4 of those 8 asserted a floor failure on
a row that beat the floor** — nets of 12.3pp, 15.5pp, 16.9pp and 13.3pp against a 10pp
floor. Public page, public JSON API, `X-Attribution` header pointing at us.

Verify the class of bug is gone:
`curl -s https://predictionmarketspicks.com/api/tools/bitcoin-edge | python3 -c "import json,sys; [print(e['strike'], e['rationale']) for e in json.load(sys.stdin)['edges'] if 'net NO floor' in (e['rationale'] or '')]"`
→ every line printed must have a net figure genuinely under 10pp.

## 2. Second-order problem, same lines

The card's largest, boldest number was "NO underpriced by 17.4pp" — a tradeable-looking
figure on a side whose own record is 1-for-15 live since 7/21 and ≤14% in replay under
every mu variant (`BITCOIN_V2_CUTOVER_2026-07-27.md`). A reader who trusts the headline
and skims the disclaimer takes a side we decline to take. That is a bigger exposure than
the wording bug, and it is fixed in the same edit by not leading with the gross edge.

## 3. The change

**`postSpreadSideGate`** — evaluate the floor first, consult the switch second, return a
`reason`. `pass`/`dirYes`/`netEdge` semantics are unchanged, so no caller behaviour moves.

```js
if (noNet != null && noNet >= minEdgeNo) {
  if (noSideEnabled) return { pass: true, dirYes: false, netEdge: noNet, yesNet, noNet, reason: null };
  return { pass: false, dirYes: null, netEdge: null, yesNet, noNet, reason: 'no_side_disabled' };
}
return { pass: false, dirYes: null, netEdge: null, yesNet, noNet, reason: 'below_floor' };
```

**Rationale builder** — new branch on `g.reason === 'no_side_disabled'`:

> NO side suppressed — the model's NO edge has not held up in live tracking, so we
> don't publish it as a signal pending recalibration. Not actionable.

No gross figure, no floor claim, no invitation to go trade it. The `below_floor` branch
keeps the original wording (which was always accurate) minus the now-dead `(BUY NO
disabled)` insert.

## 4. Verification actually performed

`npx vitest` **could not run in this session** — the mounted `node_modules` carries
macOS-arm64 rolldown bindings and the session shell is Linux (`MODULE_NOT_FOUND` on
`rolldown/dist/shared/binding-*.mjs`). This is an environment limit, not a test failure.

Instead the pure gate was exercised directly under `node` against the real module. All
11 assertions passed:

- switch off + `noNet` 15pp (clears 10pp floor) → `reason: 'no_side_disabled'`
- switch off + `noNet` 5pp (genuinely under) → `reason: 'below_floor'`
- switch **on** + clears floor → still `pass: true`, `dirYes: false`, `reason: null` (no behaviour change)
- YES BUY unaffected by the NO switch
- null bid / null ask / null model prob → never a BUY
- all four live 8/13 rows that printed the false claim → `no_side_disabled`

Two regression tests were added to `test/engine.commodity-base.no-side-gate.test.js`
covering the first two cases. **They have not been executed** — run them on a Mac.

## 5. To finish (Claude Code, on the Mac)

```bash
cd ~/pmp-ingestion
npx vitest run test/engine.commodity-base.no-side-gate.test.js
npx vitest run test/engine.commodities.test.js test/engine.commodity-base.mu-resolve.test.js
git add src/engine/commodity-base.js test/engine.commodity-base.no-side-gate.test.js
git commit -m "fix(bitcoin-edge): distinguish suppressed NO side from a failed net floor

The gate ANDed noSideEnabled into the floor test, so the rationale builder
could not tell 'below the 10pp net NO floor' from 'NO side switched off' and
asserted the former on rows clearing the floor by up to 6.9pp. Four such rows
were live on 8/13. Return a reason code and write honest copy per branch; stop
leading suppressed-side cards with a gross edge we decline to trade."
git push
```

Then redeploy the Fly worker (`fly.toml`) and re-run the §1 verify curl once a fresh
snapshot writes. **Push ≠ deployed** — confirm the worker restarted before calling it done.

## 6. Not in scope

This makes the tool *honest* about why the board is empty. It does not make the board
non-empty — that is the companion handoff.
