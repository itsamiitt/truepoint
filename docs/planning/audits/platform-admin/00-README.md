---
title: "Platform Admin — Console Audit (Master Index)"
scope: platform-admin
docs: 15
last_audited: 2026-06-29
owner: platform-admin
---

# TruePoint Platform Admin — Console Audit

> Brand is **TruePoint** (everything a user sees); the npm scope is **`@leadwolf/*`** (the code).
> Both are correct by design — this audit never reconciles them.

## What this audit is

This is a file-grounded, tab-by-tab audit of the **TruePoint Platform Admin console** — the
internal staff app (`apps/admin`, Next.js, vanilla React + `fetchWithAuth`, *not* TanStack
Query) backed by the Hono-on-Bun admin API (`apps/api/src/features/admin/*`, mounted at
`/api/v1/admin/*`). It covers all **14 navigation tabs** defined in
`apps/admin/src/components/shell/navConfig.ts` plus a 15th deep-dive on the cross-cutting
**foundations** (RBAC, JIT elevation, impersonation, the audit substrate, and staff-auth
hardening).

Every claim below is verified against source: `navConfig.ts` declares exactly the 14
`DESTINATIONS` audited here; every mutation routes through `withPlatformTx(...)`
(`packages/db/src/client.ts:121`); cross-tenant reads are bounded by `PLATFORM_READ_LIMIT = 500`
(`packages/db/src/repositories/platformAdminReads.ts:17`); and RBAC resolves through the five
staff roles + `ROLE_CAPABILITIES` matrix (`packages/types/src/staffCapability.ts`).

### Headline finding

**All 14 nav tabs are wired to real, audited, role-gated, RLS-separated APIs. There is no mock
data anywhere in the console, and no broken wiring.** Every tab renders four states
(`StateSwitch`: loading / empty / error / data), every mutation is written inside a
`withPlatformTx` transaction that commits the `platform_audit_log` row atomically with the
business write, every endpoint is gated server-side (`authn` → `platformAdmin` →
`requireStaffRole` → `requireCapability`), and the `platformAuditCoverage.test.ts` drift guard
blocks any audited action from shipping without a `PENDING → WRITTEN` attestation.

The gaps are **completeness and depth** (missing economics drill-downs, no DSAR *actioning*,
shallow observability, no data-quality cockpit) plus a small set of **design-mandated security
items that are deliberately deferred** (impersonation token mint, staff SSO/MFA/IP-allowlist
enforcement, peer-approval, KMS secret store, AI/automation ledgers, the credit-endpoint
`Idempotency-Key`). None of these is a wiring defect — they are the next tranche of work on a
sound foundation.

## Per-tab status

| # | Tab | Status | Key gaps | Doc |
|---|---|---|---|---|
| 01 | **Tenants** | Fully wired | No `Idempotency-Key` on credit/refund POST; no MRR/economics drill-down; no GDPR-delete/DSAR action; peer-approval not enforced | [01-tenants.md](./01-tenants.md) |
| 02 | **Users** | Fully wired | No cross-tenant user search by email; deactivate/reactivate only (no force-logout/session-revoke surface); no per-user audit timeline | [02-users.md](./02-users.md) |
| 03 | **Billing & Revenue Ops** | Wired, shallow | No MRR/ARR/churn rollups; credit ledger view only, no invoice/dunning ops; no `Idempotency-Key`; refund path thin | [03-billing.md](./03-billing.md) |
| 04 | **Plans** | Fully wired | Plan-template CRUD only; no plan-change impact preview; no grandfathering/migration tooling | [04-plans.md](./04-plans.md) |
| 05 | **Pricing** | Fully wired | Pricing-table edit only; no effective-date scheduling; no price-change simulation | [05-pricing.md](./05-pricing.md) |
| 06 | **Providers (Data Sources)** | Wired, secret-gap | Provider configs editable but **secrets live in DB columns, not KMS**; no live health/credit-balance probe per provider | [06-provider-configs.md](./06-provider-configs.md) |
| 07 | **Feature Flags** | Fully wired | Global + per-tenant toggles work; no flag audit-diff timeline; no targeting rules / percentage rollout | [07-feature-flags.md](./07-feature-flags.md) |
| 08 | **Content & Comms** | Fully wired | Announcements CRUD + publish; no scheduling, no audience targeting, no in-app delivery analytics | [08-content.md](./08-content.md) |
| 09 | **Retention** | Wired, policy-only | Retention-policy view/edit wired; **no DSAR/erasure *actioning*** from this tab (defers to compliance); no purge-job visibility | [09-retention.md](./09-retention.md) |
| 10 | **Staff & Access (RBAC)** | Fully wired | Staff CRUD + role assignment + capability matrix; **no SSO/MFA/IP-allowlist enforcement** (F2 deferred); no staff-session inventory | [10-staff.md](./10-staff.md) |
| 11 | **Compliance Ops** | Wired, shallow | Compliance read + manage wired; DSAR intake but **no end-to-end DSAR fulfilment workflow**; no residency/region controls surface | [11-compliance.md](./11-compliance.md) |
| 12 | **Platform Audit Log** | Fully wired | Keyset-paged, filterable audit reader; no export, no saved views, no anomaly/alerting overlay | [12-audit-log.md](./12-audit-log.md) |
| 13 | **Bulk Imports** | Fully wired | Import job list + detail; no in-console retry/cancel of a stuck job; no error-row drill-down export | [13-imports.md](./13-imports.md) |
| 14 | **System Health & Ops** | Wired, shallow | Health probes wired (`systemHealthProbes.ts`); no queue-depth/worker-lag panels, no SLO/error-budget view, no per-tenant cost panel | [14-system-health.md](./14-system-health.md) |
| 15 | **Foundations & Security** | Mixed (core wired; hardening deferred) | RBAC + JIT + audit substrate live; **impersonation token mint, staff SSO/MFA/IP-allowlist, peer-approval, KMS, idempotency deferred** | [15-foundations-and-security.md](./15-foundations-and-security.md) |

**Status legend.** *Fully wired* = real API, audited mutations, RBAC + RLS, four states, no
missing-surface defects. *Wired, shallow* = the seam exists and is safe but the feature is thin
versus the spec. *Wired, <qualifier>* = wired with one named structural gap (secret storage,
policy-only, etc.). *Mixed* = foundation shipped, hardening tranche deferred.

---

## Consolidated multi-phase program roadmap

The audit's remediation is organized into **seven sequenced phases**. Each phase below states
its **Objectives / Scope / Deliverables / Risks / Dependencies / Testing / Complexity /
Success-criteria** and the **tabs it touches**. Phases are ordered by value-to-risk: cheap
correctness wins first, then revenue depth, then compliance, then observability, then data
quality, then trust/abuse, then the security-hardening specs and final QA.

### Phase 1 — UX & correctness quick wins
- **Tabs touched:** Tenants (01), Users (02), Feature Flags (07), Content (08), Audit Log (12),
  Imports (13).
- **Objectives:** close the cheapest correctness and UX gaps that are pure additive slices on
  already-wired surfaces; ship visible polish without new infra.
- **Scope:** `Idempotency-Key` on the credit/refund POSTs (idempotent goodwill grants);
  cross-tenant user search by email; per-user/per-tenant audit timeline links; in-console
  retry/cancel for stuck import jobs; audit-log export (CSV) and filter presets; feature-flag
  change-diff timeline.
- **Deliverables:** idempotency middleware applied to credit endpoints; new read endpoints
  (`GET /admin/users?email=`, scoped audit queries); UI affordances on existing tabs; tests.
- **Risks:** low — additive; idempotency must use a durable key store, not in-memory, to be
  real.
- **Dependencies:** existing `withPlatformTx` recipe; durable idempotency-key table (small
  migration).
- **Testing:** unit (idempotency replay returns the prior result), integration (CI: double-POST
  does not double a credit), audit-coverage attestation for any new action string.
- **Complexity:** Low.
- **Success criteria:** a replayed credit POST is a no-op; staff can find a user by email across
  tenants; every list/detail surfaces its audit trail.

### Phase 2 — Billing & revenue-ops depth
- **Tabs touched:** Billing (03), Tenants (01), Plans (04), Pricing (05).
- **Objectives:** turn the credit-ledger viewer into a real revenue-ops console.
- **Scope:** MRR/ARR/churn rollups; per-tenant economics drill-down (revenue, burn, margin on
  metered enrichment); invoice + dunning visibility; refund workflow with reason taxonomy;
  monthly-grant UI; plan-change impact preview; pricing effective-date scheduling.
- **Deliverables:** billing aggregate endpoints + read repositories; economics panels on the
  tenant detail; refund/grant flows reusing `withPlatformTx` + JIT-elevation gating.
- **Risks:** medium — economics math must reconcile with the source-of-truth ledger; refund
  side-effects touch real money paths.
- **Dependencies:** Phase 1 idempotency; billing source tables; metered-enrichment spend data
  (FinOps, `truepoint-operations`).
- **Testing:** ledger-reconciliation unit tests; integration on refund atomicity; snapshot of
  rollup math against a seeded fixture.
- **Complexity:** Medium–High.
- **Success criteria:** staff can answer "what is this tenant worth and what does it cost us"
  from the console; refunds are audited, idempotent, and elevation-gated.

### Phase 3 — Compliance & DSAR actioning
- **Tabs touched:** Compliance (11), Retention (09), Tenants (01).
- **Objectives:** move compliance from *read/intake* to *end-to-end fulfilment*.
- **Scope:** DSAR fulfilment workflow (intake → assignment → export/erasure → attestation →
  close); GDPR-delete action on a tenant/user with hard-delete + audit; retention purge-job
  visibility; residency/region controls surface.
- **Deliverables:** DSAR state machine + endpoints; erasure executor (worker) with audited
  completion; retention purge-job read panel.
- **Risks:** high — erasure is irreversible and crosses tenant data; legal-hold interplay; must
  be peer-reviewable. Security (`truepoint-security`) has final say on the erasure path.
- **Dependencies:** Phase 7 peer-approval (erasure should be peer-approved); retention policy
  tables; worker queue for async erasure.
- **Testing:** integration on erasure completeness (no orphan PII), audit attestation on every
  DSAR transition, isolation test that erasure cannot escape the target tenant.
- **Complexity:** High.
- **Success criteria:** a DSAR can be fulfilled and attested entirely in-console; an erasure
  leaves a complete, auditable trail and no residual PII.

### Phase 4 — Observability & system-health depth
- **Tabs touched:** System Health (14), Providers (06).
- **Objectives:** make the console operationally useful during an incident.
- **Scope:** queue-depth / worker-lag panels (BullMQ/Redis); SLO + error-budget view; per-tenant
  cost panel (metered spend); per-provider live health + credit-balance probes; dependency
  status board.
- **Deliverables:** health-aggregation endpoints extending `systemHealthProbes.ts`; metrics
  read seams; provider probe jobs.
- **Risks:** medium — probes must not hammer providers or leak secrets; metrics reads must stay
  bounded.
- **Dependencies:** workers/queue metrics exposure (`truepoint-platform`); provider config
  (Tab 06); FinOps spend data (`truepoint-operations`).
- **Testing:** probe unit tests (already present for system-health), integration on
  aggregation, load consideration for probe fan-out.
- **Complexity:** Medium.
- **Success criteria:** an on-call engineer can triage queue lag, SLO burn, and provider health
  from one tab.

### Phase 5 — Data-quality cockpit
- **Tabs touched:** Providers (06), Imports (13), System Health (14); cross-module to
  `truepoint-data`.
- **Objectives:** give staff visibility into dataset health — enrichment coverage, verification
  freshness, import error rates.
- **Scope:** data-health dashboard (`dataHealth` types exist); enrichment coverage + provenance
  rollups; verification-staleness view; import error-row analytics.
- **Deliverables:** data-health read endpoints + panels reusing existing `dataHealth` /
  `fieldProvenance` types.
- **Risks:** medium — aggregates over the prospect dataset must be tenant-bounded and not
  expose cross-tenant records.
- **Dependencies:** `truepoint-data` (enrichment/verification model); bounded aggregate reads.
- **Testing:** isolation tests on aggregates; correctness of coverage math against fixtures.
- **Complexity:** Medium.
- **Success criteria:** staff can see dataset health per tenant without ever reading another
  tenant's records.

### Phase 6 — Trust / abuse & deliverability
- **Tabs touched:** Tenants (01), Compliance (11), Content (08); cross-module to email/outreach.
- **Objectives:** surface abuse signals and outbound deliverability so staff can act before a
  reputation hit.
- **Scope:** abuse/scraping signals per tenant; suppression-list + bounce/complaint visibility
  (the M12 email subsystem); send-reputation panel; throttle/suspend-for-abuse action.
- **Deliverables:** read seams over suppression/consent/bounce data; an audited abuse-action
  mutation; reputation panel.
- **Risks:** medium — abuse actions are punitive and must be audited and reversible; never
  expose another tenant's recipients.
- **Dependencies:** M12 email subsystem (`suppression_list`, `consent_records`, bounce
  handling — do not duplicate); JIT elevation on punitive actions.
- **Testing:** integration on the abuse-action audit trail; isolation on suppression reads.
- **Complexity:** Medium.
- **Success criteria:** staff can see and act on a tenant's deliverability/abuse posture from
  the console, fully audited.

### Phase 7 — Security hardening specs + safe slices + final QA
- **Tabs touched:** Staff (10), Foundations (15), Providers (06), Tenants (01); console-wide.
- **Objectives:** land the deferred security tranche as implementation-ready specs, then ship
  the slices that are safe to build now; run the final cross-console QA.
- **Scope:** F6 impersonation token mint; F2 staff SSO/MFA/IP-allowlist enforcement;
  peer-approval workflow (`approved_by_user_id` already exists); KMS-backed provider secret
  store; AI/automation ledgers (new tables); console-wide a11y (WCAG 2.2 AA), copy, and
  four-state QA sweep.
- **Deliverables:** the deferred-items specs (see register below) made build-ready;
  peer-approval enforcement on the highest-risk actions; KMS migration plan; final QA report.
- **Risks:** high — each item is deferred precisely because it needs infra or a human security
  decision; **do not claim any of these exists** until built.
- **Dependencies:** KMS provisioning; IdP for staff SSO; infra for the token mint; security
  sign-off (`truepoint-security` has final say).
- **Testing:** security-review of each slice; isolation + privilege-escalation tests; final
  end-to-end QA per tab.
- **Complexity:** High.
- **Success criteria:** every deferred item has an implementation-ready spec; the safe slices
  (peer-approval enforcement, idempotency rollout) ship audited; the console passes a full QA
  sweep.

---

## Cross-cutting dependency matrix

Per tab: the DB tables, repositories, endpoints, workers/queues, capabilities, feature flags,
external integrations, and cross-module dependencies it relies on. (`—` = none / not applicable
at audit time.)

| Tab | DB tables | Repositories | Endpoints | Workers/Queues | Capabilities | Feature flags | External integrations | Cross-module deps |
|---|---|---|---|---|---|---|---|---|
| 01 Tenants | `tenants`, `workspaces`, `account_holds`, `support_notes`, `credit_ledger`, `purchases`, `platform_audit_log`, `jit_elevations` | `platformAdminReads`, `platformAdminWriteRepository` | `GET/POST /admin/tenants*` (16) | — | `tenants:read/credits/suspend`, `elevation:request` | — | — | platform (RLS/tenancy), data (ownership), security (JIT) |
| 02 Users | `users`, `memberships`, `platform_audit_log` | `platformAdminReads`, write repo | `GET/POST /admin/users*` | — | `users:read/manage` | — | — | platform, security |
| 03 Billing | `credit_ledger`, `purchases`, `invoices`(src), `platform_audit_log` | billing read/write repos | `/admin/billing*` | — | `billing:read`, `tenants:credits` | — | payment provider (read) | platform, operations (FinOps) |
| 04 Plans | `plan_templates`, `platform_audit_log` | plan-template repo | `/admin/plans*` (`pricing.ts`/plan handlers) | — | `plans:manage` | — | — | platform |
| 05 Pricing | `pricing_tables`, `platform_audit_log` | pricing repo | `/admin/pricing*` (`pricing.ts`) | — | `pricing:manage` | — | — | platform |
| 06 Providers | `provider_configs`, `platform_audit_log` | provider-config repo | `/admin/provider-configs*` (`providerConfigs.ts`) | (probe job, Phase 4) | `providers:manage` | — | enrichment/verification providers | data (enrichment), security (KMS — deferred) |
| 07 Feature Flags | `feature_flags`, `platform_audit_log` | flags repo | `/admin/feature-flags*` | — | `flags:manage` | self (manages flags) | — | platform, architecture |
| 08 Content | `announcements`, `platform_audit_log` | announcements repo | `/admin/announcements*` (`announcements.ts`) | — | `content:manage` | — | — | design, architecture |
| 09 Retention | `retention_policies`, `platform_audit_log` | retention repo | `/admin/retention*` | (purge job, Phase 3) | `compliance:manage` | — | — | data (deletion), security, compliance |
| 10 Staff | `staff_users`, `staff_roles`, `platform_audit_log` | staff repo | `/admin/staff*` (`staff.ts`) | — | `staff:manage` (super_admin) | — | IdP/SSO (F2 deferred) | security (RBAC), platform |
| 11 Compliance | `dsar_requests`, `compliance_*`, `platform_audit_log` | compliance repo | `/admin/compliance*` (`compliance.ts`) | (erasure job, Phase 3) | `compliance:read/manage` | — | — | data, security (final say), operations |
| 12 Audit Log | `platform_audit_log` (read-only) | `platformAdminReads` | `/admin/audit-log*` (`auditLog.ts`) | — | `audit:read` | — | — | security, platform |
| 13 Imports | `bulk_import_jobs`, `import_templates`, `platform_audit_log` | import repos | `/admin/imports*` | bulk-io import queue (`apps/workers`) | `imports:manage` | — | — | platform (queues), data |
| 14 System Health | (probes; metrics sources) | health-probe reads | `/admin/system-health*` (`systemHealthProbes.ts`) | BullMQ/Redis (queue metrics, Phase 4) | `system:read` | — | provider health (Phase 4) | platform (observability), operations |
| 15 Foundations | `jit_elevations`, `staff_users`, `staff_roles`, `platform_audit_log` | `platformAdminReads`/write, elevation repo | `/admin/elevations*`, `/admin/impersonation*` (`elevations.ts`, `impersonation.ts`) | — | all (RBAC substrate) | — | IdP/SSO, KMS (deferred) | security (owns enforcement), platform |

Capability names above follow the `ROLE_CAPABILITIES` matrix in
`packages/types/src/staffCapability.ts`; verify the exact string against that file before wiring
a new gate. The five staff roles are `super_admin` (implies all), `support`, `billing_ops`,
`compliance_officer`, `read_only`.

---

## Deferred-items register

These are **deliberately deferred** — each needs infrastructure or a human security decision.
They are documented as implementation-ready specs in the per-tab docs (chiefly
[15-foundations-and-security.md](./15-foundations-and-security.md)). **Do not claim any of these
exists in the codebase.**

| Item | Why deferred | What unblocks it |
|---|---|---|
| **F6 — Impersonation token mint** | The impersonation *surface* (`impersonation.ts`, `ImpersonationBanner`) exists, but minting a real scoped, time-boxed, audited impersonation token needs token-service infra and a security decision on scope/TTL/revocation. | Token-mint infra + security sign-off on the token's claims, TTL, and revocation path. |
| **F2 — Staff SSO / MFA / IP-allowlist enforcement** | Staff auth uses the JWT `pa` claim today; enforcing SSO, MFA, and an IP allowlist for staff needs an IdP integration and a policy decision. | A staff IdP (SAML/OIDC) + MFA provider + an agreed IP-allowlist policy. |
| **Peer-approval workflow** | `jit_elevations.approved_by_user_id` exists but peer-approval is **not enforced** — JIT is self-service v1. Enforcing a second approver on sensitive actions is a process + UX decision. | Approval-routing UX + a security decision on which actions require a peer, and who can approve. |
| **KMS provider secret store** | Provider secrets currently live in DB columns. Moving them to a KMS-backed store needs KMS provisioning and a migration. | KMS provisioning + an envelope-encryption migration for `provider_configs` secrets. |
| **AI / automation ledgers** | `ai_requests` / `automation_runs` tables **do not exist**. Any AI/automation observability panel needs those tables defined first. | Defining the ledger tables + the write path that populates them. |
| **`Idempotency-Key` on the credit endpoint** | The credit/refund POSTs are not idempotent; a double-submit can double a goodwill grant. Needs a durable idempotency-key store. | A durable idempotency-key table + middleware (scheduled as a Phase 1 safe slice). |

---

## Implementation note — how this audit gets built

Remediation follows a **"build the safe gaps, flag the rest"** scope. Concretely:

- **One slice per loop fire.** Each work loop ships a single, reviewable slice — never a phase
  in one go.
- **Build safe gaps; spec the deferred.** Additive, isolation-preserving, audited slices get
  built. Items in the deferred register get **implementation-ready specs**, not implementations,
  until their infra/decision blocker clears.
- **Gated locally + CI.** Each slice passes the local gates (typecheck, Biome, unit) on the
  coordinator host and the CI gates (itests/docker) before it lands.
- **Pushed to main.** TruePoint is pre-production; finished, gated work merges straight to
  `main` (no review gate), per the standing operating model — but isolation tests, audit
  attestation (`platformAuditCoverage.test.ts` PENDING → WRITTEN), and security sign-off on any
  privileged path are **never** skipped.

> Structure rules never override correctness rules. No multi-tenant write ships without an
> RLS-enforced, ownership-checked, audited path — that is a bug, not a style choice.
