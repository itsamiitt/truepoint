---
title: "Platform Admin — Foundations: RBAC, JIT, Impersonation, Audit & Staff-Auth Hardening"
tab: "15 · Foundations & Security (cross-cutting)"
status: partial
last_audited: 2026-06-29
owner: platform-admin
---

# Platform Admin — Foundations & Security (Area 15, cross-cutting)

## 1. Executive Summary

This is the cross-cutting foundations document for the TruePoint Platform Admin console — the
controls every per-area tab (Tenants, Billing, Compliance, Audit Log, …) builds on rather than a
single nav tab. It covers six interlocking subsystems: (a) the **RBAC capability model** (five
staff roles, the `ROLE_CAPABILITIES` matrix in `@leadwolf/types`, `requireCapability` over
`requireStaffRole`, `GET /admin/me`, optimistic UI gating); (b) **JIT elevation** (`jit_elevations`,
`POST /admin/elevations`, atomic `FOR UPDATE SKIP LOCKED` consume, 10-min TTL, `ElevationRequiredError`
on sensitive actions); (c) **impersonation** (`impersonation_sessions`, start/end/active endpoints,
the 30-s-poll `ImpersonationBanner`); (d) the **platform-audit infrastructure** (`withPlatformTx`
atomic mutation+audit, the raw BYPASSRLS `platform_audit_log` table, the closed `platformAuditAction`
enum + `platformAuditCoverage.test.ts` drift guard); (e) the **middleware chain**
(`authn` → `platformAdmin` → `requireStaffRole`/`requireCapability`); and (f) **tenant isolation**
(`PLATFORM_READ_LIMIT=500`, keyset cursors, RLS deny-all + REVOKE on platform tables).

**Verdict: `partial`.** The authorization, audit, and isolation spine is genuinely
enterprise-grade and *compliant*: there is no unaudited privileged write path — every mutation runs
inside `withPlatformTx`, capabilities are re-resolved per request (no JWT-staleness on revoke), and
platform tables deny-all to `leadwolf_app`. But the headline user-facing capability —
**impersonation — does not actually grant access**: the scoped "login-as" token mint is deliberately
deferred (`impersonation.ts:83-85`), so today the flow records a consented session and renders a
banner only. Two further security controls are specced but unenforced: **peer-approval for JIT**
(the `approved_by_user_id` column exists; a rogue `super_admin` can self-service every elevation) and
**staff SSO/MFA/IP-allowlist** (IP is captured in audit, never enforced). The credit endpoint also
lacks an **Idempotency-Key**. This document audits what is built, benchmarks it against AWS/Okta/
Teleport/Salesforce privileged-access products, and lays out an implementation-ready, flag-gated
roadmap to close the gaps.

## 2. Current Implementation Audit

**Middleware chain (every `/api/v1/admin/*` route).** `authn`
(`apps/api/src/middleware/authn.ts`) verifies the access JWT via JWKS, enforces the revocation
deny-list (`isRevoked(claims.sid)`, fails open), and attaches `claims`. `platformAdmin`
(`platformAdmin.ts:9-18`) is the coarse gate — `claims.pa !== true → 403 not_platform_admin`; the
`pa` flag is server-set and rides the signed JWT, so it cannot be forged. `requireStaffRole(...)`
and `requireCapability(...)` (`requireStaffRole.ts:15`, `requireCapability.ts:15`) are the granular
layer: both resolve the **active** role from `platform_staff` via
`platformStaffRepository.getActiveRole(claims.sub)` on every request, so a revoked grant takes effect
immediately — there is no stale-JWT window. `super_admin` implies all.

**RBAC matrix.** `packages/types/src/staffCapability.ts` defines the closed `staffCapability` enum
(16 capabilities, e.g. `tenants:suspend`, `tenants:credits`, `impersonate:start`, `elevation:request`,
`audit:read`) and `ROLE_CAPABILITIES` (`staffCapability.ts:37-48`) binding `support`, `billing_ops`,
`compliance_officer`, `read_only` to their bundles; `super_admin` is handled separately (implies all,
`capabilitiesForRole`). `GET /admin/me` (`routes.ts:79-80`) returns `{ staffRole, capabilities }`;
the console consumes it via `useStaffMe()` (`apps/admin/src/lib/staffMe.tsx`) whose `canMaybe(cap)`
gives **optimistic** gating (`!loaded || has(cap)`) so an authorized action never flashes out.

**JIT elevation.** `jit_elevations` (`schema/platformOps.ts:50-69`) holds `action`, `reason`,
`target_tenant_id`, `status` (`active|consumed`), `expires_at`, `approved_by_user_id` (null in v1).
`POST /admin/elevations` (`elevations.ts:48-73`, gated `elevation:request`) mints a grant with
`JIT_ELEVATION_TTL_SECONDS = 600` (`jitElevationRepository.ts:13`), audited `elevation.grant`.
`GET /admin/elevations/active` lists the caller's live grants. The security-critical bit is
`jitElevationRepository.consume` (`jitElevationRepository.ts:58-78`): a single atomic
`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` so two concurrent gated actions can never
spend the same grant. Sensitive actions consume in-tx: `POST /tenants/:id/suspend` and
`POST /tenants/:id/credits` (`routes.ts:226-231`, `284-289`) call `consume(...)` and throw
`ElevationRequiredError("…")` → `403 elevation_required` (`packages/types/src/errors.ts:190`) when no
grant exists. Because the consume is composed *inside* the action's tx, a rejected action (overdraw
422) rolls the consume back and the grant stays live.

**Impersonation.** `impersonation_sessions` (`schema/platformOps.ts:29-40`) records
`staff_user_id`, `target_{tenant,workspace,user}_id`, `reason`, server-computed `expires_at`
(`IMPERSONATION_TTL_MINUTES = 30`, `impersonationRepository.ts:13`), `ended_at`, `ip` — **no token
material**. `POST /admin/impersonation` (`impersonation.ts:58-87`, gated `impersonate:start` =
`super_admin|support`) requires `reason` (min 5 chars via `impersonationStartSchema`) and is audited.
`DELETE /admin/impersonation/:id` resolves the target tenant first (un-audited owner read) so the
`.end` row is tenant-attributed symmetrically with `.start`, then ends inside `withPlatformTx`.
`GET /admin/impersonation/active` feeds `ImpersonationBanner` (30-s poll, fixed danger banner, one-click
End). **The token mint is deferred** (`impersonation.ts:83-85`, `platformOps.ts:9-10`): "login-as"
does not yet grant access.

**Audit infrastructure.** `withPlatformTx(actor, action, fn, target)`
(`packages/db/src/client.ts:121-137`) inserts the `platform_audit_log` row and runs `fn` in the
**same** transaction — both commit or both roll back. The base connection is the DB owner (BYPASSRLS),
so it reads across every tenant without dropping to `leadwolf_app`. `platform_audit_log` is a **raw**
table created in `bootstrapAdmin.ts:47-60` (and `rls/platform.sql`) — not Drizzle — append-only,
owner-written. The closed `platformAuditAction` enum (`platformAudit.ts:7-42`) plus
`platformAuditCoverage.test.ts` (PENDING→WRITTEN attestation) gate every audited mutation; cross-tenant
reads are recorded as `admin.list_*` strings, not enum mutations.

**Isolation.** Platform routes are not workspace-scoped; cross-tenant reads are bounded by
`PLATFORM_READ_LIMIT` (500) with keyset cursors and a `truncated` flag (`routes.ts:632`). Platform
tables are `ENABLE ROW LEVEL SECURITY` (not FORCE, so the owner writer stays exempt) with **no policy**
→ deny-all to `leadwolf_app`, reinforced by `REVOKE ALL … FROM leadwolf_app` in `applyMigrations.ts`
(`rls/platformOps.sql:31-33`).

> **Drift finding (real).** The impersonation routes write the action strings
> `admin.impersonate.start` / `admin.impersonate.end` (`impersonation.ts:65,100`), but the
> `platformAuditAction` enum defines `impersonation.start` / `impersonation.end`, which
> `platformAuditCoverage.test.ts:55-56` still lists as **PENDING**. The audit row is written, but its
> `action` is *not* a member of the closed vocabulary — the drift guard does not catch it because the
> guard only checks the enum, and `withPlatformTx`'s `action` parameter is typed `string`, not
> `PlatformAuditAction`. This is a correctness gap (see §6, §16).

## 3. Enterprise Benchmark Research

| Capability | TruePoint today | Enterprise benchmark |
|---|---|---|
| Impersonation ("login-as") | Session + consent banner recorded; **token NOT minted** — no actual access | Salesforce "Login As" grants a real, scoped, time-boxed user session with a banner and a full audit entry; the access is genuine, not advisory. |
| JIT elevation approval | Self-service; `approved_by_user_id` exists but unenforced | **Teleport** requires *multiple approvers* before privileges are granted; engineers request via Slack/Jira/PagerDuty and access expires automatically. **Okta Govern Admin Roles** supports multi-approval admin-role access requests with documented justification. |
| Break-glass | None beyond a future `admin.set_auth_enforcement` flag | **Teleport / StrongDM** ship dedicated break-glass accounts that are auditable and auto-revoked after use; access is closely monitored. |
| Session recording | None (no token → no session to record) | **StrongDM/Teleport** record every privileged session (SSH/RDP/K8s/console) with searchable playback for forensic review. |
| Audit retention | Append-only Postgres table, retention unspecified | **Salesforce Field Audit Trail (Shield)** retains up to **10 years**, archives to a `FieldHistoryArchive` big object after 18 months, tracks up to 60 fields/object. |
| Staff IAM (SSO/MFA) | Password login; `pa`/staff role only; IP captured not enforced | **Okta access certifications** run recurring multi-level reviewer campaigns to prevent privilege accumulation; admin roles support entitlement bundling without over-permissioning. |
| Customer transparency of staff access | `.start`/`.end` are tenant-attributed for a future customer staff-access log | Salesforce surfaces "Login As" events to org admins; OneTrust/Transcend-class tools notify data subjects of privileged access. |

These are named, citable gaps — TruePoint's authorization spine is comparable to these products, but
its *privileged-access lifecycle* (real impersonation, approval, recording, break-glass) is materially
behind.

## 4. Gap Analysis

| # | Gap | Severity | Where |
|---|---|---|---|
| G1 | Impersonation does not mint a token — "login-as" grants no access | Critical | `impersonation.ts:83-85` |
| G2 | JIT peer-approval unenforced — rogue `super_admin` self-services every elevation | Critical | `elevations.ts:5-6`, `jit_elevations.approved_by_user_id` |
| G3 | Staff SSO/MFA/IP-allowlist not enforced (IP captured, never checked); no break-glass | High | `authn.ts`, `bootstrapAdmin.ts` (no MFA) |
| G4 | Credit endpoint has no Idempotency-Key — a retried `POST /credits` double-applies | High | `routes.ts:273-302` |
| G5 | Impersonation audit action string off-enum (`admin.impersonate.*` vs enum `impersonation.*`) | Medium | `impersonation.ts:65,100` vs `platformAudit.ts:26-27` |
| G6 | `withPlatformTx` `action` is typed `string`, not `PlatformAuditAction` — bypasses the closed vocabulary at the type boundary | Medium | `client.ts:123` |
| G7 | No DB `CHECK` constraint on `platform_audit_log.action` (ADR-0032 §5 deferred); enum is type-level only | Medium | `bootstrapAdmin.ts:47-60` |
| G8 | Audit retention/export lifecycle (10-yr-class) unspecified | Medium | platform table has no retention policy |
| G9 | No tenant-facing staff-access log surface yet (the `.start/.end` tenant attribution is unused) | Low | n/a (consumer not built) |
| G10 | ADR-0031 tenant-less auth-event routing (`login.failure`, `mfa.*`) still PENDING | Low | `platformAuditCoverage.test.ts:54-65` |

## 5. Functional Improvements

### 5.1 Mint the scoped impersonation access token (the "login-as" that actually works)
- **Current state:** `POST /admin/impersonation` records a session + returns banner info; no token (`impersonation.ts:83-85`).
- **Problem:** The flagship support capability is inert — staff cannot actually act as a tenant user; the banner implies access that does not exist.
- **Enterprise best practice:** Salesforce "Login As" issues a real, scoped, time-boxed session bound to the target with a persistent banner and audit entry.
- **Recommended implementation:** Mint a short-lived JWT with `aud = target tenant/workspace/user`, `exp = session.expiresAt`, and an `imp_sid` claim = `impersonation_sessions.id`; the API resolves tenant scope from `imp_sid` (never the request body) and runs the impersonated request through `withTenantTx` for the target scope (RLS-enforced, *not* `withPlatformTx`). End/expiry revokes via the existing `isRevoked` deny-list keyed on `imp_sid`.
- **Expected impact:** Turns impersonation from advisory to functional; closes the single largest product gap.
- **Dependencies:** `@leadwolf/auth` token mint; `isRevoked` keyed on `imp_sid`; the customer staff-access log (5.3); security sign-off on read-only vs full scope.
- **Priority:** Critical

### 5.2 Enforce JIT peer-approval (close the self-service hole)
- **Current state:** `approved_by_user_id` exists, always null; grant is self-service (`elevations.ts:5-6`).
- **Problem:** A compromised or rogue `super_admin` mints and consumes its own elevation — there is no second human.
- **Enterprise best practice:** Teleport/Okta require ≥1 distinct approver before privileges activate.
- **Recommended implementation:** Add a `pending` status to `jit_elevations.status`; `grant` writes `pending`; a `POST /admin/elevations/:id/approve` (gated a new `elevation:approve` capability, `requireCapability`) sets `approved_by_user_id` and flips to `active` inside `withPlatformTx` (audited `elevation.approve`); `consume` only matches `status='active' AND approved_by_user_id <> staff_user_id`. Flag-gate behind `jit.peer_approval`.
- **Expected impact:** Removes the rogue-admin single-actor path for credit moves and suspends.
- **Dependencies:** new capability string + `ROLE_CAPABILITIES` edit; `platformAuditAction` enum add + coverage attest; feature flag.
- **Priority:** Critical

### 5.3 Tenant-facing staff-access log
- **Current state:** `.start`/`.end` rows are tenant-attributed but no customer surface reads them (G9).
- **Problem:** Customers cannot see when staff entered their org — a transparency/compliance expectation for enterprise CRM.
- **Enterprise best practice:** Salesforce surfaces Login-As events; OneTrust notifies on privileged access.
- **Recommended implementation:** A server-scoped `GET /api/v1/tenant/staff-access` (owner connection filtered to the caller's tenant) returning impersonation + audit rows where `tenant_id = caller's tenant`; render in `apps/web` settings.
- **Expected impact:** Audit transparency; supports SOC 2 / DPDP customer commitments.
- **Dependencies:** 5.1 (so entries are meaningful); `truepoint-security` review of which `metadata` to expose (never reasons verbatim).
- **Priority:** Medium

## 6. Backend Improvements

### 6.1 Type `withPlatformTx` action to the closed vocabulary
- **Current state:** `action: string` (`client.ts:123`); off-enum strings like `admin.impersonate.start` are accepted silently (G5, G6).
- **Problem:** The closed `platformAuditAction` contract is not enforced where rows are written; drift guard misses it.
- **Enterprise best practice:** Audit action taxonomies are validated at write time (CloudTrail event names are a closed set).
- **Recommended implementation:** Change the signature to `action: PlatformAuditAction` (keep a narrow `admin.list_*` read-string overload). Reconcile impersonation routes to `impersonation.start` / `impersonation.end`, move both enum values PENDING→WRITTEN in `platformAuditCoverage.test.ts`.
- **Expected impact:** Compile-time guarantee that every audited mutation uses a vetted action; drift guard becomes complete.
- **Dependencies:** touches every `withPlatformTx` call-site (mechanical); the coverage test.
- **Priority:** High

### 6.2 Add the DB `CHECK` on `platform_audit_log.action`
- **Current state:** No DB-level constraint; the enum is type-only (ADR-0032 §5 deferred, G7).
- **Problem:** A raw/owner write outside the typed path could insert an arbitrary action; defence-in-depth missing.
- **Enterprise best practice:** Append-only audit stores constrain their event vocabulary at the database.
- **Recommended implementation:** Add `ALTER TABLE platform_audit_log ADD CONSTRAINT … CHECK (action IN (…))` in `applyMigrations.ts`, generated from `platformAuditAction.options` so it cannot drift from the enum.
- **Expected impact:** Storage-level guarantee independent of the application layer.
- **Dependencies:** 6.1 first (so the enum and the strings agree); applyMigrations grants phase.
- **Priority:** Medium

## 7. Database Improvements

### 7.1 Add `status='pending'` + an approval index to `jit_elevations`
- **Current state:** `status` is `active|consumed`; only `jit_elevations_staff_action_status_idx` exists (`platformOps.ts:66-68`).
- **Problem:** Peer-approval (5.2) needs a `pending` lifecycle and an efficient "elevations awaiting my approval" query.
- **Enterprise best practice:** PAM grants model request→approve→active→consumed explicitly.
- **Recommended implementation:** Extend the `status` check to `pending|active|consumed`; add `index('jit_elevations_pending_idx').on(status, target_tenant_id)` for the approver queue; `bun generate`; add the deny-all/REVOKE follow-through (already covered for the table).
- **Expected impact:** Backs the approval workflow without table scans.
- **Dependencies:** 5.2; `schema/platformOps.ts` + migration.
- **Priority:** High

### 7.2 Retention/partitioning policy for `platform_audit_log`
- **Current state:** Unbounded append-only table, no retention class (G8).
- **Problem:** Grows indefinitely; no defined retention SLA; cross-tenant audit queries slow over time.
- **Enterprise best practice:** Salesforce Field Audit Trail retains 10 years and archives after 18 months.
- **Recommended implementation:** Monthly range partition on `occurred_at`; a retention-class entry (the engine's `retention_class_policies`, see `platformAuditCoverage.test.ts:43-46`) of e.g. 7 years; an archival sweep worker moving cold partitions to cheap storage.
- **Expected impact:** Bounded hot-set, defined compliance retention, faster keyset reads.
- **Dependencies:** retention engine; an `apps/workers` sweep job; Operations sign-off on SLA.
- **Priority:** Medium

## 8. API Improvements

### 8.1 Idempotency-Key on the credit endpoint
- **Current state:** `POST /tenants/:id/credits` has no idempotency guard (`routes.ts:273-302`).
- **Problem:** A retried request (operator double-click, proxy retry) double-applies the credit delta — a money bug.
- **Enterprise best practice:** Stripe requires an `Idempotency-Key` on every mutating money call; the result is cached and replayed.
- **Recommended implementation:** Require an `Idempotency-Key` header; store `(key, actor, request-hash) → response` in a small `platform_idempotency` table written in the same `withPlatformTx`; replay the stored response on a duplicate key. Extend to `suspend`/`plan` later.
- **Expected impact:** Eliminates duplicate credit moves and suspends under retry.
- **Dependencies:** new `platform_idempotency` table (schema + RLS deny-all + REVOKE); shared middleware.
- **Priority:** High

### 8.2 `403 elevation_required` discoverability + `elevations/pending` endpoint
- **Current state:** Sensitive actions 403 with `elevation_required` but the console has no inline "request elevation" affordance; no approver queue endpoint.
- **Problem:** Operators hit a dead-end 403; approvers (5.2) have nowhere to see pending requests.
- **Enterprise best practice:** Teleport surfaces the request inline and routes it to approvers.
- **Recommended implementation:** Return the required `action` in the RFC 9457 envelope (already carried by `ElevationRequiredError`); add `GET /admin/elevations/pending` (gated `elevation:approve`) for the approver queue.
- **Expected impact:** Smooth step-up UX; backs the approval workflow.
- **Dependencies:** 5.2, 7.1.
- **Priority:** Medium

## 9. Dependency Mapping

- **DB tables:** `platform_audit_log` (raw, BYPASSRLS, append-only); `jit_elevations`,
  `impersonation_sessions`, `support_notes`, `account_holds`, `announcements`, `retention_policies`,
  `credit_packs`, `plan_templates` (all `schema/platformOps.ts`, deny-all to `leadwolf_app`);
  `platform_staff`, `users` (`is_platform_admin`, `is_bootstrap_admin`). New: `platform_idempotency`,
  partitioned `platform_audit_log`.
- **Services / repositories:** `jitElevationRepository` (grant/consume/listActive),
  `impersonationRepository` (start/end/getTargetTenant/listActive), `platformStaffRepository.getActiveRole`,
  `platformAdminWriteRepository` (adjustCredits/applyPlan/suspend), `withPlatformTx`/`withTenantTx`/
  `recordPlatformEvent` (`packages/db/src/client.ts`).
- **API endpoints:** `GET /admin/me`; `POST|GET /admin/elevations[/active]`;
  `POST|DELETE|GET /admin/impersonation[/:id|/active]`; the gated mutations
  `POST /tenants/:id/{suspend,credits,plan,holds,notes}`, `POST /users/:id/{deactivate,reactivate}`,
  `GET /admin/audit-log[/export]`.
- **Event flow:** request → `authn` → `platformAdmin` → `requireStaffRole`/`requireCapability` →
  handler → `withPlatformTx` (audit row + `fn` atomic) → optional `consume` (in-tx) → response.
- **Background workers:** none today; planned — audit-archival sweep (7.2), impersonation-session
  expiry reaper, elevation-expiry housekeeping.
- **Queue dependencies:** none today; archival sweep would use the standard `apps/workers` BullMQ/Redis.
- **Permission / capability dependencies:** `pa` JWT claim; `staffCapability` enum + `ROLE_CAPABILITIES`;
  `impersonate:start` (super_admin|support), `elevation:request` (super_admin|billing_ops),
  `tenants:credits|suspend|plan`, `audit:read`; new `elevation:approve`.
- **Feature-flag dependencies:** none wired today; planned — `jit.peer_approval`,
  `staff.auth_enforcement` (SSO/MFA/IP), `impersonation.token_mint`, `credit.idempotency`.
- **External integrations:** auth IdP / JWKS (`@leadwolf/auth`, `verifyAccessToken`, `isRevoked`);
  Redis (revocation deny-list); planned — staff IdP (Okta/Azure-AD) for SSO/MFA; KMS for any future
  token signing keys.
- **Cross-module dependencies:** `@leadwolf/types` (enums, schemas, errors); every per-area admin tab
  (Tenants, Billing, Compliance, Audit Log) consumes this spine; `apps/web` (planned staff-access log).

## 10. Security Review

**Strong, compliant baseline.** Default-deny at every layer (`pa` coarse gate → per-request granular
role/capability re-resolution; revoke is immediate). The `pa` flag is server-set on a signed JWT and
unforgeable. Every mutation is atomically audited (`withPlatformTx`), so there is **no unaudited
privileged write path**. Platform tables are RLS deny-all to `leadwolf_app` + REVOKE — a customer
connection sees zero staff rows. `expires_at` for both elevations and impersonation is server-computed
in SQL (`now() + …`), never client-supplied. The JIT `consume` is genuinely race-safe
(`FOR UPDATE SKIP LOCKED`, single statement).

**Open risks (security sign-off required).**
- **G1 — Impersonation token (deferred design spec):** mint a JWT `aud`=target, `exp`=`session.expiresAt`,
  `imp_sid`=session id; resolve scope from `imp_sid` only; default **read-only** scope, full scope behind
  an explicit step-up + reason; revoke on End via `isRevoked`. *Needs security decision on read-only vs full
  and a residency rule (doc 13 §8 Q3: may non-EU staff impersonate into EU tenants?). Do not build blind.*
- **G2 — Peer-approval (deferred):** see 5.2; until shipped, `super_admin` is a single point of total
  compromise for credit/suspend. *Doc 13 §8 Q2.*
- **G3 — Staff SSO/MFA/IP-allowlist (deferred):** the bootstrap admin logs in with a password and **no
  MFA** (`bootstrapAdmin.ts` sets `emailVerifiedAt`, no MFA). Spec: enforce SSO + mandatory MFA for any
  `is_platform_admin`, an IP allowlist checked in `platformAdmin` (the IP is already captured in audit),
  and a break-glass account that is auto-revoked and loudly alerted. *Needs infra (staff IdP) + a
  break-glass policy decision.*
- **G4 — Idempotency on credits:** money double-apply under retry (see 8.1).
- **PII discipline:** `metadata.reason` is staff-authored free text and is *not* surfaced to tenants
  (audit viewer omits `metadata`, `platformAudit.ts:61`); keep it that way when building 5.3.

## 11. Performance Review

The hot path is two extra round-trips per admin request: `getActiveRole` (an owner read) in the
guard, then the `withPlatformTx` audit insert. Both are indexed/trivial and acceptable, but
`getActiveRole` runs **twice** when an endpoint composes `requireStaffRole` *and* `requireCapability`,
or when a sub-router and a route both gate — a redundant DB hit. Recommendation: memoize the resolved
role on the Hono context for the request lifetime (`c.set('staffRole', …)` is already set by both
guards — read it if present before re-querying). Cross-tenant reads are bounded by
`PLATFORM_READ_LIMIT=500` with keyset cursors (no offset scans), which is correct; the audit table will
need partitioning (7.2) before it grows large enough to slow `audit:read` keyset queries.

## 12. UX/UI Improvements

### 12.1 Capability render-gates everywhere (not just where convenient)
- **Current state:** `useStaffMe().canMaybe(cap)` exists; coverage across action buttons is uneven.
- **Problem:** Operators see buttons that 403 — a poor, confusing experience.
- **Enterprise best practice:** Okta/Salesforce hide actions the role cannot perform.
- **Recommended implementation:** Wrap every mutating control (`Suspend`, `Adjust credits`, `Impersonate`, `Approve elevation`) in `canMaybe(cap)`; show a disabled state with a tooltip rather than hiding entirely where discoverability matters. Keep the API authoritative.
- **Expected impact:** Fewer dead-end 403s; clearer role boundaries.
- **Dependencies:** `staffMe.tsx` (already shipped).
- **Priority:** High

### 12.2 Inline "request / step-up elevation" on a 403
- **Current state:** A sensitive action returns `403 elevation_required`; the console offers no recovery.
- **Problem:** The operator must know to go mint an elevation elsewhere.
- **Enterprise best practice:** Teleport prompts the request inline and shows time-to-grant.
- **Recommended implementation:** On `elevation_required`, open a dialog pre-filled with the `action` from the envelope; `POST /admin/elevations`; on approval (5.2) poll `GET /admin/elevations/active` and retry.
- **Expected impact:** Self-service step-up without leaving the task.
- **Dependencies:** 5.2, 8.2.
- **Priority:** Medium

### 12.3 Entity pickers + enum dropdowns
- **Current state:** Tenant/user IDs and action/role values are raw text in several admin dialogs.
- **Problem:** UUID-by-hand is error-prone; free-text actions invite the off-enum drift in G5.
- **Enterprise best practice:** Typed pickers for entities, closed dropdowns for enums.
- **Recommended implementation:** A shared tenant/user search picker (returns the UUID) and dropdowns sourced from `staffCapability.options` / `platformAuditAction.options` / role lists.
- **Expected impact:** Fewer operator errors; aligns UI with the closed vocabularies.
- **Dependencies:** `@leadwolf/ui` combobox; `@leadwolf/types` enums.
- **Priority:** High

## 13. Automation Opportunities

- **Expiry reapers:** background jobs to mark expired `impersonation_sessions` (already filtered by
  `expires_at` in `listActive`, but an explicit reaper keeps the table tidy and feeds alerting) and
  housekeep stale `active` elevations.
- **Coverage attestation in CI:** `platformAuditCoverage.test.ts` already fails on drift — extend it to
  assert every `requireCapability(...)` string is a real `staffCapability` member, and every
  `withPlatformTx(action)` literal is a `platformAuditAction` member (would have caught G5).
- **Auto-revoke break-glass:** once break-glass exists (G3), a job that revokes and alerts on any
  break-glass login within N minutes.
- **Anomaly detection on audit stream:** flag bursts of `credit.grant`/`tenant.suspend` by one actor.

## 14. Monitoring & Logging

`platform_audit_log` is the system of record for *who did what*. Add: (1) emit a structured metric per
audited action (`platform.audit.{action}`) for dashboards and rate alerts; (2) alert on
`elevation_required` 403 spikes (mis-scoped operators) and on any `staff.login.failure` /
`mfa.failure` once those land (currently PENDING, G10); (3) a "privileged-action" Datadog monitor on
`credit.adjust`, `tenant.suspend`, `impersonation.start` with a notification to a security channel; (4)
ship `platform_audit_log` to an immutable, longer-retention sink (CloudTrail/Datadog-class) so the
operational DB copy is not the only record. The `ip` column is captured today but not surfaced in any
alert — wire it into the privileged-action monitor.

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Staff believe impersonation grants access (it doesn't) | High | High | Ship 5.1, or relabel the banner as "session opened (no access)" until then |
| Rogue/compromised `super_admin` self-approves credit/suspend | Medium | Critical | 5.2 peer-approval; G3 MFA; anomaly alerting (§13) |
| Retried credit POST double-applies money | Medium | High | 8.1 Idempotency-Key |
| Off-enum audit action escapes the closed vocabulary / CHECK | Medium | Medium | 6.1 + 6.2 + §13 CI attest |
| Audit table grows unbounded, slows `audit:read` | Medium | Medium | 7.2 partition + retention |
| Bootstrap admin password-only login compromised | Low | Critical | G3 staff SSO + mandatory MFA |
| Token mint, built without scope decision, over-grants | Low | Critical | Security sign-off on read-only-default (§10) before building |

## 16. Technical Debt

- **G5/G6:** `withPlatformTx` action is `string`; impersonation writes `admin.impersonate.*` while the
  enum says `impersonation.*` and the coverage test still lists those PENDING — fix together (6.1).
- **Dual `getActiveRole`:** redundant role resolution when two guards stack (§11).
- **ADR-0032 §5 deferred:** no DB `CHECK` on `platform_audit_log.action` (6.2).
- **ADR-0031 PENDING vocabulary:** `login.failure`, `mfa.*`, `staff.login*` defined but unwired (G10).
- **`requireStaffRole` vs `requireCapability` coexistence:** the two guards are interchangeable mid-
  migration (`requireCapability.ts:5-7`); finish the migration to capabilities so there is one gate shape.
- **Naming:** `retention_policies` (13a) vs `retention_class_policies` (data-mgmt) collision was resolved
  by rename (`platformAuditCoverage.test.ts:43-45`) — keep the two distinct in any new work.

## 17. Multi-Phase Implementation Plan

### Phase 1 — Correctness & UX quick wins (Critical/High)
- **Objectives:** Eliminate the money-retry bug, the off-enum audit drift, and dead-end 403s; tighten UI gating.
- **Scope:** 8.1 Idempotency-Key on credits; 6.1 type `withPlatformTx` action + reconcile impersonation strings; 12.1 capability render-gates; 12.3 entity pickers + enum dropdowns; §13 CI attest extension.
- **Deliverables:** `platform_idempotency` table + middleware; typed audit action; PENDING→WRITTEN for `impersonation.*`; gated UI controls; CI guard.
- **Technical tasks:** schema + RLS deny-all + REVOKE for idempotency table; signature change across call-sites; `staffMe` gating audit; combobox wiring.
- **Risks:** mechanical call-site churn; idempotency replay edge cases.
- **Dependencies:** none external.
- **Testing requirements:** duplicate-key replay test; isolation test for the new table; coverage-test green; capability-gate snapshot tests.
- **Estimated complexity:** Medium.
- **Success criteria:** a retried credit POST is a no-op replay; no `withPlatformTx` literal is off-enum; CI fails on a stray capability/action string.

### Phase 2 — Privileged-access depth: impersonation token + JIT peer-approval (Critical)
- **Objectives:** Make impersonation grant real, scoped access; require a second human for elevations.
- **Scope:** 5.1 token mint (read-only default); 5.2 + 7.1 + 8.2 peer-approval (`pending` status, `elevation:approve`, approver queue); 5.3 tenant staff-access log.
- **Deliverables:** scoped impersonation JWT (`aud`/`exp`/`imp_sid`), revoke-on-End; approval endpoints + capability; `apps/web` staff-access surface.
- **Technical tasks:** `@leadwolf/auth` mint + `isRevoked` keyed on `imp_sid`; route the impersonated request through `withTenantTx` (target scope) not `withPlatformTx`; `jit_elevations` status + index; new capability in `ROLE_CAPABILITIES`; new audit enum values + attest.
- **Risks:** over-scoping the token; approval workflow deadlocks; residency (EU) constraints.
- **Dependencies:** **security sign-off** (read-only vs full, doc 13 §8 Q2/Q3); Phase 1 (typed actions).
- **Testing requirements:** token-scope isolation test (impersonated request cannot escape target tenant); race test that one approver ≠ requester; revoke-on-End test.
- **Estimated complexity:** High.
- **Success criteria:** an impersonated request reads only the target tenant under RLS; a credit move requires a distinct approver; the target tenant sees the access in its log.

### Phase 3 — Staff-auth hardening (flag-heavy, security-gated) (High/Medium)
- **Objectives:** Bring staff identity to enterprise IAM parity; add break-glass; close audit retention.
- **Scope:** G3 staff SSO + mandatory MFA + IP-allowlist enforcement (in `platformAdmin`); break-glass account with auto-revoke + alert; 6.2 DB `CHECK` on audit action; 7.2 audit retention/partition + archival worker; §14 monitoring; G10 wire `login.failure`/`mfa.*`.
- **Deliverables:** staff IdP integration; `staff.auth_enforcement`, `staff.ip_allowlist` flags; break-glass runbook; partitioned audit table + sweep; privileged-action Datadog monitors.
- **Technical tasks:** IdP wiring; IP check using the already-captured request IP; `CHECK` generated from `platformAuditAction.options`; range-partition migration; BullMQ archival job.
- **Risks:** locking staff out (IP/MFA misconfig) — needs a vetted break-glass before enforcing; IdP dependency.
- **Dependencies:** **infra (staff IdP), KMS for any signing keys, Operations + security sign-off**; Phases 1–2.
- **Testing requirements:** enforcement-flag on/off tests; break-glass auto-revoke test; partition pruning test; alert-fires test.
- **Estimated complexity:** High.
- **Success criteria:** every `is_platform_admin` login requires MFA via the staff IdP; off-allowlist IPs are rejected; break-glass use auto-revokes and pages; audit retention SLA enforced.

## 18. Final Recommendations

1. **Ship Phase 1 immediately (High):** the Idempotency-Key on credits (real money bug, 8.1) and the typed audit action reconciling the `admin.impersonate.*` drift (6.1) are small, mechanical, and high-value. — *Current state:* money double-apply + off-enum audit; *Problem:* correctness; *Enterprise best practice:* Stripe idempotency, closed CloudTrail vocabulary; *Recommended implementation:* §8.1, §6.1; *Expected impact:* removes two classes of silent error; *Dependencies:* none; *Priority:* High.
2. **Do not ship the impersonation token without a security decision (Critical):** default to **read-only** scope, `exp = session.expiresAt`, scope resolved from `imp_sid` only, revoke-on-End — but get §10 sign-off (read-only vs full, EU residency) first. — *Priority:* Critical.
3. **Enforce JIT peer-approval before relying on the audit trail as a deterrent (Critical):** the trail records a rogue `super_admin`'s self-service elevation but does not prevent it; 5.2 adds the missing second human. — *Priority:* Critical.
4. **Treat staff-auth hardening as its own flag-gated phase (High):** SSO + mandatory MFA + IP-allowlist + break-glass need infra and a lockout-safe rollout; never enforce without a vetted break-glass account. — *Priority:* High.
5. **Operationalize the audit stream (Medium):** ship `platform_audit_log` to an immutable longer-retention sink, partition the hot table, and add privileged-action alerts on `credit.adjust`/`tenant.suspend`/`impersonation.start`. — *Priority:* Medium.

This document is the consolidated cross-cutting roadmap that the per-tab §17 plans roll up into:
Phase 1 (correctness/UX quick wins) precedes each tab's depth work; Phase 2/3 (privileged-access depth
and the flag-heavy security phase) are sequenced last and gated on security sign-off.
