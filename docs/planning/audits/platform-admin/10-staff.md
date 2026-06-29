---
title: "Platform Admin Audit — Staff & Access (RBAC) Tab"
tab: staff
status: fully-wired
last_audited: 2026-06-29
owner: platform-admin
---

## Executive Summary

The **Staff & Access (RBAC)** tab (`/staff`) is the root-of-trust surface of the TruePoint Platform Admin console: it is where platform-wide, cross-tenant authority is handed out and taken away. Everything else in the console — tenant suspend, credit adjust, impersonation, DSAR, audit-log read — derives its authorization from a `platform_staff` row written here. It is **fully-wired** but deliberately minimal: three endpoints (`GET /api/v1/admin/staff`, `POST /api/v1/admin/staff`, `DELETE /api/v1/admin/staff/:userId`) backed by `staffRepository.{list,grant,revoke}`, gated by the single most privileged capability in the system — `staff:manage` (super_admin only). Every mutation runs inside `withPlatformTx(...)` so the `platform_audit_log` row and the `platform_staff` write commit or roll back together. Revocation is correctly **fail-closed and stateless**: roles are resolved per-request by `platformStaffRepository.getActiveRole(...)` in `requireCapability`/`requireStaffRole`, so a revoke is effective on the next request — there is no stale-JWT window.

The RBAC core this tab manages is genuinely well-designed. Five roles (`super_admin`, `support`, `billing_ops`, `compliance_officer`, `read_only`) are expressed as capability *bundles* in `ROLE_CAPABILITIES` (`packages/types/src/staffCapability.ts`), checked through `roleHasCapability(...)` / `requireCapability(...)` rather than role-string `if`s scattered across endpoints. `/admin/me` reports the caller's capabilities so the console can render-gate UI it cannot perform — defence-in-depth, with the API remaining the boundary.

The gaps are not correctness gaps in the write path; they are **operational governance and IGA maturity** gaps. The grant form takes a **raw user UUID** with no search/picker, so granting platform authority is a copy-paste-a-GUID operation with no confirmation of *who* you are elevating. There is **no access-certification / recertification workflow** (no periodic "is this grant still needed?" review), **no peer-approval** on the grant itself (the `approved_by_user_id` seam exists elsewhere but staff grants are pure self-service by any super_admin), **no role-change history** per member, **no last-active / session view**, and **no bulk actions**. Two correctness-adjacent findings surfaced on inspection and are documented as defects below: (1) the staff audit actions `admin.grant_staff` / `admin.revoke_staff` / `admin.list_staff` are passed to `withPlatformTx` as **raw strings — they are NOT members of the `platformAuditAction` enum** (`packages/types/src/platformAudit.ts`) and therefore are *not* covered by the `platformAuditCoverage.test.ts` drift guard; (2) `POST /admin/staff` has **no `Idempotency-Key`**, so a double-submit re-stamps `grantedAt`/`grantedByUserId` (benign but audit-noisy). The deferred enterprise items — staff SSO/MFA/IP-allowlist (F2), peer-approval enforcement, access certification — are specified below as implementation-ready designs and flagged as needing security/infra sign-off; this audit does **not** claim they exist.

## Current Implementation Audit

**Frontend** (`apps/admin/src/features/staff/*`, 5 files, ~256 LOC):

| File | Role |
|---|---|
| `components/StaffPage.tsx` (~225 LOC) | The whole surface: grant form (`TpInput` user id + `TpSelect` role), `DataTable` (User / Role / Status / Granted / revoke action), `StateSwitch` four-state, revoke `Dialog` confirm |
| `api.ts` | The single data seam — `fetchStaff`, `grantStaff(userId, role)`, `revokeStaff(userId)` via `fetchWithAuth` against `/api/v1/admin/staff` |
| `hooks/useStaff.ts` | Vanilla-React `{staff, loading, error, reload}` load/reload hook — no TanStack Query |
| `types.ts` | `StaffRole` union, `STAFF_ROLE_OPTIONS` (the form's labelled options), `StaffMember` view shape — presentation mirrors of the shared `@leadwolf/types` Zod schemas |
| `index.ts` | Public barrel: `export { StaffPage }` |

The route mounts at `apps/admin/src/app/(shell)/staff/page.tsx`. Note the brief's claimed file split (`Page/api/hook/types/format`) is **stale**: there is no `format.ts`; date formatting (`shortDate`) and `statusTone` live inline in `StaffPage.tsx`. The grant form's role `<select>` *does* use a closed enum (`STAFF_ROLE_OPTIONS`), so the "enum dropdown" quick-win is already satisfied for role; the *user* field is the raw-ID gap.

**Backend** (`apps/api/src/features/admin/staff.ts`, 69 LOC) — `staffRoutes`, mounted under `/api/v1/admin/staff` (so authn + `platformAdmin` coarse `pa` gate already applied by the parent router):

| Method + path | Gate | Audit action | Repo call | Notes |
|---|---|---|---|---|
| `GET /` | `requireCapability("staff:manage")` | `admin.list_staff` (raw string) | `staffRepository.list(tx)` | directory: active **and** revoked, joined to `users`, newest first |
| `POST /` | `requireCapability("staff:manage")` | `admin.grant_staff` (raw string) | `staffRepository.grant(tx, userId, staffRole, actorSub)` | body = `grantStaffSchema` (UUID + role enum); upsert on `user_id` |
| `DELETE /:userId` | `requireCapability("staff:manage")` | `admin.revoke_staff` (raw string) | `staffRepository.revoke(tx, userId)` | sets `status='revoked'`, stamps `revoked_at` |

`requireCapability("staff:manage")` is applied once via `staffRoutes.use("*", ...)` — it covers all three routes, so even the *read* of the staff directory is super_admin-only. `actorOf(c)` derives the actor `{userId: claims.sub, ip: x-forwarded-for[0]}` server-side; the `granted_by` is the authenticated super_admin's `sub`, never client-supplied.

**RBAC core** (`packages/types/src/staffCapability.ts`, `packages/types/src/auth.ts`):
- `staffRole` enum (5 roles) — `auth.ts:35`.
- `staffCapability` enum — 16 entity:action capabilities (`staff:manage`, `tenants:credits`, `impersonate:start`, `audit:read`, …).
- `ROLE_CAPABILITIES` — per-role bundles; `super_admin` is intentionally absent and short-circuits to **all** capabilities via `capabilitiesForRole` / `roleHasCapability`.
- `staffMeSchema` — the `/admin/me` payload (`{staffRole, capabilities}`) the console's `StaffMeProvider` / `useStaffMe()` caches for render-gates.

**Middleware** (`apps/api/src/middleware/`): `requireCapability.ts` and `requireStaffRole.ts` both resolve the active role per-request via `platformStaffRepository.getActiveRole(userId)` (an owner-connection read; `platform_staff` denies the app role) and 403 (`insufficient_capability` / `insufficient_staff_role`) on miss. They are interchangeable while the migration to capability-gating is in flight.

**Tables**: `platform_staff` (`packages/db/src/schema/auth.ts:113` — `id`, `user_id` FK→`users` `ON DELETE CASCADE`, `staff_role varchar(50)`, `status varchar(50) default 'active'`, `granted_by_user_id uuid`, `granted_at`, `revoked_at`, unique index `uniq_platform_staff_user` on `user_id`); `users` (joined for email/name); `platform_audit_log` (raw, bootstrap-created, BYPASSRLS owner write).

## Enterprise Benchmark Research

Grounded comparisons against named IAM/PAM products this tab can learn from:

1. **Okta Identity Governance — Access Certification campaigns for admin roles.** Okta IGA ships preconfigured *administrator review* campaigns that recur on a schedule, route each admin-role assignment to a reviewer who must Approve or Revoke *with a mandatory business justification*, and surface users who "may no longer need admin access based on activity." TruePoint has **no recertification loop at all** — a `super_admin` grant from 2024 is still live in 2026 with nobody ever asked to re-attest it. (Source: Okta Help, *Access Certifications for admin roles*; *Review campaigns*.)

2. **CyberArk PAM — dual-control / approval workflow on privileged access.** CyberArk's Master Policy can require that a privileged action be confirmed by one or more *authorized approvers* before access is granted ("two entities are responsible for an action"), with an advanced setting restricting approval to the requester's *direct manager*. TruePoint's `staff:manage` grant — which mints platform-wide cross-tenant authority — requires **exactly one** super_admin and **no second approver**; the `approved_by_user_id` peer-approval seam is documented elsewhere as unenforced. (Source: CyberArk Docs, *Configure dual control and approval workflows*.)

3. **AWS IAM Access Analyzer — unused-access findings from last-accessed data.** Access Analyzer continuously inspects last-accessed information for every IAM user/role and generates *unused role* and *unused permission* findings over a configurable tracking window (e.g. 90 days), then recommends policies to remove. TruePoint records `granted_at` but has **no `last_active_at` and no unused-access surfacing**: there is no way to see, on the staff directory, which grants have gone cold and should be revoked. (Source: AWS IAM User Guide, *IAM Access Analyzer findings*; AWS Security Blog, *Simplifies inspection of unused access*.)

4. **Salesforce — muting / temporary permission scoping.** Salesforce permission-set groups support *muting permission sets* that disable selected permissions for members **without editing the underlying role**, and the construct is explicitly used for *temporary* access restriction (delete the mute → access is restored). TruePoint's roles are static bundles in code; there is **no per-grant scoping, no time-boxed/expiring grant, and no "temporarily reduce this member's capabilities"** — the only lever is full revoke. (Source: Salesforce Help, *Muting Permission Sets*; *Mute a Permission in a Permission Set Group*.)

## Gap Analysis

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | Staff audit actions are **raw strings outside the `platformAuditAction` enum** → not covered by `platformAuditCoverage.test.ts` drift guard | High | `staff.ts:27,51,63` pass `"admin.list_staff"`/`"admin.grant_staff"`/`"admin.revoke_staff"`; enum at `platformAudit.ts:7` lacks them |
| G2 | Grant by **raw user UUID** — no search/picker, no identity confirmation before elevation | High | `StaffPage.tsx:152` `TpInput placeholder="user UUID"` |
| G3 | **No access-certification / recertification** workflow (no periodic re-attestation) | High | absent everywhere; vs Okta IGA |
| G4 | **No peer-approval** on `staff:manage` grant — single super_admin self-service | High | `staff.ts:45`; `approved_by_user_id` not on `platform_staff` |
| G5 | **No `Idempotency-Key`** on `POST /admin/staff` → double-submit re-stamps grant | Medium | `staff.ts:45`, `api.ts:24` |
| G6 | **No role-change history** per member — upsert overwrites prior role in place | Medium | `staffRepository.grant` `onConflictDoUpdate` overwrites `staff_role` |
| G7 | **No last-active / session view** per staff member | Medium | no `last_active_at`; vs AWS Access Analyzer |
| G8 | **No expiring / time-boxed grants**, no per-grant capability scoping | Medium | static `ROLE_CAPABILITIES`; vs Salesforce muting |
| G9 | **No bulk actions** (bulk revoke, bulk role change) | Low | `StaffPage.tsx` single-row actions only |
| G10 | F2 **staff SSO/SCIM, mandatory MFA, IP-allowlist** not enforced (design-spec only) | High (deferred) | brief; needs security/infra sign-off |
| G11 | Read of staff directory is itself `staff:manage` (super_admin) — `compliance_officer` with `audit:read` cannot see who holds power | Low | `staffRoutes.use("*", requireCapability("staff:manage"))` |

## Functional Improvements

### F-1 — User search/picker for grant (close G2)
- **Current state:** grant form is a bare `TpInput` for a raw user UUID (`StaffPage.tsx:152`).
- **Problem:** elevating someone to cross-tenant authority by pasting a GUID gives the operator zero confirmation of *who* they are elevating — a transposed character grants the wrong person platform power, and there is no "are you sure you mean Jane Doe (jane@…)?" step.
- **Enterprise best practice:** Okta/Azure-AD admin-role assignment always resolves to a named, searchable directory entity with email shown before confirm.
- **Recommended implementation:** add `GET /api/v1/admin/users/search?q=` (email/name prefix, bounded by `PLATFORM_READ_LIMIT`, keyset) gated `requireCapability("staff:manage")`; replace the `TpInput` with a typeahead combobox (`@leadwolf/ui`) that emits the resolved `userId` and renders the email inline; keep the server UUID re-validation (`grantStaffSchema`).
- **Expected impact:** eliminates wrong-target grants; makes the grant intentional and reviewable.
- **Dependencies:** `users` table read; new search endpoint; `@leadwolf/ui` combobox.
- **Priority:** High.

### F-2 — Grant-confirmation dialog with capability preview
- **Current state:** grant fires immediately on "Grant role"; only revoke has a confirm `Dialog`.
- **Problem:** the more dangerous action (granting power) has *less* friction than the safer one (revoke).
- **Enterprise best practice:** privileged grants surface the exact entitlements being conferred before commit.
- **Recommended implementation:** add a confirm `Dialog` that renders `capabilitiesForRole(role)` as a chip list ("This grants: tenants:credits, billing:read, elevation:request") and the resolved user's email; require explicit confirm.
- **Expected impact:** operators see the blast radius of a role before granting it.
- **Dependencies:** `capabilitiesForRole` (already in `@leadwolf/types`).
- **Priority:** High.

### F-3 — Role-change history per member (close G6)
- **Current state:** `grant` upserts in place — re-granting a different role overwrites `staff_role` with no record of the prior value beyond the audit log.
- **Problem:** the directory shows only the *current* role; there is no per-member "was support, promoted to billing_ops on …" trail without grepping the audit log.
- **Enterprise best practice:** IGA tools keep a full assignment timeline per identity.
- **Recommended implementation:** a `staff_role_history` append-only table (`schema/platformOps.ts` → `bun generate` → `rls/platformOps.sql` deny-all → REVOKE in `applyMigrations.ts`), written in the same `withPlatformTx` as the grant; surface a per-member drawer reading it.
- **Expected impact:** instant per-member governance view; audit-log noise reduced.
- **Dependencies:** new platform table; `withPlatformTx`.
- **Priority:** Medium.

## Backend Improvements

### B-1 — Promote staff actions into the `platformAuditAction` enum (close G1)
- **Current state:** `staff.ts` passes `"admin.grant_staff"`, `"admin.revoke_staff"`, `"admin.list_staff"` as **raw strings**; `withPlatformTx`'s `action` param is typed `string`, so they compile but are invisible to the `platformAuditCoverage.test.ts` `PENDING → WRITTEN` attestation.
- **Problem:** the single highest-privilege mutation in the platform is *not* governed by the audit drift guard. If someone changes the action string (or drops the audit row) the coverage test would not catch it.
- **Enterprise best practice:** every privileged mutation maps to a closed, version-controlled action vocabulary (AWS CloudTrail event names, Salesforce Setup Audit Trail action types).
- **Recommended implementation:** add `staff.grant`, `staff.revoke` to `platformAuditAction` (`packages/types/src/platformAudit.ts`); switch the route to the enum values; add the `PENDING → WRITTEN` attestation rows in `platformAuditCoverage.test.ts`. Keep `admin.list_staff` as a read string (consistent with other `admin.list_*` reads, which are deliberately non-enum).
- **Expected impact:** staff grant/revoke join the guarded vocabulary; no silent audit regressions.
- **Dependencies:** `platformAudit.ts` enum, coverage test.
- **Priority:** High.

### B-2 — Block self-revoke / last-super_admin lockout
- **Current state:** `DELETE /:userId` revokes any `userId`, including the caller's own and the *last* active super_admin.
- **Problem:** a super_admin can revoke themselves (or the final super_admin), locking the platform out of staff management entirely — recoverable only via `bootstrapAdmin`.
- **Enterprise best practice:** IAM consoles refuse to remove the last account with the org-admin role and warn on self-removal.
- **Recommended implementation:** in `staffRepository.revoke` (or the route, in-tx): reject with a typed 409 if `userId === actor.sub` *or* if revoking the row would leave zero `status='active' AND staff_role='super_admin'` rows (count under `FOR UPDATE`).
- **Expected impact:** removes a self-inflicted-lockout footgun.
- **Dependencies:** `staffRepository`, route.
- **Priority:** High.

### B-3 — Peer-approval seam for `staff:manage` grants (close G4)
- **Current state:** a grant is committed by a single super_admin; no second-person control.
- **Problem:** one compromised or rogue super_admin can silently mint another. This is the classic PAM dual-control gap.
- **Enterprise best practice:** CyberArk dual-control — a privileged grant requires confirmation from a second authorized approver before it takes effect.
- **Recommended implementation:** a `staff_grant_requests` platform table (`requested_by`, `target_user`, `role`, `status`, `approved_by`, `expires_at`); `POST /admin/staff` creates a *pending* request; a second super_admin `POST /admin/staff/requests/:id/approve` commits the grant in a `withPlatformTx`. Reuse the documented "new audited mutation" recipe. **Needs a human security decision** on whether v1 keeps self-service for break-glass.
- **Expected impact:** removes the single-rogue-admin path to privilege escalation.
- **Dependencies:** new platform table; security sign-off.
- **Priority:** High (deferred — needs security sign-off).

## Database Improvements

### D-1 — Add `last_active_at` to support unused-access review (close G7)
- **Current state:** `platform_staff` records `granted_at`/`revoked_at` only.
- **Problem:** no way to identify dormant grants — the unused-access problem AWS Access Analyzer solves.
- **Enterprise best practice:** AWS IAM Access Analyzer surfaces last-accessed and flags unused roles over a tracking window.
- **Recommended implementation:** add `last_active_at timestamptz` to `platform_staff` (`schema/auth.ts`, `bun generate`), updated best-effort from `requireCapability`/`requireStaffRole` (a fire-and-forget owner-connection `UPDATE … WHERE user_id=$1`, throttled to avoid a write per request — e.g. only if older than 1h). Surface "last active" + a "dormant > 90d" badge in the directory.
- **Expected impact:** cold-grant visibility; foundation for an unused-access report.
- **Dependencies:** schema change; throttled write in middleware.
- **Priority:** Medium.

### D-2 — `staff_role_history` table (supports F-3)
- **Current state:** no per-member assignment timeline table.
- **Problem:** in-place upsert loses prior-role context outside the audit log.
- **Enterprise best practice:** IGA assignment history.
- **Recommended implementation:** append-only `staff_role_history` via the new-platform-table recipe (`schema/platformOps.ts` → `bun generate` → `rls/platformOps.sql` deny-all → REVOKE in `applyMigrations.ts`); write in the grant's `withPlatformTx`.
- **Expected impact:** per-member governance timeline.
- **Dependencies:** new platform table.
- **Priority:** Medium.

### D-3 — Optional grant expiry (`expires_at`) for time-boxed access (close G8)
- **Current state:** grants are permanent until revoked.
- **Problem:** standing privilege accumulates; nothing forces re-justification.
- **Enterprise best practice:** time-boxed / JIT-style grants (Salesforce temporary access, Azure PIM eligible assignments).
- **Recommended implementation:** add nullable `expires_at timestamptz` to `platform_staff`; `getActiveRole` adds `AND (expires_at IS NULL OR expires_at > now())`; a worker (see Automation) revokes expired grants and audits `staff.revoke` with `metadata.reason="expired"`.
- **Expected impact:** standing privilege decays automatically.
- **Dependencies:** schema change; `getActiveRole` predicate; worker.
- **Priority:** Medium.

## API Improvements

### A-1 — `Idempotency-Key` on `POST /admin/staff` (close G5)
- **Current state:** no idempotency; a double-submit re-runs the upsert, re-stamping `granted_at`/`granted_by` and writing a duplicate audit row.
- **Problem:** benign data-wise but produces misleading audit noise and a confusing "granted just now" on a member who was granted last year.
- **Enterprise best practice:** Stripe-style client-supplied `Idempotency-Key` replayed for a TTL.
- **Recommended implementation:** accept an `Idempotency-Key` header; persist `(key, actor) → result` in the platform idempotency store; replay the stored result inside the same `withPlatformTx` discipline. Wire the key from `grantStaff` in `api.ts`.
- **Expected impact:** clean, single audit row per intended grant.
- **Dependencies:** platform idempotency store (shared with credit endpoint work).
- **Priority:** Medium.

### A-2 — Split read gate so `audit:read` can see the directory (close G11)
- **Current state:** `staffRoutes.use("*", requireCapability("staff:manage"))` gates even `GET /` to super_admin.
- **Problem:** a `compliance_officer` auditing who holds platform power cannot list staff — they must ask a super_admin, defeating separation of duties.
- **Enterprise best practice:** read of the access model is broader than write of it.
- **Recommended implementation:** move the blanket `use("*")` to `POST`/`DELETE` only; gate `GET /` with `requireCapability("audit:read")` (and keep super_admin implying it). Reads stay audited as `admin.list_staff`.
- **Expected impact:** separation of duties for governance review.
- **Dependencies:** route change only.
- **Priority:** Low.

## Dependency Mapping

- **DB tables:** `platform_staff` (read/grant/revoke), `users` (join for email/name), `platform_audit_log` (raw, owner-write). Proposed: `staff_role_history`, `staff_grant_requests`, `platform_staff.last_active_at`/`expires_at`.
- **Services / repositories:** `staffRepository.{list,grant,revoke}` (`packages/db/src/repositories/staffRepository.ts`); `platformStaffRepository.getActiveRole` (authz lookup, no audit row); `withPlatformTx` (`packages/db/src/client.ts:121`).
- **API endpoints:** `GET /api/v1/admin/staff`, `POST /api/v1/admin/staff`, `DELETE /api/v1/admin/staff/:userId`; cross-tab dependency on `GET /api/v1/admin/me` (capabilities for render-gates).
- **Event flow:** UI action → `fetchWithAuth` (`api.ts`) → authn (`pa` claim) → `platformAdmin` → `requireCapability("staff:manage")` → route → `withPlatformTx(actor, action, fn, target)` → atomic `platform_audit_log` insert + `staffRepository` write → `reload()`.
- **Background workers:** none today. Proposed: expiry-revoke sweeper (D-3), recertification-campaign scheduler (Phase 3).
- **Queue dependencies:** none today; proposed workers run on the existing BullMQ/Redis (`apps/workers`).
- **Permission / capability dependencies:** `staff:manage` (super_admin only) gates all three routes; the *managed* surface is the entire `staffCapability` enum + `ROLE_CAPABILITIES` matrix consumed by every other admin tab's `requireCapability(...)`. Proposed: `audit:read` for the directory read (A-2).
- **Feature-flag dependencies:** none today. Proposed flags: `staff_peer_approval`, `staff_recertification`, `staff_sso_enforced`, `staff_grant_expiry`.
- **External integrations:** none today. Proposed (F2): IdP (SAML/OIDC) for staff SSO, SCIM for provisioning, an MFA verifier, an IP-allowlist source.
- **Cross-module dependencies:** this tab is the *upstream* of the whole console — every gated action in tenants/billing/compliance/impersonation/audit-log/providers/pricing/announcements depends on a `platform_staff` row written here. `bootstrapAdmin.ts` seeds the first super_admin out-of-band.

## Security Review

- **Strengths:** mutations are atomic-with-audit (`withPlatformTx`); the gate is the strictest capability (`staff:manage`); revocation is fail-closed and stateless (per-request `getActiveRole`, no JWT staleness); `granted_by` is server-derived (`claims.sub`), never client-trusted; `platform_staff` is platform-owned, RLS deny-all to `leadwolf_app`, reachable only via the owner connection; input is `grantStaffSchema`-validated (UUID + closed role enum) so role/userId mass-assignment is impossible.
- **Single-rogue-admin escalation (high):** one super_admin can grant another super_admin with no second control (G4/B-3). This is the most material residual risk on this surface.
- **Self-/last-admin lockout (high):** no guard against revoking oneself or the final super_admin (B-2).
- **Audit-coverage blind spot (high):** staff grant/revoke are raw-string actions outside the guarded enum (G1/B-1) — the most privileged action is the least drift-protected.
- **Wrong-target elevation (medium):** raw-UUID grant with no identity confirmation (G2/F-1).
- **Deferred identity hardening (high, needs sign-off):** no enforced staff MFA, no staff SSO/SCIM, no IP-allowlist (F2/G10). A stolen super_admin credential is, today, sufficient to take over the platform. Document as design-ready specs requiring security + infra sign-off; do **not** treat as built.
- **No information leak in errors:** 403s are generic (`insufficient_capability`); the directory read does not over-expose (email/name/role/status/grantedAt only).

## Performance Review

This surface is low-volume and not a performance concern. The staff table is tiny (tens of rows); `staffRepository.list` is a single indexed join (`uniq_platform_staff_user` on `user_id`) ordered by `granted_at` — no pagination needed. `getActiveRole` runs **per privileged request across the entire console** — it is a single-row indexed lookup but it is on the hot path for every admin action. If staff count or request volume grows, a short-TTL (≤30s) in-process cache of `userId → role` keyed off a revocation epoch would remove the per-request round-trip while preserving the "revoke effective next request" guarantee (cache TTL bounds staleness). The proposed `last_active_at` write (D-1) must be **throttled** (write only if stale > 1h) or it turns every read into a write and defeats the point. No N+1, no unbounded scans on this tab.

## UX/UI Improvements

### U-1 — Typeahead user picker (mirrors F-1)
- **Current state:** raw UUID `TpInput` (`StaffPage.tsx:152`).
- **Problem:** unusable without a separate lookup; error-prone.
- **Enterprise best practice:** searchable, named directory picker.
- **Recommended implementation:** `@leadwolf/ui` combobox bound to `GET /admin/users/search`, showing name + email, emitting `userId`.
- **Expected impact:** correct, confident grants.
- **Dependencies:** F-1 endpoint + combobox.
- **Priority:** High.

### U-2 — Capability chips in the directory + grant confirm
- **Current state:** the table shows only the role label; the blast radius of a role is invisible.
- **Problem:** an operator cannot see what `billing_ops` *can do* without reading code.
- **Enterprise best practice:** show effective permissions inline (Okta/Azure role detail).
- **Recommended implementation:** render `capabilitiesForRole(role)` as `StatusBadge`/chip lists in a per-row expand and in the F-2 confirm dialog.
- **Expected impact:** transparent, reviewable RBAC.
- **Dependencies:** `capabilitiesForRole`.
- **Priority:** Medium.

### U-3 — Render-gate the grant/revoke controls on `canMaybe("staff:manage")`
- **Current state:** the page assumes the viewer can manage staff; controls are not capability-render-gated (the API is the boundary, but the UI should match).
- **Problem:** a non-super_admin who reaches the page (e.g. after A-2 opens read to `audit:read`) would see grant/revoke controls that always 403.
- **Enterprise best practice:** hide actions the caller cannot perform; server stays authoritative.
- **Recommended implementation:** wrap the grant form and revoke button in `useStaffMe().canMaybe("staff:manage")`.
- **Expected impact:** clean read-only experience for auditors; consistent with other tabs.
- **Dependencies:** `useStaffMe` (exists); pairs with A-2.
- **Priority:** Medium.

## Automation Opportunities

- **Grant-expiry sweeper** — a scheduled worker (`apps/workers`, BullMQ) that revokes `platform_staff` rows past `expires_at`, auditing `staff.revoke` with `metadata.reason="expired"` (needs D-3).
- **Recertification campaign scheduler** — periodic job that opens review items for every active grant and notifies super_admins; auto-revoke (or flag) grants not re-attested within the window (Okta-IGA-style; Phase 3).
- **Dormant-access report** — weekly digest of grants with `last_active_at` older than N days (needs D-1), feeding the recertification campaign.
- **Audit reconciliation** — a periodic check that every `platform_staff` mutation has a matching `platform_audit_log` row (defence against a future bug dropping the audit write), complementing the build-time `platformAuditCoverage.test.ts`.

## Monitoring & Logging

- **Today:** every grant/revoke writes a `platform_audit_log` row (`admin.grant_staff`/`admin.revoke_staff`, `target_type='user'`, `target_id=userId`, `metadata.staffRole`, `actor_user_id`, `ip`); reads write `admin.list_staff`. The build-time drift guard is `platformAuditCoverage.test.ts` — **but staff actions are outside the enum so they are not asserted** (see B-1).
- **Gaps / recommendations:** (1) once B-1 lands, assert staff grant/revoke in the coverage test; (2) emit a metric/alert on *every* `super_admin` grant (rare, high-signal — page security on it); (3) alert on `staff.revoke` of the last super_admin attempt (pairs with B-2); (4) dashboard panel "active staff by role" + "grants in last 30d"; (5) never log PII beyond what the audit envelope already structures (no tokens, no metadata-as-blob in app logs).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Rogue/compromised super_admin mints another super_admin | Low | Critical | B-3 peer-approval; alert-on-grant (Monitoring); F2 MFA |
| Self-/last-super_admin revoke → platform lockout | Low | High | B-2 lockout guard |
| Staff action audit drift undetected (raw-string actions) | Medium | High | B-1 enum + coverage test |
| Wrong user elevated via mistyped UUID | Medium | High | F-1 picker + F-2 confirm |
| Stolen staff credential (no enforced MFA) | Medium | Critical | F2 (deferred — security sign-off) |
| Standing privilege accumulates, never reviewed | High | Medium | D-3 expiry + recertification |
| `last_active_at` write turns reads into writes | Medium (if naive) | Medium | throttle the write (D-1) |

## Technical Debt

- **`admin.grant_staff` / `admin.revoke_staff` / `admin.list_staff` are raw strings** outside `platformAuditAction` — the most privileged actions are the least guarded (B-1).
- **`withPlatformTx`'s `action` param is typed `string`**, which *permits* the raw-string drift above; tightening it to `PlatformAuditAction | \`admin.list_${string}\`` would make G1 a compile error platform-wide.
- **In-place role upsert** (`onConflictDoUpdate`) silently overwrites prior role — history only recoverable from the audit log (D-2 fixes).
- **`format.ts` does not exist** for this slice (date/tone helpers are inline in `StaffPage.tsx`), diverging from the other tabs' file convention — extract for consistency when touched.
- **Read gate over-scoped** to `staff:manage` (A-2).
- **`requireCapability` and `requireStaffRole` coexist** mid-migration — staff routes use `requireCapability`; finish the migration and retire `requireStaffRole` where redundant.

## Multi-Phase Implementation Plan

### Phase 1 — UX & correctness quick wins (Critical/High)
- **Objectives:** make grants safe and intentional; close the audit-coverage blind spot.
- **Scope:** F-1/U-1 user picker + search endpoint, F-2 grant confirm, U-3 render-gate, B-1 enum promotion + coverage test, B-2 lockout guard, A-1 `Idempotency-Key`.
- **Deliverables:** typeahead picker; `GET /admin/users/search`; `staff.grant`/`staff.revoke` in `platformAuditAction` + `platformAuditCoverage.test.ts` rows; self-/last-admin guard in `revoke`; idempotent grant.
- **Technical tasks:** add search route (bounded, keyset, `staff:manage`); `@leadwolf/ui` combobox; confirm dialog reading `capabilitiesForRole`; enum + route action swap; `FOR UPDATE` count guard in `staffRepository.revoke`; idempotency-key plumbing in route + `api.ts`.
- **Risks:** tightening `withPlatformTx` types may ripple across tabs — stage it.
- **Dependencies:** `users` table; platform idempotency store; `capabilitiesForRole`.
- **Testing requirements:** itest grant/revoke audit rows now match enum + coverage; itest last-super_admin revoke → 409; itest self-revoke → 409; itest double-POST with same key → one audit row; unit test search bound.
- **Estimated complexity:** Medium.
- **Success criteria:** no raw-string staff audit actions; cannot lock out the platform; grants resolve a named user.

### Phase 2 — Governance depth (Medium)
- **Objectives:** per-member history, dormant-access visibility, time-boxed grants, separation-of-duties read.
- **Scope:** D-2 `staff_role_history` + F-3 drawer, D-1 `last_active_at` + dormant badge, D-3 `expires_at` + expiry sweeper, A-2 read-gate split, U-2 capability chips.
- **Deliverables:** history table + per-member drawer; throttled `last_active_at`; expiry column + sweeper worker; `audit:read` directory read; capability chips.
- **Technical tasks:** new-platform-table recipe for `staff_role_history` (`schema/platformOps.ts` → `bun generate` → `rls/platformOps.sql` deny-all → REVOKE in `applyMigrations.ts`); throttled middleware write; BullMQ sweeper; `getActiveRole` expiry predicate; route gate split.
- **Risks:** middleware write amplification (mitigate via throttle); RLS/REVOKE must be present on every new platform table.
- **Dependencies:** Phase 1; `apps/workers`.
- **Testing requirements:** itest history row per role change; itest expired grant → `getActiveRole` returns null; itest deny-all RLS on new tables; itest `audit:read` can list but not grant.
- **Estimated complexity:** Medium–High.
- **Success criteria:** every role change is reconstructable; cold/expired grants surface and auto-revoke; auditors can review without super_admin.

### Phase 3 — Peer-approval & recertification (High; flag-gated; needs sign-off)
- **Objectives:** dual control on grants; periodic access certification.
- **Scope:** B-3 `staff_grant_requests` + approve flow, recertification campaign scheduler + review UI, dormant-access digest.
- **Deliverables:** request/approve endpoints + tables; campaign worker + reviewer surface; weekly digest.
- **Technical tasks:** new platform tables (recipe); two-step grant (`request` → second-approver `approve` in `withPlatformTx`); campaign scheduler; review items with mandatory justification (Okta-style); flags `staff_peer_approval`, `staff_recertification`.
- **Risks:** break-glass — keep a sanctioned self-service path or risk total lockout; **needs human security sign-off** on the dual-control policy.
- **Dependencies:** Phase 1–2; feature-flag infra; security decision.
- **Testing requirements:** itest grant requires distinct second approver; itest requester cannot approve own request; itest recertification revokes/flags un-attested grants; flag on/off paths.
- **Estimated complexity:** High.
- **Success criteria:** no single-actor super_admin grant when the flag is on; every grant is re-attested on schedule.

### Phase 4 — Staff identity hardening (Critical; deferred; needs infra + security sign-off)
- **Objectives:** enforce staff SSO/MFA/IP-allowlist; align with F2.
- **Scope:** mandatory MFA for staff, SSO (SAML/OIDC) + SCIM provisioning of `platform_staff`, IP-allowlist enforcement on the `pa` path.
- **Deliverables:** staff IdP integration; SCIM endpoint mapping IdP groups → staff roles; allowlist middleware before `platformAdmin`.
- **Technical tasks:** IdP/SCIM integration; allowlist source + middleware; MFA assertion check in authn for `pa` claims; flag `staff_sso_enforced`.
- **Risks:** misconfiguration locks out all staff — stage behind a flag with a break-glass bypass and runbook; **must not ship without security + infra sign-off**.
- **Dependencies:** external IdP, MFA verifier, allowlist infra; all prior phases.
- **Testing requirements:** itest non-MFA staff rejected; itest SCIM deprovision revokes role; itest off-allowlist IP → 403; break-glass path documented + tested.
- **Estimated complexity:** High.
- **Success criteria:** every staff login is MFA-backed, IdP-provisioned, and allowlisted; a stolen password alone cannot reach the console.

## Final Recommendations

The Staff & Access tab is **correct where it counts** — atomic audited writes, the strictest gate, fail-closed stateless revocation, server-derived actors, RLS-isolated table. The work is not to rebuild it but to raise it from "a working RBAC write surface" to "an enterprise IGA control plane." Sequenced by priority:

1. **B-1 — promote staff actions into `platformAuditAction` + coverage test (Critical).**
   - **Current state:** raw-string actions outside the guarded enum.
   - **Problem:** the most privileged mutation is the least drift-protected.
   - **Enterprise best practice:** closed, version-controlled audit vocabulary.
   - **Recommended implementation:** add `staff.grant`/`staff.revoke` to the enum; swap the route; add `PENDING → WRITTEN` attestations.
   - **Expected impact:** staff power changes are guaranteed-audited and regression-proof.
   - **Dependencies:** `platformAudit.ts`, coverage test.
   - **Priority:** Critical.

2. **B-2 — last-super_admin / self-revoke lockout guard (High).**
   - **Current state:** any super_admin can revoke themselves or the last one.
   - **Problem:** self-inflicted platform lockout.
   - **Enterprise best practice:** IAM refuses to remove the last org-admin.
   - **Recommended implementation:** in-tx `FOR UPDATE` count guard + self-revoke 409.
   - **Expected impact:** removes a Critical-impact footgun.
   - **Dependencies:** `staffRepository.revoke`.
   - **Priority:** High.

3. **F-1/U-1 — named user picker (High).**
   - **Current state:** raw-UUID grant.
   - **Problem:** wrong-target elevation.
   - **Enterprise best practice:** searchable named directory assignment.
   - **Recommended implementation:** `GET /admin/users/search` + combobox.
   - **Expected impact:** grants become intentional and confirmable.
   - **Dependencies:** `users` read; `@leadwolf/ui`.
   - **Priority:** High.

4. **B-3 + recertification (High, flag-gated, security sign-off).**
   - **Current state:** single-actor self-service grants, no re-attestation.
   - **Problem:** rogue-admin escalation; standing privilege creep.
   - **Enterprise best practice:** CyberArk dual control + Okta IGA certification.
   - **Recommended implementation:** request/approve tables + campaign scheduler behind flags.
   - **Expected impact:** no single-actor escalation; privilege is periodically justified.
   - **Dependencies:** new platform tables; flags; security decision.
   - **Priority:** High (deferred — needs sign-off).

5. **Phase 4 staff identity hardening (Critical, deferred).**
   - **Current state:** no enforced staff MFA/SSO/IP-allowlist.
   - **Problem:** a stolen super_admin credential takes over the platform.
   - **Enterprise best practice:** mandatory MFA + IdP-provisioned, allowlisted admin access.
   - **Recommended implementation:** SSO/SCIM + MFA assertion + allowlist middleware behind `staff_sso_enforced`.
   - **Expected impact:** closes the single most consequential residual risk.
   - **Dependencies:** external IdP/MFA/allowlist infra; **security + infra sign-off required — not yet built.**
   - **Priority:** Critical (deferred).
