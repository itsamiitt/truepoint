#!/usr/bin/env bash
# deploy/deploy.sh — build + run the LeadWolf preview stack on a single Ubuntu host.
# Idempotent: safe to re-run after editing code or .env.production (it rebuilds + restarts).
set -euo pipefail
cd "$(dirname "$0")/.."   # → repo root

ENV_FILE=".env.production"
COMPOSE=(docker compose -f docker-compose.prod.yml)

# ── Preflight ─────────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found."
  echo "  cp deploy/env.production.template $ENV_FILE   # then edit it"
  exit 1
fi
if grep -q "PUBLIC_HOST" "$ENV_FILE"; then
  echo "ERROR: $ENV_FILE still contains the placeholder 'PUBLIC_HOST'."
  echo "  Replace it with your server's public IP or domain, then re-run."
  exit 1
fi

# Inject EdDSA keys (multiline → shell env → compose interpolation) when present.
if [ -f deploy/keys/jwt_private.pem ] && [ -f deploy/keys/jwt_public.pem ]; then
  JWT_PRIVATE_KEY_PEM="$(cat deploy/keys/jwt_private.pem)"; export JWT_PRIVATE_KEY_PEM
  JWT_PUBLIC_KEY_PEM="$(cat deploy/keys/jwt_public.pem)";   export JWT_PUBLIC_KEY_PEM
  echo "==> JWT keys loaded from deploy/keys/"
else
  echo "==> No deploy/keys/ found — auth boots but cannot sign tokens."
  echo "    Run 'bash deploy/gen-keys.sh' and re-run this script to enable login."
fi

# ── 1. Build the single image ───────────────────────────────────────────────────
echo "==> [1/5] Building leadwolf:latest (bun install + next build — first run is slow)…"
DOCKER_BUILDKIT=1 docker build --secret id=dotenv,src="$ENV_FILE" -t leadwolf:latest .

# ── 2. Infrastructure ─────────────────────────────────────────────────────────────
echo "==> [2/5] Starting infrastructure (postgres, redis, typesense, mailhog)…"
"${COMPOSE[@]}" up -d postgres redis typesense mailhog

# ── 3. Wait for Postgres health ──────────────────────────────────────────────────
echo -n "==> [3/5] Waiting for Postgres to become healthy"
PG_ID="$("${COMPOSE[@]}" ps -q postgres)"
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG_ID" 2>/dev/null)" = "healthy" ]; do
  sleep 2; echo -n "."
done
echo " ok"

# ── 4. Migrations (bootstrap roles/extensions → tables → RLS policies) ───────────
echo "==> [4/5] Running database migrations…"
"${COMPOSE[@]}" run --rm migrate

# ── 5. App services ───────────────────────────────────────────────────────────────
echo "==> [5/5] Starting application services (api, auth, workers, web)…"
"${COMPOSE[@]}" up -d api auth workers web

echo
echo "Containers:"
"${COMPOSE[@]}" ps
echo
echo "Endpoints:"
echo "  App   : $(grep '^NEXT_PUBLIC_APP_ORIGIN='  "$ENV_FILE" | cut -d= -f2-)"
echo "  Auth  : $(grep '^NEXT_PUBLIC_AUTH_ORIGIN=' "$ENV_FILE" | cut -d= -f2-)"
echo "  API   : $(grep '^NEXT_PUBLIC_API_BASE='    "$ENV_FILE" | cut -d= -f2-)/health"
echo "  Mail  : http://127.0.0.1:8025  (MailHog — view via SSH tunnel)"
echo
echo "Tail logs with:  docker compose -f docker-compose.prod.yml logs -f api auth web workers"
