#!/usr/bin/env bash
# deploy/deploy.sh — build + run the TruePoint preview stack on a single Ubuntu host.
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
if grep -q "change-me-to-a-long-random-string" "$ENV_FILE"; then
  echo "ERROR: BLIND_INDEX_KEY in $ENV_FILE is still the placeholder."
  echo "  Set it to a strong value:  openssl rand -hex 32"
  exit 1
fi

# Ensure a VALID EdDSA keypair, then ship it BASE64-ENCODED. A multi-line PEM loses its newlines when docker
# compose interpolates ${VAR} → importPKCS8 throws → login 503s (token_mint_failed). Base64 is a single line,
# so it survives interpolation intact; packages/config decodes it back to a PEM at boot. Self-healing: we
# (re)generate when the key is missing OR fails an openssl parse (corrupt/empty), so one deploy.sh just works.
KEY_DIR="deploy/keys"
key_valid() { [ -f "$KEY_DIR/jwt_private.pem" ] && openssl pkey -in "$KEY_DIR/jwt_private.pem" -noout 2>/dev/null; }
pub_valid() { [ -f "$KEY_DIR/jwt_public.pem" ]  && openssl pkey -pubin -in "$KEY_DIR/jwt_public.pem" -noout 2>/dev/null; }

if ! key_valid; then
  echo "==> No valid JWT private key in $KEY_DIR/ — generating a fresh EdDSA keypair…"
  rm -f "$KEY_DIR/jwt_private.pem" "$KEY_DIR/jwt_public.pem"   # gen-keys.sh refuses to overwrite; clear first
  bash deploy/gen-keys.sh
elif ! pub_valid; then
  echo "==> JWT public key missing/invalid — deriving it from the private key…"
  openssl pkey -in "$KEY_DIR/jwt_private.pem" -pubout -out "$KEY_DIR/jwt_public.pem"
fi

JWT_PRIVATE_KEY_PEM_B64="$(base64 -w0 "$KEY_DIR/jwt_private.pem")"; export JWT_PRIVATE_KEY_PEM_B64
JWT_PUBLIC_KEY_PEM_B64="$(base64 -w0 "$KEY_DIR/jwt_public.pem")";   export JWT_PUBLIC_KEY_PEM_B64

# Persist the single-line base64 keys into $ENV_FILE so the signing key survives EVERY future container
# (re)start — not just this deploy.sh run. Compose loads them via `env_file`, so a later `docker compose up -d`
# (e.g. to apply an .env edit), a recreate, or a host reboot still has the key. A shell-only export would be
# gone on those paths → empty key → importPKCS8 throws → login 503s (token_mint_failed). Delete any prior copy
# by key (sed never nukes the file and is unaffected by base64's +,/,= chars), then append the fresh values
# via printf (literal — the base64 payload is never re-interpreted).
sed -i -E '/^(JWT_PRIVATE_KEY_PEM_B64|JWT_PUBLIC_KEY_PEM_B64)=/d' "$ENV_FILE"
printf 'JWT_PRIVATE_KEY_PEM_B64=%s\n' "$JWT_PRIVATE_KEY_PEM_B64" >> "$ENV_FILE"
printf 'JWT_PUBLIC_KEY_PEM_B64=%s\n'  "$JWT_PUBLIC_KEY_PEM_B64"  >> "$ENV_FILE"
echo "==> JWT keys validated, base64-encoded from $KEY_DIR/, and persisted to $ENV_FILE (durable across restarts)"

# ── 1. Build the single image ───────────────────────────────────────────────────
echo "==> [1/5] Building leadwolf:latest (bun install + next build — first run is slow)…"
DOCKER_BUILDKIT=1 docker build --secret id=dotenv,src="$ENV_FILE" -t leadwolf:latest .

# ── 2. Local infrastructure (Postgres is external — Neon/RDS — via DATABASE_URL) ──
echo "==> [2/4] Starting local infrastructure (redis, typesense, mailhog)…"
"${COMPOSE[@]}" up -d redis typesense mailhog

# ── 3. Migrations against DATABASE_URL (bootstrap roles/extensions → tables → RLS) ─
# Hard 5-min backstop: the migrator now sets prepare:false + connect/lock timeouts so it can't
# silently freeze on a Neon pooler, but `timeout` guarantees a hung run can never block the deploy
# (set -e turns the 124 exit into a clean abort BEFORE any app service starts).
echo "==> [3/4] Running database migrations…"
timeout 300 "${COMPOSE[@]}" run --rm migrate

# ── 4. App services + edge proxy ──────────────────────────────────────────────────
# SINGLE-HOST DEPLOY DOWNTIME WINDOW: each service runs as exactly one container, so `up -d` RECREATES it
# (stop old → start new) with a brief gap where the upstream refuses connections. A true zero-downtime
# rolling deploy (≥2 replicas, start-new-before-stop-old) needs Swarm/k8s or an external LB and is out of
# scope for this single-host preview. The gap is now cushioned by Caddy's `lb_try_duration` (Caddyfile):
# a request arriving mid-recreate retries the dial for a few seconds and waits for the new container
# instead of 502-ing immediately. Caddy is recreated LAST (it depends_on the apps being healthy), so the
# proxy is the last thing to blip and its retry cushion covers the apps' recreate gaps.
echo "==> [4/4] Starting app services + Caddy (api, auth, workers, web, admin, caddy)…"
"${COMPOSE[@]}" up -d api auth workers web admin caddy

# ── 5. Post-deploy smoke gate: prove sign-in can actually MINT, or fail the deploy loudly ───────────────
# The slim oven/bun image has no curl/wget — use bun -e. `up -d` already waited on healthchecks (Caddy
# depends on auth being healthy), so the auth container is up by now.
echo "==> Verifying Redis reachability…"
"${COMPOSE[@]}" exec -T redis redis-cli ping | grep -q PONG \
  || { echo "ERROR: Redis did not answer PONG — code issuance/exchange will fail."; exit 1; }

echo "==> Smoke test: minting a token inside the auth container (assertSigningKey)…"
if "${COMPOSE[@]}" exec -T auth bun -e "import('@leadwolf/auth').then(m=>m.assertSigningKey()).then(()=>process.exit(0),(e)=>{console.error(String((e&&e.message)||e));process.exit(1)})"; then
  echo "==> Smoke test PASSED — auth can mint tokens; sign-in should work."
else
  echo "ERROR: JWT signing self-test FAILED in the auth container — sign-in would 503 (token_mint_failed)."
  echo "       Recent auth logs:"
  "${COMPOSE[@]}" logs --tail=50 auth | grep -iE "token.exchange|signing_key|FATAL" || true
  exit 1
fi

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
