# pmp-ingestion

Always-on Node 24 service on Fly.io. Holds open Kalshi WS, polls Massive options + Pyth Hermes, computes edges in memory, writes `commodity_edge_signals`, fires Discord webhooks, pings Vercel ISR.

Plan of record: `prediction-marketspicks/handoffs/PMP_INGESTION_ENGINE_BUILD_PLAN.md`.

## Status

- **Phase 0** — Fly machine, Kalshi RSA-PSS WS auth, `/health`, Sentry. ✅ shipped 2026-05-02.
- **Phase 1** — Silver Edge intraday MVP (REST polling primary, BS/Brent IV fallback, `delayed_test` bridge-week tag). Ready to deploy.
- **Phase 2 → 4** — see plan.

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
curl https://pmp-ingestion.fly.dev/health | jq
```

`--ha=false` is required — otherwise Fly auto-spawns a 2nd machine for HA on every deploy. Plan §12 mandates single-machine in `iad`.

If a second machine slips through:

```
flyctl scale count 1 -a pmp-ingestion --yes
```

## Bridge-week pattern (Phase 1, May 2 → Mon/Tue real-time provisioning)

Massive is on the paid 15-min delayed Options tier this week. Sales meeting Mon May 4 / Tue May 5 provisions Options Advanced (real-time). Same URL, same response shape, server-side tier flip.

Engine writes `snapshot_type='delayed_test'` rows during the bridge. The site-side reader filters `WHERE snapshot_type IN ('daily','intraday')`, so users never see delayed data. Cutover = `flyctl secrets set WRITER_TAG=intraday -a pmp-ingestion`. Zero code change.

## Health endpoint shape

```
{
  status, uptime_s, engine_env, writer_tag,
  feeds: {
    kalshi:        { connected, lastTickAt, ageMs, lastError },
    massive_slv:   { ... },
    pyth_xag_usd:  { ... },
    silver_engine: { ... }
  },
  engine: {
    env, snapshotCount, lastSnapshotErrAt,
    currentEvent: 'KXSILVERW-26MAY0817',
    lastSnapshot: { generatedAt, spotPrice, etfPrice, topTier, topTierInt, strikeCount }
  }
}
```

## Manual debug endpoints

- `GET /dev/throw` — fires a test exception; should appear in Sentry within seconds
- `GET /dev/snapshot` — runs one silver snapshot synchronously, returns the result

## Invariants

- No axios. Native fetch + AbortController only. Pre-deploy lint: `npm run lint:no-axios`.
- Kalshi RSA-PSS auth (NOT HMAC).
- Kalshi WS channel = `ticker` (NOT `ticker_v2`).
- Kalshi ticker message fields: `price_dollars` / `yes_bid_dollars` / `yes_ask_dollars` (strings) + `volume_fp` / `open_interest_fp` (FP strings) + `ts_ms`.
- Single Fly machine in `iad`, no HA in v1.
- All secrets via `flyctl secrets set`. Never commit `*.pem`, `.env`.
- Discord embeds link to the Kalshi sign-up referral URL, NOT per-market deep-links (CLAUDE.md, locked May 2 2026).
- Brand word-swap lint runs at `npm test` AND at runtime in `src/delivery/discord.js` — Discord delivery refuses payloads containing bet/wager/sportsbook/etc.
