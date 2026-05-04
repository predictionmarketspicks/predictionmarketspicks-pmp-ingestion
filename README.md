# pmp-ingestion

Always-on Node 24 service on Fly.io. Holds open Kalshi WS, polls Massive options + Pyth Hermes, computes edges in memory, writes `commodity_edge_signals`, fires Discord webhooks, pings Vercel ISR.

Plan of record: `prediction-marketspicks/handoffs/PMP_INGESTION_ENGINE_BUILD_PLAN.md`.

## Status

- **Phase 0** — Fly machine, Kalshi RSA-PSS WS auth, `/health`, Sentry. ✅ shipped 2026-05-02.
- **Phase 1** — Silver Edge intraday MVP. ✅ shipped 2026-05-02.
- **Phase 2A** — Multi-commodity expansion (gold/oil/copper engines, delta filter, parameterized Discord). ✅ this PR.
- **Phase 2B** — Polymarket CLOB feed + cross-platform arb (`arb_alerts` + Pro `<ArbAlerts />`). Next session.
- **Phase 3** — Discord migration + posted_alerts dedup. ✅ shipped 2026-05-02.
- **Phase 4** — Observability + resilience: per-feed liveness gates `/health`, cold-start REST seed for Kalshi, BetterStack/Sentry runbook. ✅ this PR.

## Local dev

```
cp .env.example .env
# fill in secrets (see "Required secrets" below)
npm install
npm test          # vitest — IV solver + brand-safety lint
npm run dev       # node --watch
```

## Required secrets (Fly + local `.env`)

Phase 0:

```
KALSHI_API_KEY_ID
KALSHI_PRIVATE_KEY        # PEM string from `flyctl secrets set KALSHI_PRIVATE_KEY="$(cat kalshi.pem)"`
KALSHI_API_BASE           # https://api.elections.kalshi.com/trade-api/v2
KALSHI_WS_URL             # wss://api.elections.kalshi.com/trade-api/ws/v2
SENTRY_DSN
ENGINE_ENV                # 'dev' | 'staging' | 'prod'
WRITER_TAG                # 'delayed_test' (bridge week) → 'intraday' (post-cutover)
PYTH_HERMES_BASE          # https://hermes.pyth.network
```

Phase 1 adds:

```
MASSIVE_API_KEY           # Options Advanced; rotated 2026-05-02
SUPABASE_URL              # https://svxqipncfupabpvxtlro.supabase.co
SUPABASE_SERVICE_KEY      # service role — bypasses RLS for engine writes
DISCORD_BOT_TOKEN         # Same secret the existing PMP Edge Function scanners use.
                          # Bot already in the guild; channel routing in src/delivery/discord.js
                          # (STRONG → #oracle-picks, MODERATE → #premium-alerts,
                          #  SPECULATIVE → #commodity-edge — IDs from docs/discord-reference.md)
VERCEL_REVALIDATE_TOKEN   # bearer; site-side /api/revalidate accepts this
VERCEL_DEPLOY_HOOK_URL    # optional — fallback if /api/revalidate is down
SITE_BASE_URL             # https://predictionmarketspicks.com (default)
```

## Deploy

```
flyctl deploy --ha=false -a pmp-ingestion
flyctl logs -a pmp-ingestion
curl https://pmp-ingestion.fly.dev/health | jq '{healthy, liveness, feeds: .feeds | keys}'
```

`--ha=false` is required — otherwise Fly auto-spawns a 2nd machine for HA on every deploy. Plan §12 mandates single-machine in `iad`.

If a second machine slips through:

```
flyctl scale count 1 -a pmp-ingestion --yes
```

### Deploy timing (Phase 4)

Each `flyctl deploy` causes a ~10–15s gap as the new image rolls. The 60s boot grace inside `/health` suppresses false 503s on the new machine, so BetterStack won't page — but readers still see ~15s of stale data.

**Rule of thumb**: deploy outside US market hours (4:00 PM ET → 9:30 AM ET on weekdays; anytime weekends). Intraday cadence is idle off-hours, so the gap is invisible. Live incidents override — fix the bug.

Full incident playbook + BetterStack/Sentry setup: `prediction-marketspicks/docs/INGESTION_OPERATOR_RUNBOOK.md`. Threshold tuning: `prediction-marketspicks/docs/INGESTION_THRESHOLDS.md`.

## Bridge-week pattern (historical — completed 2026-05-04)

Massive flipped from the paid 15-min delayed Options tier to Options Advanced (real-time) server-side on the existing API key. Operator set `flyctl secrets set WRITER_TAG=intraday -a pmp-ingestion` and the engine started writing `snapshot_type='intraday'` (or `'daily'`). Zero code change.

The `delayed_test` writer-tag branch is kept in `src/index.js` for any future bridge scenario (tier rollback, second underlying still on delayed tier).

## Health endpoint shape

```
{
  status, uptime_s, engine_env, writer_tag,
  healthy: true,                       // 503 if false (Phase 4)
  liveness: {
    inMarketHours: true,               // 9:30am–4pm ET, M–F
    thresholdMs: 90000,                // 90s in market hours, 300s off-hours
    uptimeMs: 12345,
    grace: false,                      // true during the first 60s of uptime
    stale: []                          // [{name, reason, ageMs}] when 503
  },
  feeds: {
    kalshi:        { connected, lastTickAt, ageMs, lastError, required: true },
    polymarket:    { ..., required: true },
    massive_slv:   { ..., required: true },
    pyth_xag_usd:  { ..., required: true },
    silver_engine: { ..., required: false },
    arb_engine:    { ..., required: false }
  },
  engine: {
    env,
    commodities: {
      silver: { snapshotCount, lastSnapshotErrAt, currentEvent, lastSnapshot: {...} },
      gold:   { snapshotCount, lastSnapshotErrAt, currentEvent, lastSnapshot: {...} }
    },
    disabledCommodities: ['oil', 'copper']
  }
}
```

`required: true` feeds gate the 200/503 status. Engines (`*_engine`) are reported but never page — their cadence is minutes, and an upstream feed will go stale first if anything's wrong.

## Manual debug endpoints

- `GET /dev/throw` — fires a test exception; should appear in Sentry within seconds
- `GET /dev/snapshot?commodity=silver|gold` — runs one snapshot synchronously, returns the result
- `GET /dev/movers?test=true` — fires one movers scan; `test=true` skips filters + dedup so it always posts
- `GET /dev/macro` — fires one Kalshi macro snapshot pass; returns rows fetched + rows written to `macro_market_snapshots`

## Invariants

- No axios. Native fetch + AbortController only. Pre-deploy lint: `npm run lint:no-axios`.
- Kalshi RSA-PSS auth (NOT HMAC).
- Kalshi WS channel = `ticker` (NOT `ticker_v2`).
- Kalshi ticker message fields: `price_dollars` / `yes_bid_dollars` / `yes_ask_dollars` (strings) + `volume_fp` / `open_interest_fp` (FP strings) + `ts_ms`.
- Single Fly machine in `iad`, no HA in v1.
- All secrets via `flyctl secrets set`. Never commit `*.pem`, `.env`.
- Discord embeds link to the Kalshi sign-up referral URL, NOT per-market deep-links (CLAUDE.md, locked May 2 2026).
- Brand word-swap lint runs at `npm test` AND at runtime in `src/delivery/discord.js` — Discord delivery refuses payloads containing bet/wager/sportsbook/etc.

## Phase 2A notes

- **Commodity registry**: `src/engine/commodities.js` is the single source of truth. Adding a commodity = one entry there + one thin wrapper in `src/engine/`. The shared compute path lives in `src/engine/commodity-base.js`.
- **Delta filter**: `0.15 ≤ |Δ| ≤ 0.85` applied in `src/feeds/massive.js`. Missing-delta passthrough means the bridge-week 15-min-delayed tier (greeks: {} on weekends and off-hours) still produces a chain. Post Mon/Tue real-time cutover, greeks populate live and the filter starts pruning to ~50–80 strikes per ETF.
- **Disabled commodities (oil, copper)**: scaffolded but no verified spot feed yet. See `docs/COMMODITY_FEEDS.md` for the resolution path. Engines fail open — disabled commodities don't bootstrap, so Pyth poller doesn't waste calls on unverified IDs.

## Session 2 notes (2026-05-04)

- **Options quality filters** (`src/feeds/massive.js`): drop strikes with bid ≤ 0, 24h volume < 50, spread/mid > 25%, or open interest < 100. Strikes that pass with volume ≤ 150 are tagged `speculative`; the smile builder propagates the tag to the resulting `commodity_edge_signals` row, capping confidence at `low` regardless of edge magnitude. Kills the "options imply 0%" phantom rows in the silver-edge widget.
- **Macro market snapshots** (`src/engine/macro.js` + `src/feeds/kalshi-macro.js`): every 5 min in market hours, 15 min off-hours, the engine pulls the 22-series Kalshi watchlist (shared with `feeds/movers.js`) and writes per-market rows to `macro_market_snapshots` (UNIQUE on `(ticker, snapshot_at)`, 30-day TTL via pg_cron jobid 78). Append-only — readers query latest via `(ticker, snapshot_at DESC)` index. Site-side migration off direct Kalshi REST is Session 3.
