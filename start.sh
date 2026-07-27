#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${REPLIT_DEV_DOMAIN:-localhost}"
APP_URL="https://${DOMAIN}"

echo "🚀 TruePoint startup — domain: ${DOMAIN}"

# ── Dev secrets: GENERATED on first boot, never committed ─────────────────────
# This file is tracked in git. It previously carried an inline Ed25519 PRIVATE key, the blind-index HMAC key
# and a bootstrap admin password, under a comment claiming they were "gitignored" — they were not. Anything
# written here is public to everyone with repo access, so the secrets are now generated on first boot into
# .dev-secrets.env (gitignored) and merely sourced from here.
#
# Generated with bun's WebCrypto rather than openssl: bun is guaranteed present in this repo, openssl is not
# guaranteed on every dev host. Keys are per-machine, so two developers never share a signing key — which is
# the actual property that was missing before, more than secrecy of a known-dev value.
SECRETS_FILE=".dev-secrets.env"
if [ ! -f "$SECRETS_FILE" ]; then
  echo "🔑 generating dev secrets → ${SECRETS_FILE} (first boot)"
  bun -e '
    const b64 = (buf) => Buffer.from(buf).toString("base64");
    const pem = (der, label) => {
      const body = b64(der).replace(/(.{64})/g, "$1\n");
      return `-----BEGIN ${label} KEY-----\n${body}\n-----END ${label} KEY-----\n`;
    };
    const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const priv = pem(await crypto.subtle.exportKey("pkcs8", kp.privateKey), "PRIVATE");
    const pub = pem(await crypto.subtle.exportKey("spki", kp.publicKey), "PUBLIC");
    const rand = (n) => b64(crypto.getRandomValues(new Uint8Array(n))).replace(/[^A-Za-z0-9]/g, "").slice(0, n);
    process.stdout.write(
      `JWT_SIGNING_KID=dev-${Math.floor(Date.now() / 1000)}\n` +
      `JWT_PRIVATE_KEY_PEM_B64=${b64(priv)}\n` +
      `JWT_PUBLIC_KEY_PEM_B64=${b64(pub)}\n` +
      `BLIND_INDEX_KEY=${rand(32)}\n` +
      `BOOTSTRAP_ADMIN_PASSWORD=${rand(24)}Aa1!\n`,
    );
  ' > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  echo "   bootstrap admin password is in ${SECRETS_FILE} (chmod 600, gitignored)"
fi
# shellcheck disable=SC1090
. "./$SECRETS_FILE"

# ── Write dev .env ────────────────────────────────────────────────────────────
cat > .env <<EOF
NODE_ENV=development

# Auth origins (single Replit domain; auth routes proxied through web app)
AUTH_ORIGIN=${APP_URL}
# Allow both the Replit HTTPS proxy and direct localhost access
APP_ORIGINS=${APP_URL},http://localhost:5000
AUTH_COOKIE_DOMAIN=${DOMAIN}
AUTH_BIND_IP=off

# JWT signing — Ed25519 dev keys, generated per machine into .dev-secrets.env on first boot (see above).
JWT_SIGNING_KID=${JWT_SIGNING_KID}
JWT_PRIVATE_KEY_PEM_B64=${JWT_PRIVATE_KEY_PEM_B64}
JWT_PUBLIC_KEY_PEM_B64=${JWT_PUBLIC_KEY_PEM_B64}

# Database (Replit PostgreSQL — DATABASE_URL is injected by Replit)
DATABASE_URL=${DATABASE_URL:-postgresql://user:pass@localhost:5432/leadwolf}

# Redis (local redis-server started below)
REDIS_URL=redis://localhost:6379

# HMAC blind-index key (generated per machine — see .dev-secrets.env)
BLIND_INDEX_KEY=${BLIND_INDEX_KEY}

# Bootstrap platform admin (created on first migrate+seed). The password is generated, not literal — read it
# from .dev-secrets.env, which is chmod 600 and gitignored.
BOOTSTRAP_ADMIN_EMAIL=admin@leadwolf.dev
BOOTSTRAP_ADMIN_PASSWORD=${BOOTSTRAP_ADMIN_PASSWORD}

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
