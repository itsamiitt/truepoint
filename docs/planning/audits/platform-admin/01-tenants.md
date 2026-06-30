---
title: "Platform Admin Audit — Tenants Tab"
tab: tenants
status: fully-wired
last_audited: 2026-06-29
owner: platform-admin
---

## Executive Summary

The **Tenants** tab is the most complete and highest-privilege surface in the TruePoint Platform Admin console (`apps/admin`). It is the customer-360 + lifecycle-control plane for every org: a searchable, keyset-paged directory (`GET /api/v1/admin/tenants`) and a detail view (`/tenants/[id]`) composed of seven sub-panels — Overview, Workspaces, Members, Support notes, Holds, Purchases, and Auth-enforcement — plus a mutation row (`TenantActions`). It is **fully-wired**: 16 endpoints back it, every mutation runs inside `withPlatformTx(...)` (atomic `platform_audit_log` row + business write), the two most sensitive actions (suspend, credit adjust) are JIT-elevation-gated, and the whole surface is RBAC-gated by `requireCapability(...)` server-side with `useStaffMe().canMaybe(...)` render-gates client-side.

The implementation is genuinely strong on the boundary that matters most — **isolation and auditability**. Cross-tenant reads are bounded (`PLATFORM_READ_LIMIT = 500`, keyset cursors), platform tables are RLS deny-all to `leadwolf_app`, and `platformAuditCoverage.test.ts` blocks any audited action from shipping without a `PENDING → WRITTEN` attestation. Several "gaps" from the original task brief proved **stale on inspection** and are corrected here: hold-kind *is* a closed enum (`accountHoldKind`, both client and server), credit/plan/suspend actions *do* carry `canMaybe` render-gates (`TenantActions.tsx:139,144,149`), and credit overdraft *is* guarded by `SELECT … FOR UPDATE` + DB `CHECK`.

The real gaps are economic depth and write-safety hardening: **no `Idempotency-Key` on the credit/refund POSTs** (a double-submit can double a goodwill grant), **no MRR / billing economics drill-down**, **no GDPR-delete / DSAR action**, peer-approval is designed-but-not-enforced (`approved_by_user_id` exists, self-service v1), and there is no monthly-grant UI. This audit specifies each as an implementation-ready change against the established recipes.

## Current Implementation Audit

**Frontend** (`apps/admin/src/features/tenants/*`, 17 files, ~1,428 LOC):

| File | Role |
|---|---|
| `components/TenantsPage.tsx` | Directory: search box, keyset "load more", `StateSwitch` four-state |
| `components/TenantDetailPage.tsx` | Composes the 7 sub-panels + `TenantActions` header |
| `components/TenantOverview.tsx` | Customer-360 aggregate (reveals 30d/total, burn, active holds) |
| `components/TenantActions.tsx` | Suspend/reactivate, credit adjust, plan apply — dialogs + JIT mint |
| `components/TenantHolds.tsx` | Holds list + place/lift; `HOLD_KINDS` enum `TpSelect` (line 22) |
| `components/SupportNotes.tsx` | Notes list + add (body + optional `ticketUrl`) |
| `components/TenantPurchases.tsx` | Purchases list + refund |
| `components/AuthEnforcementCard.tsx` | P1-01 per-tenant enforcement master switch |
| `api.ts` | The single data seam — `fetchWithAuth` against `/api/v1/admin/*` |
| `types.ts` | Presentation types mirroring the API payloads |
| `hooks/{useTenants,useTenantDetail,useAuthEnforcement,useIsSuperAdmin}.ts` | Vanilla-React load/reload hooks |
| `format.ts` (+ test) | `shortDate`, `formatInt`, `statusTone` |

**Backend** (`apps/api/src/features/admin/routes.ts`, 838 LOC) — 16 tenant endpoints:

| Method + path | Gate | Audit action | Notes |
|---|---|---|---|
| `GET /tenants` | `platformAdmin` | `admin.list_tenants` | keyset + `search` (F5) |
| `GET /tenants/:id` | `platformAdmin` | `admin.get_tenant` | detail + workspaces + members |
| `GET /tenants/:id/overview` | `requireStaffRole(super_admin,support,compliance_officer,read_only)` | `admin.tenant_overview` | raw-SQL aggregates |
| `GET/POST /tenants/:id/notes` | read: staff roles · write: `tenants:notes:write` | `admin.list_support_notes` / `support_note.add` | optional `ticketUrl` (URL-validated) |
| `GET/POST /tenants/:id/holds` | read: staff roles · write: `tenants:hold` | `admin.list_holds` / `account.hold` | `kind` = `accountHoldKind` enum |
| `POST /tenants/:id/holds/:holdId/lift` | `tenants:hold` | `account.hold.lift` | 404 if no active hold |
| `GET /tenants/:id/purchases` | `billing:read` | `admin.list_purchases` | credit-pack history |
| `POST /tenants/:id/purchases/:pid/refund` | `tenants:credits` | `purchase.refund` | reversal **clamped to balance** |
| `POST /tenants/:id/suspend` | `tenants:suspend` | `tenant.suspend` | **JIT-gated** (consumes elevation in-tx) |
| `POST /tenants/:id/reactivate` | `tenants:suspend` | `tenant.reactivate` | restorative — not JIT-gated |
| `POST /tenants/:id/credits` | `tenants:credits` | `credit.grant`/`credit.adjust` | **JIT-gated**; `SELECT … FOR UPDATE`; 422 on overdraw |
| `POST /tenants/:id/plan` | `tenants:plan` | `plan.override` | applies a `plan_template`'s entitlements |
| `POST /tenants/:tenantId/auth-enforcement` | `requireStaffRole(super_admin)` | `admin.set_auth_enforcement` | P1-01 master switch |

**Repositories**: `platformAdminReads.{listTenants,getTenantDetail,getTenantOverview}` (all bounded by `PLATFORM_READ_LIMIT`); `platformAdminWriteRepository.{setTenantStatus,adjustCredits,refundPurchase,applyPlan}` (`packages/db/src/repositories/platformAdminWrites.ts` — `adjustCredits` and `refundPurchase` both take rows `FOR UPDATE`); `accountHoldRepository`, `supportNoteRepository`, `jitElevationRepository.{grant,consume}` (`consume` = `FOR UPDATE SKIP LOCKED`, TTL `JIT_ELEVATION_TTL_SECONDS = 600`), `planTemplateRepository.getByKey`, `authPolicyRepository.setEnforcement`.

**Tables touched**: `tenants`, `workspaces`, `tenant_members`, `users`, `tenant_auth_policies`, `account_holds`, `support_notes`, `purchases`, `contact_reveals`, `jit_elevations`, `plan_templates`, `platform_audit_log` (raw, bootstrap-created).

## Enterprise Benchmark Research

Grounded comparisons against named products this tab can learn from:

1. **Stripe — client-generated `Idempotency-Key` on all mutating customer/refund operations.** Stripe instructs clients to send a V4 UUID `Idempotency-Key` header so a retried create/refund after a network blip never double-charges or double-refunds; results are replayed for 24h. TruePoint's `POST /tenants/:id/credits` and `…/refund` have **no equivalent** — a double-click or retry can apply a goodwill grant twice. (Source: Stripe API Reference, *Idempotent requests*.)

2. **Salesforce — Setup Audit Trail with defined retention + Shield Field Audit Trail.** Salesforce's Setup Audit Trail retains administrative-change history for **180 days** natively, surfaces the 20 most recent entries inline, and (with Shield/Field Audit Trail) extends field-level history to **up to 10 years**. TruePoint's `platform_audit_log` is immutable and complete but has **no documented retention policy, no per-tenant audit drill-down on the detail page, and no export**. (Source: Salesforce Security Implementation Guide, *Monitor Setup Changes with Setup Audit Trail*; Field Audit Trail Implementation Guide.)

3. **Stripe — customer detail surfaces lifetime value / MRR / balance economics inline.** The Stripe customer page leads with spend, balance, and subscription/MRR context. TruePoint's `TenantOverview` shows reveal *usage* (reveals 30d/total, burn, active holds) but **no revenue economics** (MRR, plan price, lifetime spend, refunds-to-date), so a billing operator cannot judge the commercial weight of an org from the detail page.

4. **ZoomInfo / Apollo account admin — usage-limit and entitlement drill-down with trend.** Account-admin consoles in the data-intelligence category (ZoomInfo, Apollo) show credit-pack consumption *over time* with per-seat breakdown and forecast-to-depletion. TruePoint shows point-in-time counters only (no trend, no per-seat, no projected run-out). *(Stated from well-known product behaviour; not from a specific cited doc.)*

## Gap Analysis

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | No `Idempotency-Key` on `POST /credits` and `…/refund` | **Critical** | `creditAdjustSchema` (`tenantAdmin.ts:31`) has no idempotency field; route reads no header |
| G2 | No MRR / billing economics on the detail page | High | `TenantOverview` = usage only (`tenantAdmin.ts:54`) |
| G3 | No per-tenant audit drill-down / export panel | High | No audit read on the tenant detail; `auditLog.ts` is a separate tab |
| G4 | No GDPR-delete / DSAR initiation action | High | No `tenant.delete`/`tenant.dsar` enum entry; brief-confirmed |
| G5 | Peer-approval designed but not enforced | High | `jit_elevations.approved_by_user_id` exists; `consume` does not require it |
| G6 | No monthly-grant / scheduled-credit UI | Medium | Only plan-template entitlement apply; monthly grant is a job |
| G7 | Usage shows no trend / per-seat / forecast | Medium | `getTenantOverview` returns scalars only |
| G8 | `ticketUrl` optional — Jira/Zendesk linkage unrealized | Low | `createSupportNoteSchema.ticketUrl` `.optional()` (`supportNote.ts:11`) |
| G9 | Refund silently clamps to balance with no operator pre-warning | Medium | `refundPurchase` clamps; UI shows result only after the fact |

**Corrected stale findings** (claimed gaps that do not exist): hold-kind *is* an enum on both client (`HOLD_KINDS`, `TenantHolds.tsx:22`) and server (`accountHoldKind`, `accountHold.ts:9`); credit/plan/suspend buttons *are* `canMaybe`-gated (`TenantActions.tsx:139,144,149`); credit overdraft *is* serialized (`SELECT … FOR UPDATE`, `platformAdminWrites.ts:68`).

## Functional Improvements

### F-1 — Idempotent credit & refund writes
- **Current state:** `POST /tenants/:id/credits` and `…/purchases/:pid/refund` accept a JSON body only; a retry replays the write.
- **Problem:** A network retry or operator double-click double-applies a credit move — a real financial integrity bug, not a style nit.
- **Enterprise best practice:** Stripe's client-generated `Idempotency-Key` header; the server stores `(key → result)` and replays on a duplicate.
- **Recommended implementation:** Add an `idempotency_keys` platform table (`key`, `staff_user_id`, `action`, `target_id`, `result_json`, `created_at`, unique on `(staff_user_id, key)`); read the `Idempotency-Key` header in the route; short-circuit-return the stored result inside `withPlatformTx` before `adjustCredits`. Client mints a `crypto.randomUUID()` per dialog open in `TenantActions.tsx`/`TenantPurchases.tsx`.
- **Expected impact:** Eliminates duplicate goodwill grants/refunds; safe retries.
- **Dependencies:** New platform table recipe (schema/platformOps.ts + generate + rls/platformOps.sql deny-all + REVOKE in applyMigrations.ts).
- **Priority:** Critical

### F-2 — Billing economics on `TenantOverview`
- **Current state:** Overview shows reveal usage only.
- **Problem:** A billing operator can't see commercial weight (MRR, plan price, lifetime spend) without leaving the page.
- **Enterprise best practice:** Stripe customer page leads with balance/MRR/LTV.
- **Recommended implementation:** Extend `getTenantOverview` raw SQL to join `purchases` (sum `amount_cents`, count refunds) and `plan_templates` (list price); add `mrrCents`, `lifetimeSpendCents`, `refundsCount` to `tenantOverviewSchema`; render behind `billing:read`.
- **Expected impact:** One-glance commercial context; faster support triage.
- **Dependencies:** `billing:read` capability; `purchases`, `plan_templates`.
- **Priority:** High

### F-3 — Per-tenant audit drill-down panel
- **Current state:** `platform_audit_log` is queryable only from the separate Audit tab.
- **Problem:** Investigating "what did staff do to this org" requires leaving the detail and filtering by `target_id`.
- **Enterprise best practice:** Salesforce surfaces recent setup changes inline on the affected object.
- **Recommended implementation:** Add `GET /tenants/:id/audit` (`audit:read`, action `admin.list_tenant_audit`) reading `platform_audit_log WHERE target_id = :id` bounded by `PLATFORM_READ_LIMIT`; render a collapsible `AuditPanel` sub-panel.
- **Expected impact:** Self-contained investigations; faster incident review.
- **Dependencies:** `audit:read`; `platform_audit_log` owner read.
- **Priority:** High

## Backend Improvements

### B-1 — Refund pre-flight (`would-clamp`) check
- **Current state:** `refundPurchase` clamps the reversal to the live balance and returns `reversed` after committing.
- **Problem:** An operator refunding an already-spent pack sees a smaller `reversed` only after the fact — no chance to confirm.
- **Enterprise best practice:** Stripe shows refundable amount before submit.
- **Recommended implementation:** Add `GET /tenants/:id/purchases/:pid/refund-preview` returning `{ refundable, wouldClamp }`; the dialog warns when `wouldClamp` before the operator confirms.
- **Expected impact:** No surprise partial refunds.
- **Dependencies:** `platformBillingReadRepository`; `tenants:credits`.
- **Priority:** Medium

### B-2 — Enforce peer-approval on the elevation consume path
- **Current state:** `jit_elevations.approved_by_user_id` column exists but `consume` matches only `(staff, action, target, active, unexpired)`.
- **Problem:** Self-service elevation means one compromised super_admin can suspend or drain credits unilaterally.
- **Enterprise best practice:** Privileged-access management (PIM) requires a second approver for break-glass.
- **Recommended implementation:** Gate behind a `pa.peer_approval` feature flag; add `POST /elevations/:id/approve` (`elevation:approve`, audit `elevation.approve`); have `consume` reject grants whose `approved_by_user_id IS NULL` when the flag is on; **requires a human security sign-off** before enabling.
- **Expected impact:** True four-eyes on tenant-destructive actions.
- **Dependencies:** Feature flag; new capability; **security sign-off (deferred)**.
- **Priority:** High (deferred — needs security decision)

### B-3 — GDPR-delete / DSAR initiation
- **Current state:** No tenant-deletion or DSAR action exists.
- **Problem:** A right-to-erasure request has no operator path; manual SQL is the only route — uncontrolled and unaudited at the console.
- **Enterprise best practice:** OneTrust/Transcend-style DSAR initiation with audit trail and async fulfilment.
- **Recommended implementation:** `POST /tenants/:id/dsar` (`compliance:manage`, JIT-gated, audit `tenant.dsar.initiate`) that enqueues a retention/erasure job (workers) and records the request; **requires infra (erasure pipeline) + security/compliance sign-off**.
- **Expected impact:** Compliant, audited erasure initiation.
- **Dependencies:** Workers erasure job; `compliance:manage`; **infra + compliance sign-off (deferred)**.
- **Priority:** High (deferred — needs infra + compliance)

## Database Improvements

### D-1 — `idempotency_keys` platform table
- **Current state:** No idempotency storage.
- **Problem:** Cannot dedupe retried credit/refund writes (see F-1).
- **Enterprise best practice:** Idempotency store keyed on `(actor, key)` with stored result.
- **Recommended implementation:** Add to `schema/platformOps.ts`; `bun generate`; `rls/platformOps.sql` deny-all to `leadwolf_app`; `REVOKE ALL` in `applyMigrations.ts`. Columns: `id`, `staff_user_id`, `idempotency_key`, `action`, `target_id`, `result_json jsonb`, `created_at`, `expires_at`; unique `(staff_user_id, idempotency_key)`.
- **Expected impact:** Durable dedupe substrate.
- **Dependencies:** Migration pipeline.
- **Priority:** Critical

### D-2 — Index for the per-tenant audit drill-down
- **Current state:** `platform_audit_log` has no `target_id` index documented.
- **Problem:** F-3's `WHERE target_id = :id` is a scan as the log grows.
- **Enterprise best practice:** Index the high-cardinality filter column.
- **Recommended implementation:** `CREATE INDEX … ON platform_audit_log (target_id, created_at DESC)` via `bootstrapAdmin.ts` (the log is a raw table, not Drizzle).
- **Expected impact:** Fast inline audit panel.
- **Dependencies:** Raw bootstrap DDL.
- **Priority:** High

## API Improvements

### A-1 — Accept and honour `Idempotency-Key`
- **Current state:** Routes ignore the header.
- **Problem:** No safe-retry contract (F-1).
- **Enterprise best practice:** RFC-style idempotent POST.
- **Recommended implementation:** Parse `Idempotency-Key` (UUID-validated) in the credit/refund handlers; lookup-or-store inside `withPlatformTx`. Document in the API contract; reject missing key with a `400` once the client is updated.
- **Expected impact:** Contractual write-safety.
- **Dependencies:** D-1.
- **Priority:** Critical

### A-2 — `GET /tenants/:id/audit` and `…/refund-preview`
- **Current state:** Neither exists.
- **Problem:** F-3 and B-1 need read endpoints.
- **Enterprise best practice:** Read-before-write previews; inline audit.
- **Recommended implementation:** Add both as bounded reads under the existing middleware chain; audit-string reads (`admin.list_tenant_audit`), no enum mutation.
- **Expected impact:** Enables the two panels above.
- **Dependencies:** D-2 (index), `audit:read`, `tenants:credits`.
- **Priority:** High

## Dependency Mapping

- **DB tables:** `tenants`, `workspaces`, `tenant_members`, `users`, `tenant_auth_policies`, `account_holds`, `support_notes`, `purchases`, `contact_reveals`, `jit_elevations`, `plan_templates`, `platform_audit_log` (raw), proposed `idempotency_keys`.
- **Services / repositories:** `platformAdminReads`, `platformAdminWriteRepository`, `accountHoldRepository`, `supportNoteRepository`, `jitElevationRepository`, `planTemplateRepository`, `authPolicyRepository`, `platformBillingReadRepository`, `platformStaffRepository`.
- **API endpoints:** the 16 routes in the Current Implementation Audit table, all under `/api/v1/admin/tenants/*` (+ `/admin/elevations`, `/admin/pricing/plan-templates`).
- **Event flow:** UI dialog → (for sensitive ops) `POST /admin/elevations` mint → action POST → `withPlatformTx` opens owner tx → `jitElevationRepository.consume` (`FOR UPDATE SKIP LOCKED`) → write repo (`FOR UPDATE` on balance) → `platform_audit_log` insert → commit → `onChanged()` reload.
- **Background workers:** none today on this tab. Proposed: DSAR/erasure job (B-3), monthly-grant scheduler (G6).
- **Queue dependencies:** none today; B-3 and the monthly grant would enqueue via BullMQ/Redis (`apps/workers`).
- **Permission / capability dependencies:** `tenants:suspend`, `tenants:credits`, `tenants:plan`, `tenants:hold`, `tenants:notes:write`, `billing:read`, `audit:read`, `elevation:request`; staff roles `super_admin`/`support`/`billing_ops`/`compliance_officer`/`read_only` via `ROLE_CAPABILITIES` (`staffCapability.ts`). Proposed: `elevation:approve`, `compliance:manage`.
- **Feature-flag dependencies:** none enforced today; proposed `pa.peer_approval` (B-2). The auth-enforcement switch is a per-tenant policy, not a flag.
- **External integrations:** none live. Proposed: Jira/Zendesk via `support_notes.ticketUrl` (G8); KMS for provider secrets (deferred, other tabs).
- **Cross-module dependencies:** `@leadwolf/types` (shared Zod + `platformAuditAction` enum + `ROLE_CAPABILITIES`); `@leadwolf/ui` (`Dialog`, `TpButton`, `TpSelect`, `StateSwitch`, `DataTable`, `StatusBadge`, `useToast`); auth middleware (`authn` → `platformAdmin` → `requireStaffRole` → `requireCapability`); `withPlatformTx` in `packages/db/src/client.ts`.

## Security Review

The boundary discipline here is the tab's strongest asset and should not be eroded by any improvement above.

- **Isolation:** every read goes through the owner-role `withPlatformTx` (RLS bypass) but is *bounded* (`PLATFORM_READ_LIMIT = 500`, keyset cursors, `limit+1` probe). Platform tables are RLS deny-all to `leadwolf_app` + `REVOKE ALL`. No raw client SQL — `api.ts` is the only seam.
- **Authority is server-side:** `canMaybe` only hides buttons; `requireCapability` re-checks role per request (no JWT staleness on revoke). The `tenantId`/`holdId`/`purchaseId` are always UUID-validated and never trusted from the body (new status is implied by the endpoint, `tenantAdmin.ts:11`).
- **Audit completeness:** every mutation is `platformAuditAction`-enumerated and gated by `platformAuditCoverage.test.ts` (`PENDING → WRITTEN`). The audit row and the business write commit or roll back together.
- **JIT break-glass:** suspend + credit consume a live `tenant.suspend`/`credit.adjust` elevation in-tx (`FOR UPDATE SKIP LOCKED`, 10-min TTL) or `403 elevation_required`. **Residual risk:** peer-approval is not enforced (B-2) — single-actor break-glass.
- **New-work guardrails:** the `idempotency_keys` table (D-1) MUST ship with deny-all RLS + REVOKE like every platform table; the audit drill-down (F-3) must not widen visibility beyond `audit:read`.
- **Open items for security sign-off:** B-2 (peer-approval), B-3 (DSAR/erasure), staff SSO/MFA/IP-allowlist enforcement (F2, deferred), KMS secret store (deferred).

## Performance Review

- **Reads are bounded** — no unbounded cross-tenant scans; the directory and detail are keyset-paged. The chief risk is `getTenantOverview`'s raw aggregates over `contact_reveals`: confirm a supporting index on `(tenant_id, created_at)` before adding the F-2 economics joins, or the overview slows as reveal volume grows.
- **`platform_audit_log` growth:** F-3's `target_id` filter needs D-2's index or it scans an ever-growing log.
- **Write serialization:** `adjustCredits`/`refundPurchase` take `FOR UPDATE` on the tenant row — correct, and contention is low (staff-initiated, not user-path), so no concern at expected volume.
- **N+1 on detail:** the detail page fires Overview, Purchases, Holds, Notes, and Auth-enforcement as separate requests on mount. Acceptable for an internal console, but a single `GET /tenants/:id/full` could halve detail-page latency if it becomes a complaint.

## UX/UI Improvements

### U-1 — Idempotent-submit + disabled-while-busy on money dialogs
- **Current state:** Dialogs disable buttons via `busy`, but each submit is a fresh write with no idempotency token.
- **Problem:** A fast double-click or a retry after a timeout can double-apply.
- **Enterprise best practice:** Mint one idempotency key per dialog open; reuse on retry.
- **Recommended implementation:** Generate `crypto.randomUUID()` in `openCredit()`/refund open; send as `Idempotency-Key`; clear on close.
- **Expected impact:** Front-half of F-1; no duplicate writes from the UI.
- **Dependencies:** A-1.
- **Priority:** Critical

### U-2 — Refund "you will reverse N of M" pre-warning
- **Current state:** Refund result (`reversed`, `balanceAfter`) is shown only after commit.
- **Problem:** Operators are surprised by clamped partial refunds.
- **Enterprise best practice:** Show refundable amount before confirm.
- **Recommended implementation:** Call `…/refund-preview` (B-1) on dialog open; render the clamp warning.
- **Expected impact:** No surprise partial refunds.
- **Dependencies:** B-1.
- **Priority:** Medium

### U-3 — Required ticket link on holds/suspends
- **Current state:** `ticketUrl` is optional on notes; holds/suspends carry only a free-text reason.
- **Problem:** Sensitive actions can't be tied back to a ticket of record.
- **Enterprise best practice:** Require a ticket reference on privileged actions for traceability.
- **Recommended implementation:** Add an optional-but-prominent `ticketUrl` field to the suspend and hold dialogs; store in `metadata`; consider making it required behind a flag.
- **Expected impact:** Traceable privileged actions.
- **Dependencies:** Schema `metadata` only (no migration).
- **Priority:** Low

## Automation Opportunities

- **Monthly credit grant scheduler:** plan templates define entitlements; a worker could apply the monthly reveal-credit grant on a schedule (audited `credit.grant`), removing the manual top-up (G6). Needs queue + idempotency (D-1) so a re-run never double-grants.
- **Auto-hold on fraud signal:** wire the abuse/fraud detector (when built) to place an `account.hold` of kind `fraud` automatically (system actor), surfacing it on the Holds panel for human review/lift.
- **Anomaly alerting on credit burn:** a job comparing `burn30d` against the plan baseline could raise a support note or alert when an org's burn spikes (precursor to F-2's trend view).
- **DSAR fulfilment pipeline:** B-3's initiation enqueues an async erasure run with status surfaced back on the tenant detail.

## Monitoring & Logging

- **Audit is the system of record:** `platform_audit_log` already captures actor, action, target, tenant, and `metadata.reason`/`delta` for every mutation — this is the authoritative who-did-what.
- **Add operational metrics:** counter per audit action (e.g. `tenant_suspend_total`, `credit_adjust_total` with sign), histogram on credit-adjust magnitude, and an alert on elevation-consume failures (`403 elevation_required` spikes → either an attack or a broken mint flow).
- **Retention policy:** define and document a `platform_audit_log` retention/export policy (benchmark: Salesforce 180 days native / 10y Shield) — currently undocumented (G3).
- **Dashboards:** surface per-day suspends, credit net-flow, refunds, and active-hold count to operations (truepoint-operations FinOps lens on metered credit movement).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Duplicate credit/refund from retry | Medium | High (financial) | F-1/A-1/D-1 idempotency |
| Single-actor break-glass abuse | Low | Critical | B-2 peer-approval (needs sign-off) |
| Audit log unbounded growth / no retention | High | Medium | D-2 index + documented retention policy |
| Overview aggregate slows at reveal scale | Medium | Medium | Verify `(tenant_id, created_at)` index pre F-2 |
| No DSAR path → manual SQL erasure | Medium | High (compliance) | B-3 DSAR pipeline (needs infra) |
| Eroding the bounded-read invariant in new endpoints | Low | High | Code-review checklist: every new read `PLATFORM_READ_LIMIT`-bounded |

## Technical Debt

- **Stale brief assumptions corrected** (hold enum, render-gates, overdraft guard) — keep `docs/planning/13a` and skill docs in sync to avoid re-litigating non-gaps.
- **N separate detail-page fetches** (U/performance) — candidate consolidation into one detail read.
- **`ticketUrl` optionality** leaves the Jira/Zendesk hook unrealized (G8).
- **`approved_by_user_id` is a dormant column** — schema commitment without enforcement; either enforce (B-2) or document explicitly as v1-deferred to avoid a false sense of four-eyes.
- **No retention policy on the raw audit table** — operational debt, not a code bug.

## Multi-Phase Implementation Plan

### Phase 1 — UX & write-safety quick wins (Critical/High)
- **Objectives:** Close the money-write integrity gap; add the inline audit + economics context operators ask for first.
- **Scope:** F-1/A-1/D-1 (idempotency), F-2 (overview economics), F-3/A-2/D-2 (per-tenant audit panel), U-1, U-2/B-1.
- **Deliverables:** `idempotency_keys` table; idempotent credit/refund routes + UI keys; overview economics fields; tenant audit panel + endpoint; refund preview.
- **Technical tasks:** new-table recipe (schema/platformOps.ts → generate → rls deny-all → REVOKE); extend `tenantOverviewSchema` + raw SQL; `GET /tenants/:id/audit` + `…/refund-preview`; `platform_audit_log (target_id, created_at DESC)` index in `bootstrapAdmin.ts`; mint `crypto.randomUUID()` in dialogs.
- **Risks:** raw-table index DDL drift; overview aggregate cost.
- **Dependencies:** migration pipeline; `audit:read`, `billing:read`.
- **Testing requirements:** itest a retried credit POST returns the same balance once; isolation test the audit panel honours `audit:read`; `platformAuditCoverage` stays green; overview snapshot test.
- **Estimated complexity:** Medium.
- **Success criteria:** double-submit yields one ledger move; operators see MRR + recent audit without leaving the page.

### Phase 2 — Tenant-specific depth (High/Medium)
- **Objectives:** Add economic depth + automation around the lifecycle.
- **Scope:** G6 monthly-grant scheduler (worker + audited `credit.grant`), G7 usage trend/per-seat/forecast, U-3 ticket-link on privileged actions, auto-hold-on-fraud wiring stub.
- **Deliverables:** scheduled grant worker (idempotent via D-1); trend overview API + chart; ticket-link fields; system-actor auto-hold path.
- **Technical tasks:** BullMQ job; time-bucketed reveal/burn query; `metadata.ticketUrl`; system-actor `account.hold`.
- **Risks:** double-grant if idempotency missing (depends on Phase 1); aggregate cost for trend.
- **Dependencies:** Phase 1 (D-1); `apps/workers`; Redis.
- **Testing requirements:** scheduler re-run idempotency itest; trend query bounded; auto-hold audit attestation.
- **Estimated complexity:** Medium–High.
- **Success criteria:** monthly grants run hands-off with no double-grant; operators see burn trend + forecast.

### Phase 3 — Flag-heavy security & compliance depth (High, deferred sign-offs)
- **Objectives:** Four-eyes break-glass and compliant erasure.
- **Scope:** B-2 peer-approval (flag `pa.peer_approval`, enforce `approved_by_user_id`), B-3 DSAR/erasure pipeline, staff SSO/MFA/IP-allowlist enforcement (F2), KMS for any secret store.
- **Deliverables:** `POST /elevations/:id/approve`; flag-gated `consume` rejecting unapproved grants; `POST /tenants/:id/dsar` + erasure worker; SSO/MFA enforcement at the staff-auth boundary.
- **Technical tasks:** `elevation:approve`/`compliance:manage` capabilities; enum entries `elevation.approve`, `tenant.dsar.initiate`; erasure job; auth-policy enforcement.
- **Risks:** locking out operators if peer-approval mis-configured (ship behind a flag, dark-launch); erasure irreversibility.
- **Dependencies:** **human security + compliance sign-off**; erasure infra; IdP for staff SSO.
- **Testing requirements:** elevation cannot be consumed unapproved when flag on; DSAR initiation audited + reversible-until-fulfilment; SSO/MFA enforced for staff.
- **Estimated complexity:** High.
- **Success criteria:** no single actor can suspend/drain unilaterally; DSAR requests are auditable end-to-end.

## Final Recommendations

### R-1 — Ship idempotency first
- **Current state:** Money writes are non-idempotent.
- **Problem:** Highest-impact correctness bug on the tab.
- **Enterprise best practice:** Stripe-style `Idempotency-Key`.
- **Recommended implementation:** Phase 1 F-1/A-1/D-1/U-1.
- **Expected impact:** Removes the only financial-integrity defect.
- **Dependencies:** new platform table.
- **Priority:** Critical

### R-2 — Make the detail page self-sufficient
- **Current state:** Economics + audit live elsewhere.
- **Problem:** Operators tab-switch to triage.
- **Enterprise best practice:** Stripe/Salesforce inline context.
- **Recommended implementation:** F-2 economics + F-3 audit panel.
- **Expected impact:** Faster, fewer-click investigations.
- **Dependencies:** `billing:read`, `audit:read`, D-2 index.
- **Priority:** High

### R-3 — Decide peer-approval and DSAR with security before building
- **Current state:** `approved_by_user_id` dormant; no DSAR path.
- **Problem:** Single-actor break-glass and no compliant erasure are governance gaps, not code gaps.
- **Enterprise best practice:** PIM four-eyes; OneTrust DSAR.
- **Recommended implementation:** Phase 3 behind flags + explicit sign-off; do not enable silently.
- **Expected impact:** Closes the two material governance risks.
- **Dependencies:** **security + compliance sign-off; erasure infra (deferred).**
- **Priority:** High (deferred)

### R-4 — Document audit retention + bound the audit index
- **Current state:** No retention policy; no `target_id` index.
- **Problem:** Unbounded growth and slow per-tenant audit.
- **Enterprise best practice:** Salesforce 180d/10y tiers.
- **Recommended implementation:** D-2 index + a written retention/export policy.
- **Expected impact:** Sustainable, queryable audit history.
- **Dependencies:** raw bootstrap DDL; operations policy.
- **Priority:** Medium
