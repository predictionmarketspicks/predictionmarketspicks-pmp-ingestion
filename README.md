# pmp-ingestion

Always-on Node 24 service on Fly.io. Holds open Kalshi/Polymarket WS connections, polls Massive options snapshots and Pyth, computes edges in memory, writes Supabase + fires Discord webhooks + revalidates Vercel ISR.

Plan of record: `prediction-marketspicks/handoffs/PMP_INGESTION_ENGINE_BUILD_PLAN.md`.

## Status

Phase 0 — foundation: Fly machine, Kalshi WS auth, `/health`, Sentry.

## Local

```
cp .env.example .env
# fill in secrets
npm install
npm run dev
```

## Deploy

```
flyctl deploy --ha=false   # plan §12: single machine in iad, no HA
flyctl logs -a pmp-ingestion
curl https://pmp-ingestion.fly.dev/health
```

`--ha=false` is required — otherwise Fly auto-spawns a 2nd machine for HA on every deploy.

## Invariants

- No axios. Native fetch + AbortController only.
- Kalshi RSA-PSS auth (NOT HMAC).
- Single Fly machine in `iad`, no HA in v1.
- All secrets via `flyctl secrets set`. Never commit `*.pem`, `.env`.
