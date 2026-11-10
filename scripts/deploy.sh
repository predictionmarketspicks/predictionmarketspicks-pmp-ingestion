#!/usr/bin/env bash
# scripts/deploy.sh — the only documented way to deploy the engine
# (handoffs/MCP_TRUTH_BUILD_STAMP_AND_CONVERSION_2026-11-10.md U1).
#
# WHY. On 2026-11-10 production /health reported `build: unknown`: `fly deploy -a pmp-ingestion`
# passes no GIT_SHA build arg (Dockerfile: ARG GIT_SHA=unknown), and nothing checked afterwards.
# An unidentified build turns every investigation into a guess. This script refuses a dirty tree,
# stamps HEAD into the image, and exits non-zero unless production reports that exact commit.
#
#   npm run deploy            # same as: bash scripts/deploy.sh
#   npm run deploy -- --now   # extra args pass through to `fly deploy`
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "deploy: refused — tracked files are modified. Commit them first:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

SHA=$(git rev-parse --short HEAD)
echo "deploy: pmp-ingestion @ ${SHA}"
fly deploy -a pmp-ingestion --remote-only --build-arg GIT_SHA="${SHA}" "$@"

# No `-f`: /health can answer 503 in market hours with a valid body (a stale feed), and the
# build stamp is still in it.
echo "deploy: waiting for https://pmp-ingestion.fly.dev/health to report build ${SHA}"
GOT=""
for _ in $(seq 1 30); do
  GOT=$(curl -s --max-time 10 https://pmp-ingestion.fly.dev/health | jq -r '.engine.build // empty' 2>/dev/null || true)
  if [ "${GOT}" = "${SHA}" ]; then
    echo "deploy: /health build = ${GOT} — production is identified"
    exit 0
  fi
  sleep 10
done
echo "deploy: FAILED — /health build = '${GOT:-<empty>}', expected ${SHA}" >&2
exit 1
