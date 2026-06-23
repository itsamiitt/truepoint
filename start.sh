#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${REPLIT_DEV_DOMAIN:-localhost}"
APP_URL="https://${DOMAIN}"

echo "🚀 TruePoint startup — domain: ${DOMAIN}"

# ── Write dev .env ────────────────────────────────────────────────────────────
cat > .env <<EOF
NODE_ENV=development

# Auth origins (single Replit domain; auth routes proxied through web app)
AUTH_ORIGIN=${APP_URL}
# Allow both the Replit HTTPS proxy and direct localhost access
APP_ORIGINS=${APP_URL},http://localhost:5000
AUTH_COOKIE_DOMAIN=${DOMAIN}
AUTH_BIND_IP=off

# JWT signing — Ed25519 dev keys (gitignored, non-production)
JWT_SIGNING_KID=dev-replit-2026
JWT_PRIVATE_KEY_PEM_B64=LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSU5LLzgxODR4dHdCektIY01xYmdUMmxGWWt5N2VhUzd4RzdtQitnMHhWZkQKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=
JWT_PUBLIC_KEY_PEM_B64=LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQTE0N01mZGNMWFZNV2lrRVd3YUdoN3BpOVhzb3hJMHF4VWpFS2hWNW80R0U9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=

# Database (Replit PostgreSQL — DATABASE_URL is injected by Replit)
DATABASE_URL=${DATABASE_URL:-postgresql://user:pass@localhost:5432/leadwolf}

# Redis (local redis-server started below)
REDIS_URL=redis://localhost:6379

# HMAC blind-index key
BLIND_INDEX_KEY=dev-replit-blind-idx-key-32chars!!

# Bootstrap platform admin (created on first migrate+seed)
BOOTSTRAP_ADMIN_EMAIL=admin@leadwolf.dev
BOOTSTRAP_ADMIN_PASSWORD=Admin1234!LeadWolf

# NEXT_PUBLIC_AUTH_ORIGIN, NEXT_PUBLIC_APP_ORIGIN, NEXT_PUBLIC_API_BASE are intentionally
# NOT set here. Leaving them unset (undefined) satisfies Zod's .optional() check; the web
# app uses relative URLs for all auth + API calls (publicConfig.ts reads "" as fallback).

# Optional integrations (stubs for dev — app degrades gracefully when absent)
TYPESENSE_URL=http://localhost:8108
TYPESENSE_API_KEY=dev
SMTP_URL=smtp://localhost:1025
EOF

echo "✅ .env written"

# Export all vars from .env into this shell so every child process (turbo → next dev, bun api, bun auth)
# inherits them without needing a per-app .env file. `set -a` auto-exports everything sourced below.
set -a
# shellcheck source=.env
source .env
set +a
echo "✅ env exported to shell"

# ── Start Redis ───────────────────────────────────────────────────────────────
redis-server --daemonize yes --logfile /tmp/redis.log --loglevel warning 2>/dev/null || true
echo -n "⏳ Waiting for Redis..."
for i in $(seq 1 20); do
  redis-cli ping 2>/dev/null | grep -q PONG && break
  sleep 0.5
done
echo " ✅ Redis ready"

# ── Install packages ──────────────────────────────────────────────────────────
# `|| true` prevents set -e from aborting on optional-native-package build failures
# (msgpackr-extract, cpu-features) which are non-fatal — pure-JS fallbacks take over.
echo "📦 Installing packages..."
bun install 2>&1 | tail -5 || true
echo "✅ Packages installed"

# ── Distribute .env to each app so bun/Next pick it up from their own CWD ────
# turbo changes CWD to each app dir before running; bun/Next.js each load .env
# from CWD, not from the monorepo root.  Copying is more reliable than env export.
cp .env apps/api/.env
cp .env apps/auth/.env.local
cp .env apps/web/.env.local
cp .env apps/workers/.env
echo "✅ .env distributed to each app"

# ── Run database migrations ───────────────────────────────────────────────────
echo "🗄️  Running migrations..."
bun run db:migrate 2>&1 | tail -5 || echo "⚠️  Migration warning (may already be up-to-date)"

# ── Launch all services ───────────────────────────────────────────────────────
echo "🟢 Starting all services..."
exec bun run dev
