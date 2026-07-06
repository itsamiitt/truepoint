# 03 — Authentication Architecture

> Document 3 of 12 · TruePoint Centralized Authentication Platform. Reads on from the audit (doc 01). Defines the **target
> architecture** for `auth.truepoint.in` as the single IdP for every TruePoint surface. Canonical decisions are inherited
> from the ADRs (0016/0017/0018/0019/0020/0030/0031/0034/0040/0043/0045) and extended here for the centralized platform.

## Executive summary

TruePoint already has the right architectural spine: a **dedicated IdP** (`apps/auth`) that is the only minter of identity,
a **stateless verifier** (`apps/api`) that trusts nothing but a JWKS-verified token plus a per-request revocation check, and
**database-enforced tenancy** (RLS) so isolation is a property of the platform, not of developer discipline. This document
keeps that spine and adds the four things a centralized, configurable IdP needs that TruePoint lacks today:

1. an **effective-policy engine** — a declarative config layer (platform default → org override → workspace override) that
   makes every auth behaviour admin-configurable without a code change;
2. a **pluggable method/provider registry** — login methods and SSO providers as data, resolved at runtime;
3. an **auth event backbone** — a transactional outbox that feeds webhooks, SIEM export, and cross-service revocation
   (CAEP-shaped); and
4. **operational hardening of the token/session core** — dual-key JWKS rotation, KMS custody, deny-list observability, and
   concurrent-session limits (closing `AUTH-013/042/066/072`).

Everything here is designed to serve millions of users across pooled and (for enterprise) siloed tenants, with the queues,
caching, HA, and DR posture that a `truepoint-platform` service tier requires.

## 1. Architectural principles (canonical, inherited)

| # | Principle | Source | What it fixes |
|---|---|---|---|
| P1 | **The IdP is a standalone origin; only it mints identity.** Credentials, sessions, and tokens live only on `auth.truepoint.in`. | ADR-0016 | One blast-radius for credential handling; apps hold no long-lived secret. |
| P2 | **Apps get a single-use, bound code exchanged for a short-lived token.** 60 s PKCE+IP+origin-bound code → ~15-min EdDSA JWT; token in memory only. | ADR-0016 | No token in URL/history; no refresh token in JS (extension is a scoped exception, ADR-0045). |
| P3 | **One global identity; membership is separate.** Global `users` (unique email/username) + `tenant_members`; identifier-first routing by verified email domain. | ADR-0017/0019/0020 | Multi-org users; enterprise domain claim; deliberate existence-reveal, throttled. |
| P4 | **Policy is strictest-wins across two scopes; roles are three orthogonal tiers.** | ADR-0018/0030 | Org can only tighten platform defaults; never one role enum. |
| P5 | **The durable session row is the source of truth; the token is a 15-min projection.** Role derived per-request. | ADR-0040 | Immediate role changes; revocation via session, not token expiry. |
| P6 | **Auth audit splits tenant-resolved → `audit_log` vs tenant-less → `platform_audit_log`.** Append-only, deny-all to `leadwolf_app`. | ADR-0031/0032 | Reconstructable identity history; tamper resistance. |
| P7 | **Platform admin = signed `pa` claim + `withPlatformTx` audited owner path.** | ADR-0011/0034 | Cross-tenant access is always audited and RLS-owner-scoped. |
| P8 | **New client classes onboard via the companion-window / system-browser pattern**, never by embedding credentials. | ADR-0045 | Extension today; mobile next (AUTH-043). |

**New principles this platform adds:**

- **P9 — Auth behaviour is configuration, not code.** Every method, policy, callback, template, and limit resolves from a
  versioned config store with an *effective-value* API. (Builds on `docs/planning/29-settings-administration-architecture.md`.)
- **P10 — Lockout-capable controls ship default-OFF, staged, with break-glass.** Observe → soft-fail → enforce; a documented,
  audited owner local-login path always exists (register Part 2).
- **P11 — Every new surface passes its named threat gates before enablement** (doc 09): SSRF-guarded metadata/JWKS fetch,
  open-redirect allowlists, mass-assignment allowlists, session-fixation rotation, CSP no-regression.

## 2. Service topology

```
                          ┌─────────────────────────────────────────────┐
   Browser (app./admin.)  │           auth.truepoint.in  (apps/auth)     │
   Extension (chrome-ext) │  Next 15, basePath /auth  — THE IdP          │
   Mobile (future)        │  • login/mfa/sso/org/workspace screens       │
        │  code/cookie     │  • /token/{exchange,refresh}  • JWKS         │
        ▼                  │  • /account/security (self-service)          │
   ┌──────────┐  verify    │  • /extension/{mint,refresh,logout}          │
   │ app./adm.│──────────► │  • effective-policy + method/provider registry│
   │  (SPA)   │  JWKS      └───────┬──────────────┬───────────────┬───────┘
   └────┬─────┘                    │              │               │
        │ Bearer JWT               │ withTenantTx │ Redis         │ outbox
        ▼                          ▼              ▼               ▼
   ┌──────────┐  authn+tenancy  ┌────────┐   ┌────────┐    ┌──────────────┐
   │ api.     │────────────────►│Postgres│   │ Redis  │    │ apps/workers │
   │(apps/api)│  RLS GUC        │  RLS   │   │deny-list│   │ email·dns·   │
   │ Hono/Bun │                 │        │   │ rate·  │    │ deprovision· │
   └──────────┘                 └────────┘   │ policy │    │ tokenRefresh │
     stateless verifier                      └────────┘    │ webhooks·SIEM│
                                                           └──────────────┘
```

- **`apps/auth`** — the IdP. Owns screens, `/token/*`, JWKS, `/account/security`, `/extension/*`, and (new) the
  effective-policy + registry services. Scales horizontally behind the pooler; stateless except for Redis + Postgres.
- **`apps/api`** — stateless verifier + business API. Never mints tokens; verifies + revocation-checks + sets RLS GUCs.
- **`apps/web` / `apps/admin`** — presentation clients holding an in-memory access token; silent-refresh against the IdP.
- **`apps/extension`** — MV3 public client; scoped-audience token via companion window (ADR-0045).
- **`apps/workers`** — BullMQ consumers for everything slow/fan-out/external: transactional email (new), DNS-TXT domain
  verification, SCIM deprovision fan-out, token-refresh sweep, webhook delivery, SIEM export.
- **Postgres** — one shared RLS-enforced schema (pooled); enterprise tenants route to dedicated clusters (target).
- **Redis** — revocation deny-list, rate-limit counters, policy cache, cross-domain code store, PKCE/connect state.

## 3. The authentication flow (sequence)

```mermaid
sequenceDiagram
    participant U as User
    participant App as app.truepoint.in (SPA)
    participant IdP as auth.truepoint.in
    participant API as api.truepoint.in
    participant DB as Postgres
    participant R as Redis

    U->>App: open protected route
    App->>App: mint PKCE (verifier,challenge,state) → sessionStorage
    App->>IdP: 302 /auth/login?app_origin&code_challenge&state
    IdP->>IdP: isAllowedOrigin(app_origin) && code_challenge  (per step)
    U->>IdP: identifier → (password | magic | passkey | SSO)
    IdP->>IdP: resolveNextStep → mfa | org | workspace | complete
    IdP->>DB: finalizeLogin: authorizeTenantSelection, getRoleForUser, policy checks
    IdP->>DB: create durable user_session (refresh hash)
    IdP->>R: store single-use code (PKCE+IP+origin bound, 60s)
    IdP-->>App: 302 {app_origin}/auth/callback?code&state  + Set-Cookie lw_refresh
    App->>IdP: POST /auth/token/exchange {code, verifier}  (CORS-gated)
    IdP->>R: GETDEL code; validate binding
    IdP-->>App: { access_token }  (EdDSA, 15m, aud=app_origin)  — in memory only
    App->>API: GET /api/v1/... Authorization: Bearer <jwt>
    API->>IdP: verify vs JWKS (iss/aud pinned)
    API->>R: isRevoked(sid)?  (per request)
    API->>DB: withTenantTx(tid,wid) → RLS-scoped query
    API-->>App: 200 data
```

## 4. The authorization flow

Authorization is **two independent gates that both must pass**, enforced on the server:

1. **Permission (RBAC).** Three orthogonal role tiers, each derived per-request, never a single enum:
   - `workspace_members.role` — within a workspace;
   - `tenant_members.org_role` — `owner | billing_admin | security_admin | compliance_admin | member` (ADR-0030);
   - `platform_staff.staff_role` — `super_admin | support | billing_ops | compliance_officer | read_only`.
   Middleware: `requireRole | requireOrgRole | requireStaffRole | requireCapability | platformAdmin`. The `pa` super-admin
   bit is the one claim carried in-token (target: session-revoke on demotion — AUTH-072).
2. **Data scope (RLS).** `withTenantTx` sets `app.current_tenant_id` / `app.current_workspace_id` GUCs from **verified claims
   only**; policies key off them with fail-closed `NULLIF(current_setting(...,true),'')`. A query that forgets its filter
   returns nothing. Privileged paths use `withPlatformTx` (audited, owner role) — never `leadwolf_app` with RLS disabled.

**Future (AUTH-045, separate IAM/RBAC track):** data-driven custom roles + field-level permissions are out of scope for this
auth plan; auth surfaces returning PII apply per-role response shaping in the meantime (AUTH-054).

## 5. Identity lifecycle

```
provision → verify → (enroll MFA) → active ⇄ (SSO/SCIM sync) → suspended → deprovisioned → purged
```

- **Provision:** self-signup (`registration.ts provisionIdentity`), invitation (`invitations.ts`), SSO JIT
  (`sso/jit.ts`), or SCIM `POST /Users`. One global `users` row; membership via `tenant_members`.
- **Verify:** email verification token; identifier-first domain routing decides SSO vs local.
- **Sync:** SCIM (Users today; Groups + group→role mapping is net-new, doc 07) keeps membership + role in step with the
  customer directory; deprovision revokes membership **and all sessions** (target: instant, not ≤15-min — AUTH-066).
- **Suspend/deprovision:** revoke sessions + deny-list; reassign owned records (don't orphan) per `enterprise-iam.md`.
- **Purge:** DSAR/retention of auth artifacts (AUTH-014) — the immutable-audit-vs-erasure tension is resolved in doc 09/10.

## 6. Session lifecycle

The durable `user_sessions` row is authoritative. Target lifecycle (● = new/hardened vs today):

| Event | Effect |
|---|---|
| Login | create session (refresh hash, absolute+idle caps from effective policy), issue code |
| Token exchange | mint 15-min access JWT (aud = app origin) |
| Refresh | rotate refresh atomically, deny-list old `sid`, re-derive role + `pa`; enforce absolute/idle caps |
| Reuse detected (outside 30 s grace) | **family revoke** all sessions for user |
| ● Concurrent limit hit | evict oldest or reject per policy `maxConcurrentSessions` (AUTH-042) |
| Switch org/workspace | rotate + deny-list old `sid` + membership re-check |
| Logout | revoke session + deny-list; ● fan-out to extension family (AUTH-016) |
| Password reset/change | revoke **all other** sessions + deny-list |
| MFA change | ● emit notification; (consider re-auth requirement) |
| Role change | immediate (per-request derivation) |
| ● `pa` demotion | session-revoke the user (close in-token residual — AUTH-072) |
| Deprovision (SCIM) | revoke all sessions; ● emit CAEP-style revocation signal |

## 7. Token lifecycle

- **Access token:** EdDSA JWT, `kid`-selected, `iss`/`aud` pinned, 15-min TTL, in memory only. Claims
  `sub, tid, wid?, sid, scope[], pa?`. **Target additions:** enforce `scope` at the API (AUTH-065), add `clockTolerance:30s`
  (AUTH-076), and consider `amr`/`acr` for step-up signalling (doc 09) and a `jti` if per-token revocation is ever needed.
- **Refresh token:** opaque `randomBytes(32)`, SHA-256 hash at rest, rotated every use, reuse-detected. 30-day absolute.
- **Cross-domain code:** 60 s, single-use `GETDEL`, PKCE+IP+origin bound.
- **JWKS:** **target dual-key publication** (`JWT_NEXT_*` slot) for overlapping-`kid` zero-downtime rotation; ~5-min cache
  (AUTH-013). Emergency-rotation runbook in doc 10.
- **At-rest secrets:** move `secrets.ts` off the dev-derived key onto a **KMS data key** with versioning for re-encrypt
  (AUTH-013).
- **Sender-constraining (evaluate, doc 10):** DPoP (RFC 9449) for the extension/mobile public clients to bind tokens to a key
  and blunt exfiltration — the single highest-leverage upgrade for the extension-scope risk beyond enforcing `scope`.

Reference token-lifetime table (rationale in doc 10): access 15 m · refresh 30 d (idle-capped) · code 60 s · magic/reset
15 m · email-verify 24 h · device-code 5 m · session absolute per-policy (default 12 h idle / 30 d absolute).

## 8. Event architecture

Auth is an **event producer**. Every material auth event (`login.success/failure`, `mfa.*`, `session.revoked`,
`user.provisioned/deprovisioned`, `role.changed`, `sso.*`, `password.*`) is written to a **transactional outbox** in the same
tx as the state change (building on the M-series event backbone / `event_outbox`). A relay drains the outbox to:

- **Webhooks** — signed (HMAC), SSRF-guarded outbound, at-least-once with retry/DLQ (reuses the M12 webhook infra pattern).
- **SIEM export** — customer audit-log streaming (AUTH-038).
- **CAEP / Shared Signals (target, XL)** — standardized cross-service revocation so a deprovision/compromise signal
  propagates to relying services faster than token expiry (AUTH-016 long-pole).

This decouples slow/fan-out work from the login request and gives enterprises the audit stream their questionnaires demand.

## 9. Queues, caching, scaling, HA/DR

- **Queues (BullMQ/Redis, `apps/workers`):** transactional email (new — removes inline send, AUTH-064), DNS-TXT domain
  verification (AUTH-041), SCIM deprovision fan-out, token-refresh sweep, webhook delivery, SIEM export, risk-signal scoring.
  Idempotent workers + DLQ.
- **Caching:** JWKS (~5 min, client-side in `createRemoteJWKSet`); **effective-policy** cache in Redis keyed by
  `(tenant, workspace, version)` with explicit invalidation on config write; deny-list is Redis-native; rate-limit counters
  Redis. Never cache a decision past a policy version bump.
- **Scaling:** IdP + API are stateless → scale horizontally behind an RDS-Proxy-class transaction pooler; reads on replicas
  where safe; the login path's only hot writes are session create/rotate (bounded, indexed on the live-hash partial-unique).
- **HA:** multi-AZ Postgres + Redis; the deny-list **fails open** by design (bounded ≤15-min residual) so a Redis blip
  degrades gracefully rather than locking everyone out — but the fail-open **must alert** (AUTH-066).
- **DR:** signing-key custody in KMS with an emergency-rotation runbook; session/audit backups; the durable-session
  source-of-truth means a Redis loss is recoverable (refresh re-establishes; deny-list re-warms).

## 10. Observability (pre-requisite for enforcement flips)

Before any lockout-capable control is flipped (P10), the platform must expose: login success/failure rates, MFA
challenge/enroll rates, refresh-reuse revocations, deny-list read/write errors (the fail-open signal), token-mint failures,
JWKS fetch health, SSO/SCIM error rates, and per-tenant auth SLOs (AUTH-012/022). Structured logs carry **no PII/tokens**.
Detail in doc 09 (security) and doc 10/12 (ops).

## 11. Config-driven design — the effective-policy engine (net-new)

The heart of "configure everything without code." A declarative store holds:

- **Method config** — which login methods are enabled, their per-method settings, priority, and org restrictions (doc 06);
- **Provider config** — SSO/OIDC/SAML connections per org (doc 07);
- **Policies** — password, MFA, session, IP/geo, risk (docs 05/09), stored as platform defaults + org/workspace overrides;
- **Callbacks/origins** — the allowed-origin and redirect allowlists (doc 08) as data, not just env;
- **Branding + email templates** — per-org (doc 04);
- **Rate limits + webhooks** — per-tenant knobs.

The **effective-value API** resolves `platform default → org override → workspace override` with **strictest-wins** for
security controls (an org can tighten but not loosen a platform minimum), returns a versioned decision, and is cached with
explicit invalidation. This subsumes today's `tenant_auth_policies` (which already does strictest-wins for a fixed set) and
generalizes it. Schema in doc 11; admin surface in doc 04.

## 12. Security considerations (architecture-level)

- **The stateless verifier must enforce `scope`, not just `aud`** (AUTH-065) — audience proves "may present a token," scope
  proves "may call this route."
- **Fail-open is acceptable only when observable and bounded** (AUTH-066); the ≤15-min residual must be stated in every
  "instant off-boarding" claim.
- **Config is attacker-relevant:** every effective-policy write is `withPlatformTx`-audited, staff-RBAC-gated, and cannot
  loosen a security minimum; a poisoned config is a lockout/escalation vector (P10/P11).
- **Metadata/JWKS/discovery/DNS fetches are SSRF-guarded** (AUTH-009) — the IdP makes outbound requests to
  customer-controlled URLs.
- **Key custody** moves to KMS; signing-key compromise has a rotation + deny-list runbook (AUTH-013, doc 10).

## 13. Risks & mitigations (architecture)

| Risk | Mitigation |
|---|---|
| Effective-policy engine becomes a single point of lockout | Default-OFF flips, staged rollout, break-glass owner login, config versioning + audit (P10) |
| JWKS rotation storms | Dual-key publish + overlap window + runbook (AUTH-013) |
| Redis outage widens revocation window silently | Fail-open **with alert** + short-TTL in-process fallback (AUTH-066) |
| Deny-list-only revocation misses in-token `pa` | Session-revoke on `pa` demotion (AUTH-072) |
| CDN in front breaks IP binding/rate limits | Env-driven trusted-hop count (AUTH-077) |
| Snapshot debt blocks clean migrations | Stitch Drizzle snapshots before net-new auth tables (doc 11) |

## 14. Future enhancements

Passkeys as primary (doc 05/09), DPoP-bound public-client tokens (doc 10), CAEP/SSF transmitter (doc 07/10), risk-adaptive
step-up (doc 09), dedicated-cluster tenant routing + region pinning for residency (doc 11), and a first-party mobile client
on system-browser PKCE (supersedes AUTH-043).
