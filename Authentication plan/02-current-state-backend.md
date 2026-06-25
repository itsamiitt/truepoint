# Current State — Backend Auth (`packages/auth`, `packages/db`)

This document is an as-built code review of TruePoint's backend authentication: the framework-agnostic
primitives in `packages/auth/src` and the schema, RLS policies, and repositories in `packages/db/src`. It
inventories what is actually wired versus what exists only as a typed seam, schema, or library function that
no production path reaches yet. Every TruePoint claim is anchored to a `file:line` reference; external and
standards claims carry a source URL. Status values are exactly one of: **Implemented | Partial | Stub |
Planned | Absent**.

The headline shape: the cryptographic core (Argon2id passwords, EdDSA JWT + JWKS, rotating refresh tokens
with reuse detection, the single-use cross-domain code, TOTP, AES-256-GCM secrets, Redis rate-limiting) is
**Implemented** and well-factored. The enterprise federation surface (real OIDC/SAML, SCIM endpoints,
auth-policy enforcement on the login path, additional MFA factors) is **designed but unbuilt** — present as
interfaces, schema, and config repositories, but the runtime path either throws, returns `false`, or simply
does not exist. The two are kept strictly separate below.

> **Two Phase-0 security items from the planning docs are already remediated** in the current tree. Item (2) —
> `platform_audit_log` "created without schema/migration and without RLS" — is fixed:
> `packages/db/src/rls/platform.sql:16-49` creates the table idempotently in the migrate flow, enables RLS
> (deny-all to `leadwolf_app`), and installs an append-only `BEFORE UPDATE OR DELETE` trigger;
> `packages/db/src/applyMigrations.ts:78` additionally `REVOKE ALL ON platform_audit_log FROM leadwolf_app`.
> Item (1) — the cross-tenant selector bypass — is also closed: `finalizeLogin` is guarded by
> `authorizeTenantSelection` (`packages/auth/src/flow.ts:144-145`) AND the org/workspace selector endpoints
> membership-check the client-supplied id first (`apps/auth/src/app/org/actions.ts:26`,
> `apps/auth/src/app/workspace/actions.ts:30`). This document reflects the code as-built; the
> `admin-auth-buildout-plan.md` still lists these only because it predates the fixes.

---

## 1. Passwords

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| Argon2id hashing | `packages/auth/src/password.ts:5,7` | Implemented | `@node-rs/argon2`, params `memoryCost=19_456 KiB (19 MiB), timeCost=2, parallelism=1` — matches the OWASP Argon2id guidance. |
| Verify, fail-closed on parse error | `packages/auth/src/password.ts:16-26` | Implemented | A thrown argon2 error (foreign/legacy digest, native binding fault) returns `false` (access denied) but logs the non-secret shape (`looksArgon2id`, `digestLen`) — never the digest or plaintext. |
| Uniform credential rejection (no enumeration) | `packages/auth/src/login.ts:19-21` | Implemented | Unknown user, no `passwordHash`, non-`active` status, and a wrong password ALL throw the same `InvalidCredentialsError`. |
| Password reset (digest replacement) | `packages/auth/src/passwordReset.ts:55-74`; `packages/db/src/repositories/userRepository.ts:117-119` | Implemented | `completePasswordReset` consumes the single-use reset token, re-hashes via `hashPassword`, and force-logs-out everywhere (§2). |
| Password column nullable for SSO/passkey-only | `packages/db/src/schema/auth.ts:50` | Implemented | `password_hash varchar(255)` nullable; `identifierLookup.ts:58-62` routes a no-password identity to `magic`. |

OWASP Argon2id parameter guidance (19 MiB, t=2, p=1): https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#argon2id

---

## 2. Sessions & Tokens (JWT / JWKS / refresh / revocation / code)

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| Durable session create | `packages/auth/src/session.ts:31-48` | Implemented | Mints a 24-byte session id + 32-byte refresh token; persists **only** the SHA-256 hash of the refresh token (`session.ts:12,40`). |
| Session rotation | `packages/auth/src/session.ts:51-75` | Implemented | Revokes old row, issues new row in the same family, then deny-lists the OLD `sid` (`markRevoked`) so its still-live access token dies immediately. |
| Single + global revocation | `packages/auth/src/session.ts:78-87` | Implemented | `revokeSession` and `revokeAllSessionsForUser` both mirror into the Redis deny-list. |
| Refresh-token reuse detection | `packages/auth/src/session.ts:99-123` | Implemented | A revoked token presented after a 30 s grace window triggers **family revocation** (`revokeAllSessionsForUser`); inside the grace window it is treated as a benign concurrent-refresh race. |
| Live-row partial-unique index on refresh hash | `packages/db/src/schema/auth.ts:189-191` | Implemented | `UNIQUE(refresh_token_hash) WHERE revoked_at IS NULL` — single-use among active sessions, keeps the hot silent-refresh lookup an index scan. |
| EdDSA access-JWT mint | `packages/auth/src/token.ts:43-62` | Implemented | Claims `sub`, `tid`, optional `wid`, `sid`, `scope`, optional `pa`; header `kid`; TTL `env.ACCESS_TOKEN_TTL_SECONDS` (~15 min per brief). |
| Access-JWT verify via remote JWKS | `packages/auth/src/token.ts:64-74` | Implemented | `apps/api` verifies against the published JWKS (`createRemoteJWKSet`), pinning issuer = public `AUTH_ORIGIN` and audience even when fetching keys over `INTERNAL_AUTH_ORIGIN`. |
| JWKS publication | `packages/auth/src/token.ts:77-80` | Implemented | Serves current public key as a JWK (`use:sig`, `alg:EdDSA`, `kid`); rotation = publish next key. |
| Signing-key boot self-test | `packages/auth/src/token.ts:88-103` | Implemented | `assertSigningKey` mints a throwaway token at boot; throws a secret-free error if the PEM is missing/mangled. |
| Silent refresh | `packages/auth/src/refresh.ts:18-56` | Implemented | Validates+detects reuse, re-checks user `active`, rotates session, re-mints carrying `pa`. |
| Single-use cross-domain code (Redis, GETDEL) | `packages/auth/src/code.ts:29-33,57-76` | Implemented | 32-byte code, `EX env.AUTH_CODE_TTL_SECONDS` (~60 s per brief), atomic `getdel` enforces single use. |
| Code binding validation (IP → origin → PKCE) | `packages/auth/src/code.ts:42-50` | Implemented | Pure, unit-testable; returns the first failing check as a non-secret reason. PKCE S256 via `s256` (`code.ts:35`). |
| Access-token revocation deny-list | `packages/auth/src/revocation.ts:23-48` | Implemented | Redis `revoked-sid:<sid>` keyed, TTL = access-token lifetime; `isRevoked` **fails OPEN** on Redis error by design (availability over the ≤15-min shortening). |
| `user_sessions` table | `packages/db/src/schema/auth.ts:162-193` | Implemented | Carries `tenant_id`/`workspace_id`/`device_id`/`refresh_token_hash`/`rotated_from`/`revoked_at`. Auth-service-owned; **no tenant RLS policy** (see §6). |

JWS EdDSA (Ed25519) per RFC 8037: https://www.rfc-editor.org/rfc/rfc8037 · PKCE S256 per RFC 7636 §4.2:
https://www.rfc-editor.org/rfc/rfc7636

---

## 3. MFA

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| TOTP verify | `packages/auth/src/mfa.ts:12-19` | Implemented | `@oslojs/otp` `verifyTOTP`, 30 s period, 6 digits; base32 secret decoded per attempt. |
| Recovery-code match (constant-time) | `packages/auth/src/mfa.ts:24-31` | Implemented | SHA-256 hashes compared with `timingSafeEqual`; returns the matched stored hash for the caller to mark consumed. **Note:** no recovery-code *table* or generation path is wired yet — `mfaVerify` only routes `totp` (see below). |
| Login-time MFA dispatch | `packages/auth/src/mfaVerify.ts:9-23` | Partial | Loads enrolled methods, decrypts secret, verifies. **Only `totp` is handled; every other method falls through to `return false`** (`mfaVerify.ts:22`). |
| MFA secret at rest | `packages/db/src/schema/auth.ts:195-206` | Implemented | `user_mfa_methods.secret_enc bytea`, AES-256-GCM (§7). `type` column allows `totp\|sms\|email\|webauthn` but only `totp` has a verify path. |
| MFA "is enrolled?" gate in login flow | `packages/auth/src/flow.ts:74-77` | Implemented | `resolveNextStep` routes to the `mfa` step when the user has any `verifiedAt` method. |
| SMS OTP verify | `packages/auth/src/mfaVerify.ts:22` | Stub | The `type='sms'` enum value exists and the login dispatcher *routes* it, but the branch falls through to `return false` (`mfaVerify.ts:16-22`) — a seam that returns a placeholder, not an absent capability. No OTP store / delivery path yet. |
| Email OTP verify | `packages/auth/src/emailVerification.ts:9`; `packages/auth/src/mfaVerify.ts:22` | Stub | The login dispatcher routes `type='email'` to the same `return false` seam (`mfaVerify.ts:22`). The email-token primitive *can already* mint an `email_otp` code (`emailVerification.ts:9`), but `mfaVerify` does not consume it as an MFA factor yet. |
| WebAuthn / passkey | `packages/auth/src/mfaVerify.ts:22` | Stub | The `type='webauthn'` enum value exists and is routed to the `return false` seam (`mfaVerify.ts:22`); no registration or assertion code is wired. |
| Trusted-device 30-day MFA skip | `packages/db/src/schema/auth.ts:208-224` | Stub | `trusted_devices` table (with `trusted_until`) exists but is **schema-only** — nothing in `flow.ts`/`mfaVerify.ts` reads or writes it. |

TOTP per RFC 6238: https://www.rfc-editor.org/rfc/rfc6238 · WebAuthn L2: https://www.w3.org/TR/webauthn-2/

---

## 4. SSO / Federation

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| Protocol-agnostic provider seam | `packages/auth/src/sso/types.ts:35-48` | Implemented | One `SsoProvider` interface (`initiate`/`validate`) abstracts OIDC and SAML; `SsoConfig`/`SsoAssertion`/`SsoInitiation` shapes defined. |
| Provider selection | `packages/auth/src/sso/providers.ts:44-47` | Implemented | `getSsoProvider`: non-production → mock; production → real adapter for the protocol. |
| Mock IdP (HMAC-signed assertion) | `packages/auth/src/sso/mockIdp.ts:23-62` | Implemented | Full handoff → assertion → validate path; HMAC over `BLIND_INDEX_KEY`, 5-min expiry, relay-state-bound. Never selected in production. |
| **Real OIDC adapter** | `packages/auth/src/sso/providers.ts:16-26` | **Stub** | `oidcProvider.initiate`/`validate` **throw** `"OIDC SSO is not configured: wire arctic …"`. `arctic` is an unwired seam. |
| **Real SAML adapter** | `packages/auth/src/sso/providers.ts:28-38` | **Stub** | `samlProvider.initiate`/`validate` **throw** `"SAML SSO is not configured: wire @node-saml/node-saml …"`. Unwired seam. |
| JIT provisioning | `packages/auth/src/sso/jit.ts:10-40` | Implemented | Maps asserted email → global identity (creates on first SSO login when `jitEnabled`), joins org + default workspace at `defaultRole`; idempotent. Enforces `sso_jit_disabled` `ForbiddenError` when JIT is off. |
| SSO transaction threading (Redis) | `packages/auth/src/ssoTransaction.ts:33-49` | Implemented | 10-min TTL; carries tenant, protocol, PKCE/return ctx, `relayState`/`providerState` for CSRF binding. |
| SSO identifier routing | `packages/auth/src/identifierLookup.ts:44-52` | Implemented | An SSO-enforced verified domain routes everyone (existing or first-time) to `sso` before the register branch. |
| `tenant_sso_configs` table | `packages/db/src/schema/auth.ts:226-244` | Implemented | Per-tenant; OIDC secret stored as `oidc_client_secret_enc bytea` (write-only). |
| SSO config repository (masked reads) | `packages/db/src/repositories/ssoConfigRepository.ts:23-46,50-118` | Implemented | `getForTenant` returns `hasClientSecret` boolean, never the bytes; upsert is RLS-scoped + audited in the same tx. |

**Net:** the SSO *plumbing* (interface, JIT, transaction, config persistence, mock) is wired end-to-end, but
**no real IdP can authenticate** — in production both adapters throw. This is the single largest backend gap.

`arctic` (OIDC client): https://arcticjs.dev/ · `@node-saml/node-saml`: https://www.npmjs.com/package/@node-saml/node-saml · OIDC Core 1.0: https://openid.net/specs/openid-connect-core-1_0.html

---

## 5. SCIM (provisioning tokens vs. endpoints)

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| `scim_tokens` table | `packages/db/src/schema/scim.ts:17-30` | Implemented | One bearer token per row, tenant-scoped; `token_hash` unique; `revoked_at` soft revoke; `last_used_at` "bumped by the SCIM auth path (WIRE-deferred)". |
| SCIM token repository (mint/list/revoke) | `packages/db/src/repositories/scimTokenRepository.ts:25-106` | Implemented | Plaintext generated + hashed in the API layer, shown once, never persisted; list is a **masked** projection (never `token_hash`); create + revoke audited in-tx. |
| `scim_tokens` RLS (FORCE) | `packages/db/src/rls/scim.sql:7-14` | Implemented | `ENABLE + FORCE` RLS, `USING/WITH CHECK tenant_id = GUC`, `GRANT … TO leadwolf_app`. |
| **SCIM 2.0 endpoints** (`/scim/v2/Users`, `/Groups`) | — | **Absent** | No SCIM route files anywhere under `apps/` (verified). The token exists; nothing consumes it. |
| Group → role mapping | — | Planned | No code; designed in the buildout plan. |
| Deprovisioning automation (revoke sessions / reassign records) | — | Planned | No code; `last_used_at` bump is explicitly WIRE-deferred (`schema/scim.ts:28`). |

SCIM 2.0 core (RFC 7644): https://www.rfc-editor.org/rfc/rfc7644 · SCIM schema (RFC 7643): https://www.rfc-editor.org/rfc/rfc7643

---

## 5a. Machine / API authentication (current state)

How `apps/api` authenticates **non-interactive** callers today. The only two machine-auth paths that
actually run are (1) the same bearer access-JWT a browser session carries and (2) SCIM provisioning
bearer tokens for directory sync. Everything an enterprise integration program normally also needs —
issued API keys / personal access tokens, OAuth2 client-credentials, signed outbound webhooks, mTLS —
is not built. This feeds the API-surface gaps tracked in docs 06/08.

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| Bearer access-token (JWT) auth on `apps/api` | `apps/api/src/middleware/authn.ts:11-27` | Implemented | The only request-time authenticator the API actually runs: `Authorization: Bearer <jwt>` → `verifyAccessToken` against the published JWKS (issuer/audience pinned), then the Redis revocation deny-list (`authn.ts:24`). The API **never mints** tokens (ADR-0016, `authn.ts:1-2`); it is a pure verifier. Non-interactive callers authenticate by presenting a token the auth IdP minted — there is no separate service-account credential type. |
| SCIM provisioning bearer tokens (directory sync) | `packages/db/src/schema/scim.ts:17-30`; `packages/db/src/repositories/scimTokenRepository.ts:25-106` | Partial | Tenant-scoped bearer tokens for an IdP's SCIM client: **mint/list/revoke only**. Plaintext shown once, only the SHA-256 hash persisted (`scimTokenRepository.ts:6-9`), list masked, create+revoke audited in-tx. Gap: `last_used_at` is WIRE-deferred (`schema/scim.ts:28`), and — per §5 — **no SCIM endpoint consumes the token yet**, so no request path actually authenticates with it today. |
| General API keys / personal access tokens (PAT) | — | Absent | No API-key or PAT table, mint path, hashing, or verification middleware anywhere under `apps/api/src` (verified). A programmatic caller has no first-class long-lived credential — it must carry a user access JWT. |
| OAuth2 client-credentials grant (service-to-service) | — | Absent | No `client_credentials` token endpoint or client registry; the IdP issues user-bound tokens only. |
| Outbound-webhook HMAC signing | — | Absent | No signing-secret store or signature-header emitter for events TruePoint sends to a customer endpoint; a receiver cannot verify authenticity/integrity. |
| mTLS for machine callers | — | Absent | No client-certificate trust store or verification at the API edge; transport auth is bearer-token-over-TLS only. |

---

## 6. Rate-limiting / bot / IP-binding

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| Identifier-step rate limit (per-IP + per-id) | `packages/auth/src/rateLimit.ts:20-35,58-61` | Implemented | IP 30/min, identifier 10/min; `consume` **fails OPEN** on Redis outage. |
| Credential-step brute-force lockout | `packages/auth/src/rateLimit.ts:73-135` | Implemented | 5 failures/identifier and 50/IP over a 15-min rolling window (`CRED_WINDOW=900`), with `blockDuration`; success clears the identifier counter. |
| Resource-API throttle | `packages/auth/src/rateLimit.ts:37-44,64-66` | Implemented | 120/min, keyed by subject (authenticated) or IP. |
| Cloudflare Turnstile bot check | `packages/auth/src/botCheck.ts:11-44` | Implemented (opt-in) | Disabled (returns `true`) when `TURNSTILE_SECRET` unset; **fail-closed** when set; 2.5 s `siteverify` timeout via `AbortController`. |
| Code IP-binding policy | `packages/auth/src/ipBinding.ts:16-41` | Implemented | `strict` / `prefix` (/24 v4, /64 v6) / `off`; normalizes bracketed, zone-id, and IPv4-mapped IPv6 forms before comparing. Consumed by `code.ts:46`. |

Cloudflare Turnstile siteverify: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ ·
`rate-limiter-flexible`: https://github.com/animir/node-rate-limiter-flexible

---

## 7. Tenancy, org/workspace switching & RLS

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| Two-tier scoped transaction (`withTenantTx`) | `packages/db/src/client.ts:47-67` | Implemented | `SET LOCAL ROLE leadwolf_app` (non-BYPASSRLS) + `set_config('app.current_tenant_id'/'app.current_workspace_id', …, true)` LOCAL to the tx (RDS-Proxy-safe). |
| Tenant-isolation RLS policies | `packages/db/src/rls/auth.sql:28-71` | Implemented | `workspaces`, `workspace_members`, `tenant_domains`, `tenant_sso_configs`, `tenant_auth_policies`, `tenant_members`, `invitations` keyed off the tenant GUC; `NULLIF(current_setting(...,true),'')` fails closed when unscoped. |
| Global-identity tables intentionally un-scoped | `packages/db/src/rls/auth.sql:73-78` | Implemented (by design) | `users`, `user_sessions`, `user_mfa_methods`, `trusted_devices`, `auth_email_tokens` are auth-service-owned, keyed by `user_id`, NOT tenant-RLS-scoped. **Consequence:** admin session reads must self-scope via a `workspace_members` join (see below). |
| Cross-tenant selection guard (pure) | `packages/auth/src/scopeGuard.ts:15-28` | Implemented | `authorizeTenantSelection` rejects a forged client-supplied `tenantId` not in the user's memberships (`tenant_forbidden`). |
| Guard applied at `finalizeLogin` | `packages/auth/src/flow.ts:144-145` | Implemented | The authoritative gate before the token mints. **Brief Phase-0 item 1 (verified covered):** `flow.ts` exposes `isActiveTenantMember`/`isActiveWorkspaceMember` (`flow.ts:108-122`) as the defence-in-depth helpers, and the selector call sites DO consume them — `selectOrg` calls `isActiveTenantMember` (`apps/auth/src/app/org/actions.ts:26`) and `selectWorkspace` calls `isActiveWorkspaceMember` (`apps/auth/src/app/workspace/actions.ts:30`), both rejecting a forged selection before `finalizeLogin` re-checks authoritatively. No live cross-tenant selector bypass found. |
| Workspace membership re-check at finalize | `packages/auth/src/flow.ts:162-178` | Implemented | A client-supplied `workspaceId` must yield a role within the resolved tenant or `workspace_forbidden`. |
| Workspace switch | `packages/auth/src/switchWorkspace.ts:26-76` | Implemented | Re-checks role within the session's tenant, rotates session, re-mints; never crosses tenants. |
| Org switch | `packages/auth/src/switchOrg.ts:22-74` | Implemented | Authorizes active membership in the target tenant, lands on remembered/default workspace, rotates + re-mints with new `tid`/`wid`/`pa`. |
| Org-role / staff-role schema | `packages/db/src/schema/auth.ts:65-108` (`tenant_members.org_role`, `platform_staff`); migration `0006_kind_tomorrow_man.sql:1,11` | Implemented | `tenant_members.org_role` and the `platform_staff` table exist with migrations and a unique index. |
| Org/staff role CHECKs + backfill | `packages/db/src/rls/platform.sql:57-72` | Implemented | DB-level `CHECK` on `org_role` (owner\|billing_admin\|security_admin\|compliance_admin\|member) and `staff_role` (super_admin\|support\|billing_ops\|compliance_officer\|read_only); idempotent backfill from legacy booleans. |
| `requireOrgRole` / `requireStaffRole` guards | `apps/api/src/middleware/requireOrgRole.ts:14-28`, `requireStaffRole.ts:15-28`; tests `roleGuards.test.ts` | Implemented | Request-time authorization guards live in **`apps/api`** (NOT `packages/auth`): `requireOrgRole` resolves `org_role` from `tenant_members` (RLS-scoped, `owner` implies all); `requireStaffRole` resolves the active role from `platform_staff` per-request (revoked grant takes effect immediately). Both 403 on insufficient role. The older "Planned/in `packages/auth`" note was a scoping artifact — the guards are built, just in the API app. |
| `requireWorkspaceRole` guard + workspace MEMBERS API | — | Absent | No `requireWorkspaceRole.ts` exists under `apps/api/src/middleware` (verified) and there is no workspace-members management API. This is the only remaining RBAC guard gap; a workspace-role coverage review is still owed. |
| `platform_staff` / `impersonation_sessions` deny-all to app role | `packages/db/src/rls/platform.sql:57`, `packages/db/src/rls/platformOps.sql`; `applyMigrations.ts:82,84` | Implemented | `ENABLE` RLS + no policy denies `leadwolf_app`; blanket grant additionally `REVOKE`d. |
| `platform_audit_log` lockdown (RLS + append-only + REVOKE) | `packages/db/src/rls/platform.sql:16-49`; `applyMigrations.ts:78` | Implemented | **Remediates brief Phase-0 item 2.** Table created in the migrate flow; RLS deny-all; `BEFORE UPDATE OR DELETE` append-only trigger for every role; app-role grant revoked. Written only via `withPlatformTx` (`client.ts:94-110`). |

---

## 8. Registration / verification / invitations

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| Identifier-first lookup | `packages/auth/src/identifierLookup.ts:28-63` | Implemented | Resolves email/username → identity; routes `sso\|password\|magic\|register`. **Deliberately reveals existence** (UX), gated upstream by Turnstile + rate-limit. |
| Email verification code (6-digit) | `packages/auth/src/emailVerification.ts:16-43` | Implemented | CSPRNG `randomInt`, hash = `sha256(purpose:email:code)` bound to the tuple, 15-min TTL; only the hash is stored (`userRepository.ts:386-424`). Purposes `verify\|magic_link\|email_otp\|reset`. |
| Registration / 3-way org placement | `packages/auth/src/registration.ts:49-115` | Implemented | First match wins: `auto_join` (verified domain) → pending `invitation` → `new_org`. Existence guards are specific (`username_taken`/`email_taken`) because registration reveals existence by design. |
| Invitations (create / accept) | `packages/auth/src/invitations.ts:24-70` | Implemented | 32-byte token, hash stored, 7-day default TTL; accept binds to the invitee's email (`email_mismatch` guard) and is an idempotent join. |
| Magic-link / passwordless | `emailVerification.ts` purpose `magic_link` (`:9`) + `identifierLookup.ts:62` | Implemented (primitive) | No dedicated `magic.ts`; magic login is the email-token primitive + the auth-origin screens. The verify primitive is wired; the screen orchestration lives in `apps/auth` (out of scope here). |
| Atomic single-use code consume | `packages/db/src/repositories/userRepository.ts:411-424` | Implemented | `consume` updates `consumed_at` only when unconsumed + unexpired, returning whether it matched. |

---

## 9. Policy resolution vs. enforcement

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| Strictest-wins policy resolution | `packages/auth/src/policy.ts:33-55` | Implemented | `resolveEffectivePolicy` intersects methods, ORs booleans, takes strictest MFA + min session timeout, tightens IP allowlist; `isMethodAllowed` honours `requireSso`/`disableSocial`. |
| `tenant_auth_policies` table + repo | `packages/db/src/schema/auth.ts:246-259`; `packages/db/src/repositories/authPolicyRepository.ts:25-83` | Implemented | Columns: `mfa_enforcement`, `allowed_methods`, `disable_social`, `require_sso`, `ip_allowlist`, `session_timeout_seconds`. Read returns a platform default when unset; upsert RLS-scoped + audited. |
| MFA-required enforcement on login | `packages/auth/src/flow.ts:152-160` | Partial | `finalizeLogin` throws `mfa_required` `ForbiddenError` when an un-enrolled user logs into a `required` tenant. The TODO at `flow.ts:150-151` notes the better UX (forced in-login enrollment) is unbuilt. |
| `allowedMethods` gate on login path | — | Absent | `resolveEffectivePolicy`/`isMethodAllowed` exist but **no login path calls them** to reject a disallowed method. |
| IP-allowlist enforcement on login | — | Absent | `ip_allowlist` resolves (`policy.ts:42`) but no login check rejects an out-of-range client IP. |
| Session-timeout enforcement | — | Absent | `session_timeout_seconds` resolves (`policy.ts:43-46`) but refresh/session TTLs use the global `env.REFRESH_TOKEN_TTL_SECONDS` (`session.ts:13`), not the per-tenant value. |

**Net:** policy is fully *resolvable* and *persisted*, but only the MFA-required leaf is *enforced* on the
login path. Allowed-methods, IP allowlist, and session timeout are resolved-but-not-gated.

---

## 10. Secrets & Audit

| Item | Where (`file:line`) | Status | Notes |
|---|---|---|---|
| AES-256-GCM secret-encryption **mechanism** | `packages/auth/src/secrets.ts:11-26` | Implemented | The at-rest cipher itself is built and in use: layout `iv(12) \| authTag(16) \| ciphertext`, fresh 12-byte IV per encrypt, GCM auth tag verified on decrypt. Protects TOTP secrets (`mfaVerify.ts:19`) and OIDC client secrets. |
| KMS-managed key **custody** (production) | `packages/auth/src/secrets.ts:8-9` | Partial | The running key is the **dev** derivation — `secrets.ts:9` computes `KEY = sha256(env.BLIND_INDEX_KEY)`. The "production injects a dedicated KMS data key" line at `secrets.ts:8` is an aspirational comment, **not** the executed path: no KMS client, envelope-wrap, or data-key fetch exists. So the encryption *mechanism* is Implemented but KMS-backed key custody in production is **not wired** — Partial. (This is the authoritative status; reconcile any "KMS-backed in prod / Implemented" claim elsewhere to it.) |
| Auth audit sink | `packages/auth/src/auditEvent.ts:10-28` | Implemented | `recordAuthEvent` wraps `auditRepository.insert` in its own `withTenantTx`; **swallow-on-failure** (logs `action` + error name only, never PII). Only tenant-resolved events reach here. |
| Audit action vocabulary | `packages/types/src/billing.ts:113-133`; `packages/db/src/repositories/auditRepository.ts:11-32` | Implemented | `login.*`, `mfa.*`, `password.reset.*`, `sso.*`, `token.*`, `session.revoked`, `code.*`, `device.*`, `signup`, `oauth.link`. The **canonical INSERT vocabulary** is the `auditAction` Zod enum (`packages/types/src/billing.ts:113-133`) — it is what every write must validate against; `auditRepository.ts:11-32` (`AUTH_AUDIT_ACTIONS`) is the auth-domain **read-filter subset** the Security view queries. The reset actions are exactly `password.reset.request` / `password.reset.complete` (`billing.ts:120-121`) — the past-tense `…requested`/`…completed` forms are not enum members and would fail validation. |
| Append-only audit enforcement | `packages/db/src/repositories/auditRepository.ts:1-3,68-70` | Implemented | Insert-only repo; UPDATE/DELETE blocked by a DB trigger (referenced in `rls/billing.sql`). |
| `login.success` emission | `packages/auth/src/flow.ts:217-240` | Implemented | Emitted off the critical path (`void Promise.allSettled`) — not awaited before the redirect, classed observational per ADR-0031. |
| Password-reset audit events | `packages/auth/src/passwordReset.ts:31,73` | Absent | `requestPasswordReset`/`completePasswordReset` carry explicit `TODO` comments — `password.reset.*` events are in the vocabulary but **not emitted**. |

NIST SP 800-38D (AES-GCM): https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf

---

## 11. Designed-but-unbuilt (backend), consolidated

Everything below has a type contract, schema, or interface present, but **no production runtime path**:

| Capability | Evidence it's designed | Status |
|---|---|---|
| Real OIDC adapter (`arctic`) | `packages/auth/src/sso/providers.ts:16-26` (throws) | Stub |
| Real SAML adapter (`@node-saml`) | `packages/auth/src/sso/providers.ts:28-38` (throws) | Stub |
| SCIM 2.0 endpoints + group→role + deprovisioning | `packages/db/src/schema/scim.ts:28` ("WIRE-deferred"); no route files | Absent / Planned |
| `allowedMethods` / IP-allowlist / session-timeout enforcement on login | `policy.ts:33-46` resolves; no login gate | Absent |
| Forced in-login MFA enrollment | `flow.ts:150-151` TODO | Planned |
| SMS OTP / Email OTP / WebAuthn MFA | `mfaVerify.ts:22` routes each `type` to a `return false` seam; schema `type` values exist | Stub |
| Trusted-device 30-day skip | `schema/auth.ts:208-224` schema-only | Stub |
| `requireWorkspaceRole` guard + workspace MEMBERS API | no `requireWorkspaceRole.ts` under `apps/api/src/middleware`; no workspace-members API | Absent |
| Recovery-code generation / storage / regeneration | `mfa.ts:24-31` matcher exists; no table or mint path | Stub |
| Password-reset audit events | `passwordReset.ts:31,73` TODO | Absent |

---

## 12. Notes & verification caveats

- **`platform_audit_log` (Phase-0 item 2)** is fixed in the current tree (`rls/platform.sql:16-49`,
  `applyMigrations.ts:78`) — grounded in the actual SQL, not the planning doc's stale description.
- **Selector-endpoint bypass (Phase-0 item 1)** is covered, not open. `finalizeLogin` is guarded
  (`flow.ts:145`) and the defence-in-depth helpers exist (`flow.ts:108-122`); the apps layer confirms coverage —
  `selectOrg` (`apps/auth/src/app/org/actions.ts:26`) and `selectWorkspace`
  (`apps/auth/src/app/workspace/actions.ts:30`) call those helpers and reject a forged client-supplied
  `tenantId`/`workspaceId` before completion. **No live cross-tenant selector bypass exists** in the current
  tree — item 1 is already remediated, matching item 2 (`platform_audit_log`). Both remain worth a regression test.
- **`session_timeout_seconds` enforcement**: no code reads it on the refresh/session path; were it enforced in
  `apps/api` middleware that would change the §9 status — out of scope here, so marked Absent with that caveat.
- **KMS at-rest key**: `secrets.ts` documents the production KMS-data-key intent but the code path that runs
  is the `BLIND_INDEX_KEY`-derived key. Marked Partial accordingly.
