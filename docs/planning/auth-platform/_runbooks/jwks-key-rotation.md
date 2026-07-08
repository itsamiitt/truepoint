# Runbook — JWKS signing-key rotation (overlapping-`kid`, zero-downtime)

**AUTH-013.** The access JWT is EdDSA-signed by `apps/auth` and verified statelessly by `apps/api` against the
published JWKS (`auth.<domain>/auth/.well-known/jwks.json`). A verifier selects the key by `kid`, and jose caches
the JWKS ~5 min. Rotation is zero-downtime because the JWKS can publish **two** keys during an overlap window
(the active key + a `NEXT` key): a token signed by **either** verifies while both are published.

## Env

- **Active** (the minter signs with this): `JWT_SIGNING_KID` + `JWT_PRIVATE_KEY_PEM(_B64)` +
  `JWT_PUBLIC_KEY_PEM(_B64)`.
- **Next** (published-only — PUBLIC key, no private): `JWT_NEXT_SIGNING_KID` + `JWT_NEXT_PUBLIC_KEY_PEM(_B64)`.
  Unset ⇒ single-key JWKS (today's exact behaviour).

The `_B64` form is the single-line base64 transport that survives docker-compose interpolation; the raw PEM wins
if both are set (same convention as the active key).

## Rotate A → B (zero downtime)

1. **Generate** a new EdDSA keypair (kid = `B`). Store B's private key in the secret manager; do **not** deploy
   it yet.
2. **Publish B alongside A.** Set `JWT_NEXT_SIGNING_KID=B` and `JWT_NEXT_PUBLIC_KEY_PEM(_B64)` = B's **public**
   key. Deploy `apps/auth`. JWKS now serves `{A, B}`. **Wait > 5 min** (the JWKS cache TTL) so every `apps/api`
   instance has fetched both. Nothing signs with B yet — no token changes.
3. **Cut the minter over to B.** Set `JWT_SIGNING_KID=B`, `JWT_PRIVATE_KEY_PEM(_B64)` = B's **private** key,
   `JWT_PUBLIC_KEY_PEM(_B64)` = B's public key. Move the **outgoing** key into the NEXT slot:
   `JWT_NEXT_SIGNING_KID=A`, `JWT_NEXT_PUBLIC_KEY_PEM(_B64)` = A's public key. Deploy `apps/auth`. The minter now
   signs with B; JWKS serves `{B, A}`. Tokens minted before this deploy (signed by A) **still verify** (A is
   still published). **Wait > the access-token TTL** (`ACCESS_TOKEN_TTL_SECONDS`, default 15 min) so every
   A-signed token has expired.
4. **Retire A.** Unset `JWT_NEXT_SIGNING_KID` + `JWT_NEXT_PUBLIC_KEY_PEM(_B64)`. Deploy `apps/auth`. JWKS serves
   `{B}`. Rotation complete — destroy A's private key.

## Guardrails

- **Never remove a `kid` from the JWKS while tokens signed by it can still be in flight** (younger than one
  access TTL). Doing so 401s live sessions. The wait in step 3 is the guardrail.
- The **refresh token is opaque + server-stored** (not a JWT), so rotation touches only the short-lived access
  JWT — refresh/session continuity is unaffected.
- **Emergency key compromise:** skip the overlap — set the active key to a fresh B immediately and leave NEXT
  unset. Live A-signed access tokens (≤ 15 min) are the accepted blast radius; force-revoke sessions (the
  deny-list) to cut it to zero.
- **Verify after each deploy:** `curl -s auth.<domain>/auth/.well-known/jwks.json | jq '.keys[].kid'` shows the
  expected `kid`s; then confirm a fresh login mints and `apps/api` accepts it.
