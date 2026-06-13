# Fly bot market-hours gate — Saturday firing incident

**Date:** 2026-06-13 (Sat) · **App:** `pmp-ingestion` (Fly, iad) · **Severity:** live incident (bot firing on a closed market)

## TL;DR

The bitcoin edge engine was firing snapshots **every 15s on a Saturday** with no live OPRA chain. Root cause: the expiration-burst window bypassed the off-hours pause for the hourly KXBTCD contract. Fixed in code + verified. **Deploy to stop it:**

```bash
cd /Users/benny/prediction-marketspicks/../pmp-ingestion   # i.e. ~/pmp-ingestion
npm run lint:no-axios && flyctl deploy --ha=false -a pmp-ingestion
flyctl logs -a pmp-ingestion | grep -i "bitcoin.*cadence"   # expect: cadence → dormant (market closed — snapshots paused)
```

Deploying on a weekend is the sanctioned window (README "Deploy timing") and is the mitigation itself — on restart every commodity goes dormant immediately because the market is closed.

---

## What was wrong

`isOptionsMarketOpen()` is weekend-aware and correctly returns `false` on Saturday. But `scheduleSnapshot()` in `src/index.js` let the **expiration burst** bypass the off-hours dormancy:

```js
const inBurst = isInExpirationWindow(state.currentEvent);   // OLD
if (config.pauseSnapshotsOffHours && !inBurst && !marketOpen) { /* dormant */ }
```

`isInExpirationWindow` is true whenever the current event closes within 60 min. **KXBTCD is an hourly, 24/7 contract**, so its event is *always* inside that 60-min window — `inBurst` was permanently `true`, so the `!inBurst` condition was never satisfied and the dormant branch never ran. Bitcoin fell through to the `expiration_burst` cadence (15s) and snapshotted continuously — weekends, holidays, overnight — pricing edges against a frozen/dark IBIT smile.

The bitcoin `eventFilter` only checks the ET *hour* (10–16), not the day of week, so Saturday 10am–4pm events were discovered normally. Today (Sat) at 13:51 ET it was dead-center in that window.

Silver/gold/oil were unaffected (weekly/monthly events are days from close on a Saturday → not in burst → dormant as intended).

## The fix (2 files)

**`src/feeds/massive.js`**
- Added `US_MARKET_HOLIDAYS` set (full-closure dates, **verified against the NYSE 2025–2027 calendar**) + `isUsMarketHoliday()`, exported.
- `isOptionsMarketOpen()` now also returns `false` on full-closure holidays (e.g. Juneteenth, Good Friday) — "trading days the market is open," not just Mon–Fri. Half-day early closes are intentionally not special-cased (chain is live 9:30–1pm; staleness filters absorb the rest).

**`src/index.js` → `scheduleSnapshot()`**
- `const inBurst = marketOpen && isInExpirationWindow(...)` — the burst only counts during an open session.
- Dropped the `config.pauseSnapshotsOffHours` precondition on the dormancy guard so the market-hours gate is **universal**: when the market is closed and we're not in a (now market-gated) burst, **no** commodity fires. Every enabled commodity already set `pauseSnapshotsOffHours=true`; this just makes any future non-pause commodity safe by default.

Net behavior: the bot fires only 9:30 AM–4:00 PM ET on non-holiday weekdays. (Bitcoin/SPX further restrict to the 10am–4pm hourly settles via their existing `eventFilter`, matching your "10–4" intent.)

## Verification done in-session

- `node --check` on `src/index.js`, `src/feeds/massive.js`, and the test file — all clean.
- `npm run lint:no-axios` — `no axios` (pass).
- Logic proof (plain Node, since vitest 4's rolldown native binding can't install in the sandbox — see below):
  - `isOptionsMarketOpen` → Sat 13:51 ET **false**, Sun **false**, Wed 14:00 ET **true**, Wed 09:00 ET **false**, Wed 16:00 ET **false**, Wed 09:30 ET **true**, Juneteenth **false**.
  - `isUsMarketHoliday` → Juneteenth 2026 **true**, Good Friday 2027 **true**, ordinary day **false**.
  - `scheduleSnapshot` gate replay → Sat BTC (12 min to close) **dormant**; weekday BTC (12 min) **expiration_burst**; weekday BTC (5h) **market**.

## You still need to run (handed off)

1. **Deploy** (command above). This is the live-incident stop.
2. **Run the test suite locally** — I added regression tests to `test/feeds.massive.test.js` (`isOptionsMarketOpen` + `isUsMarketHoliday` blocks) but couldn't execute vitest here (the prebuilt `@rolldown/binding-linux-arm64-gnu` isn't present in the Linux sandbox; your Mac has the darwin-arm64 binding):
   ```bash
   cd ~/pmp-ingestion && npm test
   ```
3. **Post-deploy sanity:** `flyctl logs -a pmp-ingestion` — confirm bitcoin logs `cadence → dormant (market closed — snapshots paused)` and that you do **not** see new `[bitcoin] snapshot:` lines until Monday 9:30 AM ET.

## Maintenance note

`US_MARKET_HOLIDAYS` in `massive.js` covers 2026–2027. **Append 2028 before 2027 lapses** or the bot will treat next-year holidays as trading days. Source: NYSE Group holiday calendar (ir.theice.com).
