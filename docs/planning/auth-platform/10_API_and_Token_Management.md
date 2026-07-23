# 10 — API & Token Management (Developer Platform)

> Document 10 of 12 · TruePoint Centralized Authentication Platform. The OAuth authorization server, token strategy, machine
> auth, API keys, webhooks, SDKs, and the management/identity/audit APIs. Grounded in the token audit
> ([`_evidence/audit/token-session.md`](./_evidence/audit/token-session.md)) and the callback/OAuth design (doc 08).

## Executive summary

TruePoint's first-party token core is strong (EdDSA JWT, opaque rotating refresh, per-request revocation — doc 01 Part D).
What's absent is everything a **developer platform** needs: a standards-compliant OAuth 2.1 authorization server for
third-party clients, **machine-to-machine auth** (client-credentials, service accounts), **API keys / personal access
tokens**, signed **webhooks** for auth events, and **SDKs** (`AUTH-017`). This document specifies those, plus the
operational token work the audit flagged: **dual-key JWKS rotation**, **KMS custody**, **scope enforcement** (`AUTH-065`),
and **deny-list observability** (`AUTH-066`).

The design goal is a clean split, borrowed from Auth0/Okta/WorkOS: an **Auth API** (login, tokens, sessions — first-party,
high-traffic) separate from a **Management API** (configure clients, keys, policies — admin, low-traffic, strongly audited).

## 1. Token architecture (current → target)

**Current (verified):** EdDSA access JWT, `kid`-selected, `iss`/`aud` pinned, 15-min TTL, in memory only, claims
`sub, tid, wid?, sid, scope[], pa?`; opaque refresh (SHA-256 at rest, rotated, reuse-detected); per-request deny-list check.

**Target additions:**
- **Enforce `scope` at the API** (`AUTH-065`) — audience proves "may present," scope proves "may call this route," deny-by-
  default (doc 08 §5).
- **Dual-key JWKS** (`AUTH-013`) — publish `[current, next]`, sign with current, verify against both; overlapping-`kid`
  zero-downtime rotation. Runbook in §8.
- **KMS custody** (`AUTH-013`) — signing key and at-rest data key in KMS with versioning; stop deriving the at-rest key from
  `BLIND_INDEX_KEY`.
- **`clockTolerance:30s`** (`AUTH-076`); consider `amr`/`acr` for step-up, `jti` only if per-token revocation is needed.
- **Sender-constraining (DPoP, RFC 9449)** for public clients (extension/mobile/CLI) — binds a token to a client key so an
  exfiltrated token is useless without the key. The highest-leverage upgrade beyond scope enforcement.

**Reference token-lifetime table:**

| Token | TTL | Rotation | Notes |
|---|---|---|---|
| Access (web) | 15 m | — | in memory |
| Access (extension/mobile) | 10 m | — | DPoP-bound (target), scope-restricted |
| Refresh | 30 d absolute, idle-capped | every use, reuse-detected | opaque, hash-at-rest |
| Cross-domain code | 60 s | single-use | PKCE+IP+origin bound |
| Magic / reset | 15 m | single-use | hashed |
| Email verify | 24 h | single-use | |
| Device code (RFC 8628) | 5 m | — | CLI |
| Client-credentials access | short (e.g. 10 m) | re-issue | M2M, no refresh |
| API key / PAT | long / no expiry (revocable) | — | hash-at-rest, scoped, last-used tracked |

## 2. The OAuth 2.1 authorization server

A standards-compliant server on the IdP (`/auth/oauth/*`, doc 08 §7), driven by the `oauth_clients` registry (doc 11):

- **Grants:** authorization-code + PKCE (all interactive, incl. confidential), **client-credentials** (M2M), **device
  authorization** (RFC 8628, CLIs), **token-exchange** (RFC 8693 — delegation/impersonation, the staff-impersonation path).
  **No ROPC.** Refresh rotation everywhere.
- **Endpoints:** `/authorize`, `/token`, `/revoke` (RFC 7009), `/introspect` (RFC 7662, for opaque introspection if used),
  `/.well-known/openid-configuration`, JWKS. Optional **PAR** (RFC 9126) + **JAR** for high-assurance clients; **resource
  indicators** (RFC 8707) so a token is minted for a specific API audience.
- **Consent:** a consent screen + `oauth_grants` store; per-user connected-apps management (revocable — closes the
  `AUTH-017` "connected applications" gap in doc 05).
- **Client types & policy** (doc 08 §5) are rows in `oauth_clients`: grant types, redirect URIs, scopes, token TTLs,
  sender-constraining — admin-managed in doc 04.

## 3. Machine-to-machine & service accounts (AUTH-017)

- **Service accounts** (`service_accounts`, doc 11) are tenant-scoped machine identities with their own scopes; they
  authenticate via **client-credentials** and receive short-lived, scope-restricted access tokens (no refresh — re-issue).
- **mTLS (RFC 8705)** or **DPoP** sender-constrains M2M tokens for high-assurance integrations.
- Service-account actions are audited with the machine identity as `actor`, never a human user.

## 4. API keys / personal access tokens (AUTH-017)

- **Scoped, shown-once, hash-at-rest** (`api_keys`, doc 11). Create → display once → store hash; list shows prefix +
  last-used + scopes; revoke is immediate.
- **User PATs** (`user_id` set) act as the user with a restricted scope; **tenant/service keys** (`user_id NULL`) act as a
  service account.
- Rate-limited and scope-enforced at the API exactly like OAuth tokens (deny-by-default).
- The `apps/web` developer UI that currently ships against nonexistent `/api/v1/tenants/me/api-keys` endpoints (`AUTH-017`)
  gets its real backend here.

## 5. Webhooks (auth events)

- **Signed (HMAC) outbound** subscriptions to auth events (`login.*`, `mfa.*`, `session.revoked`, `user.provisioned/
  deprovisioned`, `role.changed`, `sso.*`), fed by the transactional outbox (doc 03 §8), delivered at-least-once by a worker
  with retry + DLQ, **SSRF-guarded** (`AUTH-009`) — reusing the M12 webhook infrastructure pattern.
- Customers use these for their own audit/SIEM and automation; combined with **SIEM export** (`AUTH-038`) and a future
  **CAEP/Shared-Signals transmitter** (`AUTH-016`) they satisfy the enterprise "stream me auth events" questionnaire item.

## 6. SDKs

- **Server SDK** (Node/TS first, matching the stack) — verify tokens against JWKS, introspect, call the Management API,
  validate webhook signatures.
- **Client helpers** — the extracted `@leadwolf/auth-client` (doc 08 §4) for the PKCE + silent-refresh flow, shared by web/
  admin and publishable for first-party consumers.
- **Conventions to copy** (Auth0/WorkOS): idempotent Management API writes (`Idempotency-Key`), cursor pagination, RFC 9457
  errors on the first-party API, semantic versioning of the contract.

## 7. Management / Identity / Audit APIs

- **Management API** (`/api/v1/auth-admin/*`, staff-RBAC + `withPlatformTx`): CRUD for clients, keys, methods, providers,
  policies, branding, templates, webhooks — the machine surface behind the admin console (doc 04). Every write audited.
- **Identity API** (`/api/v1/…/users`, `/scim/v2`): read/manage identities + memberships; SCIM for directory sync (doc 07).
- **Audit API** (`/api/v1/…/audit`): query the auth-event log; export to SIEM (`AUTH-038`).

## 8. Key rotation & custody (AUTH-013)

- **Signing keys:** dual-key publish (`JWT_NEXT_PUBLIC_KEY_PEM` + `JWT_NEXT_SIGNING_KID`); rotate by promoting `next` →
  `current`, minting a new `next`, waiting the JWKS-cache + access-TTL overlap (~20 min), then retiring the old key. Emergency
  rotation adds a **deny-list flush** of all sessions.
- **At-rest data key:** KMS-managed, versioned; stored ciphertext tagged with key version for re-encrypt.
- **Runbook** (doc 12 Phase 2): who rotates, the overlap window, the smoke gate (mint+verify), and the compromise path.

## 9. Security considerations

- **Scope + audience both enforced** (`AUTH-065`); deny-by-default.
- **Deny-list fail-open is observable** (`AUTH-066`) — alert on read/write failure; bound the ≤15-min residual explicitly in
  the "instant off-boarding" claim.
- **`pa` demotion revokes sessions** (`AUTH-072`).
- **All outbound (webhooks, JWKS, discovery, metadata) is SSRF-guarded** (`AUTH-009`).
- **Secrets** (client secrets, key hashes) hashed/encrypted, KMS-managed, never in a read model or log; `NEXT_PUBLIC_*` never
  carries a secret.
- **Mass-assignment allowlists** on token/claim minting — no privilege field settable from client input (`AUTH-034`).

## 10. Non-functional requirements

Token verify is stateless + cached JWKS (< 5 ms typical); the deny-list check is one Redis GET per request; the Management
API is low-traffic but strongly consistent + audited; webhook delivery is async with backpressure + DLQ; the Auth API scales
horizontally behind the pooler.

## 11. Testing strategy

- **Scope enforcement** negative suite (token rejected off-scope).
- **JWKS rotation** — tokens signed by `current` and `next` both verify during overlap; retired key rejected after window.
- **OAuth conformance** — code+PKCE, client-credentials, device, token-exchange happy + abuse paths; consent revoke kills the
  grant.
- **API keys** — shown-once, hash-at-rest, scope-enforced, immediate revoke, last-used tracked.
- **Webhooks** — signature verifies, retry/DLQ on failure, SSRF-blocked on internal URLs.

## 12. Migration strategy & future enhancements

1. **Scope enforcement + deny-list alerting** (Phase 0/2) — small, high-leverage.
2. **Dual-key JWKS + KMS** (Phase 2) — the rotation foundation.
3. **OAuth server + client registry** (Phase 5) — enables everything third-party.
4. **API keys / service accounts / webhooks** (Phase 5) — the developer platform.
- **Future:** DPoP-bound public-client tokens, dynamic client registration (RFC 7591), CAEP transmitter, fine-grained
  authorization tokens (the separate IAM track).
