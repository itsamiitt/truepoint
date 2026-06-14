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
if grep -q "USER:PASSWORD@HOST" "$ENV_FILE"; then
  echo "ERROR: DATABASE_URL in $ENV_FILE is still the template placeholder."
  echo "  Set it to your managed Postgres (Neon/RDS) connection string, then re-run."
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

# ── 2. Local infrastructure (Postgres is external — Neon/RDS — via DATABASE_URL) ──
echo "==> [2/4] Starting local infrastructure (redis, typesense, mailhog)…"
"${COMPOSE[@]}" up -d redis typesense mailhog

# ── 3. Migrations against DATABASE_URL (bootstrap roles/extensions → tables → RLS) ─
echo "==> [3/4] Running database migrations…"
"${COMPOSE[@]}" run --rm migrate

# ── 4. App services + edge proxy ──────────────────────────────────────────────────
echo "==> [4/4] Starting app services + Caddy (api, auth, workers, web, caddy)…"
"${COMPOSE[@]}" up -d api auth workers web caddy

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
