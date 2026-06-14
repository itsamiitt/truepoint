#!/usr/bin/env bash
# deploy/gen-keys.sh — generate an EdDSA (Ed25519) keypair for JWT signing.
# The keys are written to deploy/keys/ (git-ignored) and injected into the auth/api
# containers by deploy.sh. Run this once before deploy.sh if you need working login.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p keys
if [ -f keys/jwt_private.pem ]; then
  echo "keys/jwt_private.pem already exists — refusing to overwrite. Delete it to regenerate."
  exit 1
fi

openssl genpkey -algorithm ed25519 -out keys/jwt_private.pem
openssl pkey -in keys/jwt_private.pem -pubout -out keys/jwt_public.pem
chmod 600 keys/jwt_private.pem

echo "Generated:"
echo "  deploy/keys/jwt_private.pem  (signs access tokens — keep secret)"
echo "  deploy/keys/jwt_public.pem   (published via JWKS)"
echo "Now run: bash deploy/deploy.sh"
