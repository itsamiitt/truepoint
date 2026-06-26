# 13a — Platform Admin: Feature Plan (current-state-aware build plan)

> **Status:** `plan` · **Spec:** [13 — Platform Admin](./13-platform-admin.md) (unchanged — the *what/why*).
> This doc is the *how/when*: an actionable, current-state-aware build plan for the staff console
> (`apps/admin` + the `/api/v1/admin/*` surface), covering **all 14 console areas** of doc 13 §3 at two
> altitudes — a product overview and an engineering appendix per area — plus the cross-cutting
> foundations and a phased roadmap. Governed by
> [ADR-0011](./decisions/ADR-0011-platform-admin-and-privileged-access.md) /
> [ADR-0032](./decisions/ADR-0032-platform-audit-action-vocabulary.md); credits per
> [07](./07-billing-credits.md) / [ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md) /
> [ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md).

## 0. What this document is (and is not)

Doc 13 is the **specification** — the 14 console areas, the security stance, the schema sketch. It does
not say *what is built today* or *in what order to build the rest*. This doc fills that gap. It is honest
about current state (every claim cites a file), reuses the patterns already in the repo rather than
inventing seams, and sequences the work so the shared mechanisms several areas depend on land first.

It is **not** an implementation: no code, schema, or contracts are written here. 13a *sequences* that work;
each phase is a follow-up effort.

**The headline:** the console is roughly **half-built and overwhelmingly read-only**. The directories and
config toggles exist; the *management mutations a staff operator actually needs* — credit grants, tenant
suspend, user offboarding actions — do not. But the hard parts are done: the audited privileged write
seam, staff RBAC, the immutable audit log, the credit counter, and a clean copyable UI pattern. Most of
the remaining work is **wiring against existing seams**, not greenfield.

## 1. Current-state snapshot

| # | Area (doc 13 §3) | Status | Proof / where it lives |
|---|---|---|---|
| 1 | Tenants | 🟡 **read-only** | `apps/admin/.../features/tenants/*` (directory + detail, no actions); API `GET /admin/tenants[/:id]` `routes.ts` |
| 2 | Users (global) | 🟡 **read-only** | `features/users/UsersPage.tsx` ("Read-only in this phase"); API `GET /admin/users` |
| 3 | Impersonation & support | 🟠 **scaffolded, inert** | session + banner exist; **no login-as token minted** — `features/admin/impersonation.ts:8-9,83-85` |
| 4 | Billing & revenue ops | 🔴 **not started** | only the Stripe top-up webhook + `GET /credits/*` exist (`features/billing/*`) |
| 5 | Plans, pricing & feature flags | 🟡 **flags only** | flags = full CRUD (`routes.ts`); no plan/pricing config |
| 6 | Data sources & providers | 🟡 **partial** | enable/disable/budget works; `health:"unknown"` + `keyHint:null` stubbed (`providerConfigs.ts:59,63`) |
| 7 | Trust, abuse & deliverability | 🔴 **not started** | — |
| 8 | Compliance ops | 🔴 **not started** | tenant-scoped compliance exists (`core/compliance/*`); no cross-tenant staff surface |
| 9 | System health & ops | 🟡 **partial** | job-queue sample only; services hardcoded `up`/`unknown` (`routes.ts` `/system-health`) |
| 10 | Content & comms | 🔴 **not started** | — |
| 11 | Platform audit log | 🟡 **read-only** | `GET /admin/audit-log` (`auditLog.ts`); no pagination/filter/export |
| 12 | Staff & access (RBAC) | 🟡 **partial** | grant/revoke works (`staff.ts`); no JIT, no staff SSO/MFA/IP, no access reviews |
| 13 | Data management & quality | 🔴 **not started** | — |
| 14 | AI & automation ops | 🔴 **not started** | backing tables (`ai_requests`/`automation_runs`) not yet in schema |

**What already exists and makes the rest tractable:**

- **Audited privileged write seam** — `withPlatformTx(actor, action, fn, target)`
  (`packages/db/src/client.ts`): owner-role RLS-bypass read/write that writes an immutable
  `platform_audit_log` row *in the same transaction*. Every existing admin write uses it; every new one
  must too.
- **RBAC gate** — `platformAdmin` (the signed `pa` claim) then per-request `requireStaffRole(...)`
  (`apps/api/src/middleware/`), resolving the active role from `platform_staff` so a revoke takes effect
  on the next request. Roles: `super_admin | support | billing_ops | compliance_officer | read_only`.
- **Audit vocabulary already names the unbuilt actions** — `packages/types/src/platformAudit.ts` defines
  `tenant.suspend`, `tenant.reactivate`, `credit.grant`, `plan.override`, `audit.export` (today marked
  `PENDING` in `platformAuditCoverage.test.ts` — defined, no call-site). Wiring them is the work.
- **The columns for tenant mutations already exist** — `tenants.status` (default `active`), `plan`,
  `seat_limit`, `workspace_limit`, `features` jsonb (`schema/auth.ts:35-50`); `users.status`
  (`active|pending|suspended`), `last_login_at` (`schema/auth.ts:74`). Suspend / plan-override / user
  deactivate need **no migration** — only an endpoint + UI + audit.
- **Granular *org* roles already shipped** — `tenant_members.org_role`
  (`owner|billing_admin|security_admin|compliance_admin|member`, ADR-0030, enforced by `requireOrgRole`).
  So the remaining RBAC gap is **staff-side** capability granularity (F3), not tenant org roles.
- **Credit machinery** — `tenants.reveal_credit_balance` (`CHECK >= 0`), `creditRepository`
  (`lockBalance`/`decrement`/`grantFromEvent`), and the `credit.adjust` audit action already used by
  `core/outreach/handleBounce.ts` for credit-back.
- **A copyable admin UI pattern** — feature folder `api.ts` / `types.ts` / `hooks/useX.ts` /
  `components/XPage.tsx` / `index.ts`; `fetchWithAuth`; `StateSwitch`/`DataTable`/`Dialog`/`Tp*` from
  `@leadwolf/ui`; mutation → `toast` → `reload`. `StaffPage` and `ProviderConfigsPage` are the reference
  mutation pages.

## 2. Cross-cutting foundations (build these first)

Several areas depend on the same handful of mechanisms. Building them once, up front, avoids re-deriving
JIT/audit/pagination in every area.

### F1 — JIT elevation
Doc 13 §2 requires **time-boxed, reason-required, optionally peer-approved** elevation for sensitive
actions (credit grant, suspend, GDPR delete, full impersonation). Today only impersonation requires a
reason; nothing is time-boxed-per-action.
- **Schema:** new `jit_elevations` table (staff_user_id, action, target, reason, expires_at, approved_by?,
  consumed_at) — mirror the `impersonation_sessions` time-box+reason shape in `schema/platformOps.ts`.
- **Middleware:** `requireElevation(action)` composed *after* `requireStaffRole`; verifies an active,
  unconsumed elevation for `(staff, action, target)`; 403 → "elevation required" otherwise.
- **Audit:** elevation grant/consume are themselves `withPlatformTx`-audited.
- **Reused by:** Tenants (suspend, plan-override, credit-grant, delete), Users (force-reset,
  revoke-sessions), Compliance (DSAR delete), Impersonation (full mode).

### F2 — Staff auth hardening
Doc 13 §2/§6 mandates staff **SSO** (Google Workspace/SAML), **mandatory MFA**, and **IP allowlist**.
Today the `pa` claim is the only gate; only `tenant_auth_policies` (customer-side) exists.
- **Schema:** `staff_auth_policy` (allowed IP CIDRs, MFA-required, SSO-required, session cap).
- **Enforcement:** extend `platformAdmin.ts` / the admin gate to require `mfa=true` in the claim and a
  source IP within the allowlist; reuse `packages/auth` `ipAllowlist` + `mfa` primitives.
- **Note:** staff SSO IdP config is a larger sub-effort (reuse `packages/auth/sso/*`); MFA + IP allowlist
  land first as the minimum bar.

### F3 — Granular staff permissions
Doc 13 §2 wants per-area+per-action permissions (`tenants:suspend`, `credits:grant`). Today checks are
role-only. Org roles are already granular (ADR-0030); this closes the **staff** side.
- Keep the 5 roles as **capability bundles**; introduce a capability map in `@leadwolf/types` and a
  `requireCapability(cap)` that resolves role → capabilities. `super_admin` keeps "all".
- Backwards-compatible: existing `requireStaffRole(...)` call-sites keep working; new sensitive endpoints
  use `requireCapability`.

### F4 — Audit vocabulary wiring + pagination/filter/export
- Wire the `PENDING` actions (`tenant.suspend/reactivate`, `credit.grant`, `plan.override`,
  `audit.export`) as they get call-sites; add new actions (`user.deactivate`, `user.reset_mfa`,
  `user.force_reset`, `user.revoke_sessions`, `tenant.delete`, `account.hold`, …). Keep
  `platformAuditCoverage.test.ts` green (move each from `PENDING` → `WRITTEN` when wired).
- Add **keyset pagination + filters** (date range, actor, target tenant, action) and **export**
  (`audit.export`, itself audited) to `GET /admin/audit-log`.

### F5 — Cross-tenant read pagination
Reads are bounded at `PLATFORM_READ_LIMIT=500` with **no paging** (`platformAdminReads.ts`). Add keyset
cursors + server-side search/filter to the tenants, users, staff, and audit lists — reuse the
`SearchPage`/cursor pattern in `packages/types/src/search.ts`.

### F6 — Impersonation token mint
Complete the WIRE-deferred login-as (`impersonation.ts:83-85`): on `POST /admin/impersonation`, mint a
**scoped, time-boxed** access token (audience = target tenant/workspace/user, `exp = session.expiresAt`,
carrying the session id) using the `apps/auth` token path. Read-only vs full mode = scope on the minted
token. The banner already polls `/impersonation/active`; full mode requires F1 elevation.

### F7 — Credit-ledger groundwork
Ship the audited manual **grant/adjust on the counter now** (an increment/decrement under
`SELECT … FOR UPDATE` + `CHECK >= 0`, audited `credit.grant` / `credit.adjust`, JIT-gated), and **design
toward** the append-only `credit_ledger` (ADR-0029, M11) the adjustments migrate onto (after which the
counter is a derived cache). Doing the adjust endpoint counter-first means credits management ships
without waiting for the ledger, and the ledger is a later swap behind the same endpoint.

## 3. Per-area plan

> Each area: **Product overview** (what + who + value) · **Current state** · **Features** · **Engineering**
> (endpoints `method · path · role/capability · audit action`; schema; `@leadwolf/types` contracts; admin
> UI; security). New endpoints all mount under `/api/v1/admin/*`, all run through `withPlatformTx`, all
> validate input with a Zod contract, and all gate with `requireStaffRole`/`requireCapability`.

### Area 1 — Tenants

**Product overview.** The org cockpit. `super_admin` and `support` open a tenant to see plan, limits,
seats, credits, workspaces, members, and usage, and act on it: suspend a non-paying or abusive org,
override its plan/limits, grant credits for a dispute, or process a GDPR delete. The credit-grant and
suspend/delete actions are the highest-frequency staff operations after impersonation.

**Current state.** Read-only directory + detail (`features/tenants/*`); API `GET /admin/tenants` and
`/admin/tenants/:id` return plan/status/seats/credits/workspaces/members. The mutation columns already
exist on `tenants` (status/plan/seat_limit/workspace_limit/features). No write endpoints.

**Features.** Suspend / reactivate · plan & limit override · **manual credit grant / adjust** (JIT +
reason) · GDPR delete (DSAR fan-out) · MRR + usage on the detail view.

**Engineering.**
- `POST /admin/tenants/:id/suspend` · `super_admin` + `tenants:suspend` (F3) · `tenant.suspend` — set
  `status='suspended'`; gate the customer app on tenant status.
- `POST /admin/tenants/:id/reactivate` · `super_admin` · `tenant.reactivate`.
- `PUT  /admin/tenants/:id/plan` · `super_admin` + JIT · `plan.override` — set `plan`/`seat_limit`/
  `workspace_limit`/`features`.
- `POST /admin/tenants/:id/credits` · `super_admin|billing_ops` + JIT (F1) · `credit.grant` — F7 counter
  increment/decrement with reason; `Idempotency-Key` required (money endpoint).
- `POST /admin/tenants/:id/delete` · `super_admin` + JIT + peer-approval (open Q) · `tenant.delete` —
  reuse `core/compliance/deleteFanout.ts`.
- **Schema:** none for suspend/plan (columns exist); F7/F1 tables only.
- **Contracts:** `tenantSuspendSchema`, `planOverrideSchema`, `creditGrantSchema` (amount, reason,
  direction), `tenantDeleteSchema`; extend `tenantDetailSchema` with MRR/usage.
- **UI:** wire action buttons + confirm/reason dialogs onto the existing `TenantDetailPage` (model on
  `StaffPage` mutation pattern). A `CreditGrantDialog` (amount ± reason) and a `SuspendDialog`.

### Area 2 — Users (global)

**Product overview.** The cross-tenant identity desk. `support` finds a person by email across all orgs
and performs account recovery/safety actions: deactivate a compromised account, reset MFA for a locked-out
user, force a password reset, revoke all sessions, and read login/audit history. This is the other half
of day-to-day support alongside impersonation.

**Current state.** Read-only directory (`UsersPage.tsx`, "Read-only in this phase"); `GET /admin/users`.
`users.status` (`active|pending|suspended`), `last_login_at`, `auth_provider` exist. The *primitives* for
every action already exist in `packages/auth` (admin session revoke, MFA, password reset) and
`core/auth/adminSessions.ts` — they are wired for the tenant-admin surface, not the staff surface.

**Features.** Deactivate / reactivate · reset MFA · force password reset · revoke sessions · login & audit
history · server-side search.

**Engineering.**
- `POST /admin/users/:id/deactivate` · `support` + `users:deactivate` · `user.deactivate` — `status='suspended'`.
- `POST /admin/users/:id/reset-mfa` · `support` + JIT · `user.reset_mfa` — reuse `packages/auth` MFA reset.
- `POST /admin/users/:id/force-reset` · `support` + JIT · `user.force_reset` — reuse password-reset primitive.
- `POST /admin/users/:id/revoke-sessions` · `support` · `user.revoke_sessions` — reuse
  `core/auth/adminSessions.ts` (cross-tenant, via `withPlatformTx`).
- `GET  /admin/users/:id` · `support|read_only` — detail + login/audit history (bounded, paginated F5).
- **Schema:** none (columns + session/MFA tables exist).
- **Contracts:** `userSearchQuerySchema` (paginated), `userDetailViewSchema`, new `user.*` audit actions.
- **UI:** new **User detail page** (`features/users/components/UserDetailPage.tsx`) with the action row;
  add server-side search to `UsersPage`.

### Area 3 — Impersonation & support

**Product overview.** "Login-as" so support can reproduce a customer's exact view, with a persistent
banner in the impersonated session, a mandatory reason, a hard time-box, and full audit — plus a
customer-360 (tenant + user + recent activity) and support notes/ticket links to make a session useful.

**Current state.** Session record + reason + time-box + the polling `ImpersonationBanner` all exist, but
**no token is minted** (`impersonation.ts:83-85`) — staff cannot actually enter the session yet.

**Features.** Real login-as (F6) · read-only vs full mode · customer-360 · support notes · ticket links ·
customer-visibility/consent policy (doc 08).

**Engineering.**
- F6 token mint on the existing `POST /admin/impersonation`; **full** mode requires F1 elevation,
  read-only mode does not.
- `GET /admin/tenants/:id/360` · `support` — read-only customer-360 aggregate (bounded).
- **Schema:** `support_notes` (tenant_id, staff_user_id, body, ticket_url, created_at).
- **Contracts:** `supportNoteSchema`; extend the impersonation start response with the minted token's
  scope + expiry.
- **UI:** an "Impersonate" action on tenant/user detail (reason dialog); a `SupportNotesPanel`.

### Area 4 — Billing & revenue ops

**Product overview.** The money cockpit for `billing_ops`. Oversight of Stripe (subscriptions, payments,
failed-payment dunning), refunds/adjustments, **credit economics** (cost-per-reveal = provider spend ÷
reveals; gross credits sold vs consumed; margin per tenant), MRR/ARR + churn, and reconciliation that the
counter can't self-prove.

**Current state.** Only the inbound side exists: Stripe top-up webhook + `GET /credits/balance|usage`
(`features/billing/*`, `creditRepository.grantFromEvent`). Provider cost is tracked
(`provider_calls.cost_micros`) but never correlated to revenue. No refund path, no economics, no recon
worker.

**Features.** Stripe oversight · refunds/adjustments (audited counter adjust, F7) · failed-payment/dunning
view · MRR/ARR + churn · credit economics · coupons/discounts · **reconciliation worker**.

**Engineering.**
- `GET /admin/billing/tenants/:id` · `billing_ops` — subscription state + purchase history (read `purchases`).
- `POST /admin/billing/tenants/:id/refund` · `billing_ops` + JIT · `credit.adjust` — F7 decrement + reason.
- `GET /admin/billing/economics` · `billing_ops` — cost-per-reveal / spend-vs-revenue / margin
  (aggregate `contact_reveals` × `purchases` × `provider_calls.cost_micros`).
- **Worker:** `billing-recon` (doc 07 §8) — asserts `balance >= 0`, Stripe-settled == `purchases`, spend
  sanity; flags drift. New `apps/workers` queue.
- **Schema:** none new for MVP (reads existing); coupons later.
- **Contracts:** `tenantBillingViewSchema`, `refundSchema`, `economicsReportSchema`.
- **UI:** `features/billing/` — `BillingOverviewPage`, `EconomicsPage`, refund dialog.

### Area 5 — Plans, pricing & feature flags

**Product overview.** Where the commercial shape is configured: plan/entitlement **templates**,
**credit-pack & pricing** config (the placeholders in doc 07 §1), and feature-flag rollout (global +
per-tenant, gradual % / A-B). Flags are done; plans/pricing are not.

**Current state.** Feature flags = full CRUD (global + per-tenant override + evaluate) in `routes.ts`,
`features/feature-flags/*`. No plan or pricing config; pricing numbers live only as doc-07 placeholders.

**Features.** Plan/entitlement templates · credit-pack & pricing config · flag rollout % / A-B.

**Engineering.**
- `GET/PUT /admin/plans` · `super_admin` — plan templates (features/seat/workspace defaults).
- `GET/PUT /admin/credit-packs` · `super_admin|billing_ops` — pack sizes + price per credit (drives Stripe).
- Extend the flag override with a `rollout_pct` for gradual rollout (evaluate by stable tenant hash).
- **Schema:** `plan_templates`, `credit_packs`/`pricing` (new).
- **Contracts:** `planTemplateSchema`, `creditPackSchema` (view + upsert pairs).
- **UI:** `features/plans/` + `features/pricing/`.

### Area 6 — Data sources & providers

**Product overview.** Manage the enrichment providers (Apollo/ZoomInfo/Clearbit): enable/disable, monthly
cost **budget**, rate-limit, masked key hint, and live **health** — plus Sales-Nav config and global
enrichment defaults. Mostly done; two honest stubs remain.

**Current state.** Enable/disable + budget + month-to-date spend work (`providerConfigs.ts`). Two WIRE
stubs: `keyHint:null` (`:59`) and `health:"unknown"` (`:63`).

**Features.** Live health probe · masked last-4 key hint (KMS) · rate-limit config · Sales-Nav config ·
global enrichment defaults.

**Engineering.**
- Implement the health probe behind `GET /admin/provider-configs` (replace the hardcoded `unknown`).
- Surface masked last-4 from the KMS-managed provider secret store (replace `keyHint:null`).
- **Schema:** provider secret store reference (if not already); rate-limit column on provider config.
- **UI:** extend `ProviderConfigsPage` (health badge becomes real; key hint shows last-4).

### Area 7 — Trust, abuse & deliverability

**Product overview.** The safety desk: signup fraud dashboards (velocity, disposable domains, Stripe
Radar), sending-reputation per tenant/domain (bounce/complaint), a spam-report queue, **global
blocklists**, rate-limit config, and **account flags/holds** to freeze an abusive tenant fast.

**Current state.** Not started. Signup guards exist conceptually (doc 07 §6); bounce/complaint data flows
to `email_event` (M12). No staff surface, no holds.

**Features.** Fraud dashboards · sending reputation · spam-report queue · global blocklists · rate-limit
config · **account flags/holds**.

**Engineering.**
- `POST /admin/tenants/:id/hold` · `super_admin|support` + JIT · `account.hold` (gate customer app on hold).
- `GET /admin/abuse/signals` · `support` — velocity/disposable/Radar aggregate.
- `GET /admin/deliverability` · `support` — bounce/complaint per tenant/domain (read `email_event`).
- **Schema:** `abuse_flags`, `account_holds` (new); `global_blocklist` (new).
- **Contracts:** `accountHoldSchema`, `abuseSignalSchema`.
- **UI:** `features/trust/` — dashboards + hold dialog.

### Area 8 — Compliance ops

**Product overview.** Cross-tenant compliance for `compliance_officer`: **DSAR oversight** across all
tenants, global suppression, consent/lawful-basis + **retention policy** config, sub-processor registry,
legal holds, data-residency controls, **audit-log export**, certification + data-broker-registration
tracking, California **DROP** processing, and Trust Center content (ADR-0014).

**Current state.** Not started as a *staff* surface. The tenant-scoped engine exists and is reusable:
`core/compliance/` (`dsarIntake`/`deleteFanout`/`assembleAccessReport`/`consent`), `withPrivilegedTx`
(the sanctioned cross-workspace path), and `apps/workers/queues/dsar.ts`.

**Features.** Cross-tenant DSAR queue · global suppression · retention/consent config · sub-processor
registry · legal holds · residency controls · audit export (F4) · cert/data-broker tracking · DROP
processing · Trust Center content.

**Engineering.**
- `GET /admin/compliance/dsars` · `compliance_officer` — cross-tenant DSAR queue (bounded, paginated).
- `POST /admin/compliance/suppression` · `compliance_officer` + JIT · global suppression add.
- `GET/PUT /admin/compliance/retention` · `compliance_officer` — retention SLA per field/entity.
- Reuse `deleteFanout` for DROP fan-out; reuse `assembleAccessReport` for DSAR access.
- **Schema:** `sub_processors`, `legal_holds`, `retention_policies`, `trust_center_content` (new).
- **Contracts:** `dsarQueueSchema`, `retentionPolicySchema`, `subProcessorSchema`.
- **UI:** `features/compliance/` — DSAR queue, retention/consent panels, registry.

### Area 9 — System health & ops

**Product overview.** The run-the-platform view: real service health (ECS/Aurora/Redis/Typesense/
OpenSearch), queue depth + DLQ, worker/job status, error rates, CDC lag, **maintenance mode** + status
banner, and SLO/error-budget + FinOps cost attribution (cross-link [18](./18-scalability-performance.md)/
[19](./19-observability-reliability.md)).

**Current state.** Partial: `GET /admin/system-health` returns a bulk-enrichment job-status sample; other
services are honestly reported `unknown` (no fabricated green). No probes, no maintenance mode.

**Features.** Real service probes · queue depth + DLQ · worker status · error rates · CDC lag ·
**maintenance mode** + status banner · SLO/error budgets · FinOps attribution.

**Engineering.**
- Replace the hardcoded services with live probes (DB ping, Redis ping, search ping, worker heartbeat).
- `POST /admin/maintenance` · `super_admin` · `maintenance.set` — toggle maintenance + banner.
- **Schema:** `system_status` (new); worker heartbeat surface.
- **UI:** extend `SystemHealthPage` (real tiles, queue/DLQ, maintenance toggle).

### Area 10 — Content & comms

**Product overview.** In-app **announcements/banners** (target all/plan/tenant), system + email templates,
changelog/release notes, and terms/privacy version management — the platform's voice to customers.

**Current state.** Not started.

**Features.** Announcements/banners · system/email templates · changelog · terms/privacy versioning.

**Engineering.**
- `GET/POST /admin/announcements` · `super_admin|support` · `announcement.publish` — CRUD + targeting.
- `apps/web` shell renders active announcements (read via a public/session endpoint).
- **Schema:** `announcements` (view + upsert pair), `legal_doc_versions` (new).
- **Contracts:** `announcementSchema` + `announcementUpsertSchema`.
- **UI:** `features/content/` — announcement composer + schedule.

### Area 11 — Platform audit log

**Product overview.** The immutable record of every staff action, readable + filterable + exportable by
`super_admin`/`compliance_officer`, separate from the tenant `audit_log`.

**Current state.** Read-only, newest-first, bounded (`auditLog.ts`). The table + RLS deny-all +
append-only trigger + owner-insert-only already exist. No pagination, filtering, or export.

**Features.** Keyset pagination · filter (date/actor/tenant/action) · **export** (`audit.export`, audited).

**Engineering.** This *is* F4/F5 applied to the audit surface — no new area-specific design.
- **UI:** add filter controls + paging + an export button to `AuditLogPage`.

### Area 12 — Staff & access (internal RBAC)

**Product overview.** Manage staff accounts, roles/permissions, staff SSO, JIT, and **periodic access
reviews** — the internal IAM for the console itself.

**Current state.** Grant/revoke roles works (`staff.ts`, `super_admin`-gated, audited). No JIT (F1), no
staff SSO/MFA/IP (F2), no granular capabilities (F3), no access reviews.

**Features.** F1 JIT · F2 staff SSO/MFA/IP · F3 granular permissions · **periodic access reviews**.

**Engineering.** Mostly F1-F3.
- `GET/POST /admin/access-reviews` · `super_admin` — quarterly review attestation.
- **Schema:** `staff_access_reviews` (new); `jit_elevations` + `staff_auth_policy` (F1/F2).
- **UI:** extend `StaffPage` with capability view + access-review workflow.

### Area 13 — Data management & quality

**Product overview.** The data-operations cockpit: global + per-tenant **DQ monitoring** (verification
pass-rate, coverage, staleness, duplicates, bounce/invalid), per-provider accuracy + cost-per-valid-field
scorecards, **DB-ops** dashboards (migration status, partitions, slow-query, vacuum/bloat, storage per
tenant, Aurora ACU/replica, RDS-Proxy, CDC lag, backup/PITR), **hygiene jobs** (re-verify/re-enrich,
dedup/merge, purge stale, retention sweeps), DQ rules + freshness SLA config, and an **ER manual-review
queue** ([22 §6](./22-data-quality-freshness-lifecycle.md)).

**Current state.** Not started. Inputs exist: `data_quality_score` on records (ADR-0013/0025),
`provider_calls.cost_micros`, the `dedup`/`retentionSweep` worker queues. DB-ops views read Postgres
catalogs / Performance Insights / CloudWatch (dashboards, not new schema).

**Features.** DQ monitoring · per-provider scorecards · DB-ops dashboards · hygiene jobs · DQ rules +
freshness SLA · ER merge-review queue.

**Engineering.**
- `GET /admin/dq/overview` · `support|read_only` — pass-rate/coverage/staleness/dupes aggregates.
- `POST /admin/dq/hygiene` · `super_admin` + JIT — kick a re-verify/dedup/purge job (enqueue a worker).
- `GET/POST /admin/dq/merge-queue` · `support` — ER review (merge/unmerge + audit).
- **Schema:** `data_quality_rules`, `dedupe_candidates` (new); the rest are read-only catalog views.
- **UI:** `features/data-quality/` — monitoring dashboards + merge-review queue.

### Area 14 — AI & automation ops

**Product overview.** Oversight of the AI + automation spend and safety: AI usage + **cost per tenant**
(`ai_requests`), eval/safety dashboards + CI regression gates, prompt/model version + rollout,
content-safety flags, automation oversight (rule runs/errors, loop/abuse guards via `automation_runs`),
and per-tenant AI/automation budgets ([23 §6](./23-ai-intelligence-layer.md),
[27](./27-workflow-automation-engine.md)).

**Current state.** Not started; the backing tables (`ai_requests`, `automation_runs`) are **not yet in
schema**. The AI search path exists (`core/ai/*` with budget/prompt guards) but doesn't yet emit a usage
ledger.

**Features.** AI usage/cost per tenant · eval/safety dashboards · prompt/model rollout · content-safety
flags · automation oversight · per-tenant AI/automation budgets.

**Engineering.**
- First land the `ai_requests`/`automation_runs` ledgers (cross-ref docs 23/27), then:
- `GET /admin/ai/usage` · `support|billing_ops` — usage + cost per tenant.
- `POST /admin/ai/budgets/:tenantId` · `billing_ops` — per-tenant AI budget (reuse the provider-budget
  pattern in `providerConfigs.ts`).
- **Schema:** `ai_requests`, `automation_runs`, `ai_budgets` (new — sequenced with M14+).
- **UI:** `features/ai-ops/`.

## 4. Phased roadmap

Dependency-ordered. Foundations gate everything; the management core is the user-named priority.

| Phase | Theme | Contents | Depends on |
|---|---|---|---|
| **0** | Foundations | F1 JIT · F2 staff auth (MFA+IP first, SSO later) · F3 capabilities · F4 audit paging/export+vocab · F5 read pagination · F6 impersonation token · F7 credit-adjust groundwork | — |
| **1** | **Management core** (priority) | Tenants mutations (1) · Users mutations (2) · Credits grant/adjust (1+F7) · real impersonation + customer-360 + notes (3) | Phase 0 |
| **2** | Money | Billing & revenue ops (4) · Plans/pricing (5) · provider health/key (6) · `billing-recon` worker | Phase 0-1 |
| **3** | Trust & compliance | Trust/abuse + holds (7) · Compliance ops / DSAR oversight (8) | Phase 0 |
| **4** | Run the platform | Deep system health + maintenance mode (9) · Content/comms (10) | Phase 0 |
| **5** | Data & AI ops | Data-management/quality (13) · AI/automation ops (14, after the AI/automation ledgers land) | Phase 0; docs 22/23/27 |

Audit-log polish (11) ships *inside* F4/F5; Staff & access (12) ships *inside* F1-F3 plus the access-review
workflow in Phase 0/1.

## 5. Engineering appendix

### 5.1 New endpoints (all under `/api/v1/admin/*`, all `withPlatformTx`-audited)

| Method · Path | Role / capability | Audit action | Phase |
|---|---|---|---|
| POST `/tenants/:id/suspend` | super_admin · `tenants:suspend` | `tenant.suspend` | 1 |
| POST `/tenants/:id/reactivate` | super_admin | `tenant.reactivate` | 1 |
| PUT  `/tenants/:id/plan` | super_admin · JIT | `plan.override` | 1 |
| POST `/tenants/:id/credits` | super_admin\|billing_ops · JIT · Idempotency-Key | `credit.grant` | 1 |
| POST `/tenants/:id/delete` | super_admin · JIT · peer? | `tenant.delete` | 1/3 |
| POST `/users/:id/deactivate` | support · `users:deactivate` | `user.deactivate` | 1 |
| POST `/users/:id/reset-mfa` | support · JIT | `user.reset_mfa` | 1 |
| POST `/users/:id/force-reset` | support · JIT | `user.force_reset` | 1 |
| POST `/users/:id/revoke-sessions` | support | `user.revoke_sessions` | 1 |
| GET  `/users/:id` | support\|read_only | `admin.get_user` | 1 |
| GET  `/tenants/:id/360` | support | `admin.tenant_360` | 1 |
| GET  `/billing/tenants/:id` | billing_ops | `admin.get_billing` | 2 |
| POST `/billing/tenants/:id/refund` | billing_ops · JIT | `credit.adjust` | 2 |
| GET  `/billing/economics` | billing_ops | `admin.billing_economics` | 2 |
| GET/PUT `/plans`, `/credit-packs` | super_admin\|billing_ops | `plan.template.set` | 2 |
| POST `/tenants/:id/hold` | super_admin\|support · JIT | `account.hold` | 3 |
| GET  `/abuse/signals`, `/deliverability` | support | `admin.abuse_read` | 3 |
| GET  `/compliance/dsars` | compliance_officer | `admin.dsar_read` | 3 |
| POST `/compliance/suppression` | compliance_officer · JIT | `suppress.add.global` | 3 |
| GET/PUT `/compliance/retention` | compliance_officer | `retention.set` | 3 |
| POST `/maintenance` | super_admin | `maintenance.set` | 4 |
| GET/POST `/announcements` | super_admin\|support | `announcement.publish` | 4 |
| GET/POST `/access-reviews` | super_admin | `access_review.attest` | 0/1 |
| GET  `/dq/overview`, `/dq/merge-queue` | support | `admin.dq_read` | 5 |
| POST `/dq/hygiene` | super_admin · JIT | `dq.hygiene.run` | 5 |
| GET  `/ai/usage`, POST `/ai/budgets/:id` | support\|billing_ops | `ai.budget.set` | 5 |
| GET  `/audit-log` (+ paging/filter), POST `/audit-log/export` | super_admin\|compliance_officer | `audit.export` | 0 |

### 5.2 New schema (Drizzle + RLS) — none needed for tenant/user mutations (columns exist)

`jit_elevations` · `staff_auth_policy` · `staff_access_reviews` · `support_notes` · `plan_templates` ·
`credit_packs`/`pricing` · `abuse_flags` · `account_holds` · `global_blocklist` · `sub_processors` ·
`legal_holds` · `retention_policies` · `trust_center_content` · `announcements` · `legal_doc_versions` ·
`system_status` · `data_quality_rules` · `dedupe_candidates` · `ai_requests` · `automation_runs` ·
`ai_budgets` · (M11) `credit_ledger`. Each PLATFORM-owned, deny-all to `leadwolf_app`, append-only where
it is an audit/event table (mirror `rls/platform.sql`).

### 5.3 New `@leadwolf/types` contracts + drift guards

Add the request/response Zod schemas named per area; reuse the **keyset pagination** (`search.ts`),
**masked-view / write-only-secret** (`providerConfigs.ts`/`sso.ts`), and **view+upsert pair**
(`featureFlags.ts`) patterns. Extend the `platformAuditAction` enum with every new action above and keep
`platformAuditCoverage.test.ts` green (PENDING → WRITTEN as each is wired).

### 5.4 New admin UI routes

`(shell)/tenants/[id]` (actions) · `(shell)/users/[id]` · `(shell)/billing` · `(shell)/plans` ·
`(shell)/trust` · `(shell)/compliance` · `(shell)/content` · `(shell)/data-quality` · `(shell)/ai-ops`.
Each registers one entry in `apps/admin/src/components/shell/navConfig.ts`.

## 6. Open decisions

1. **Pricing numbers** — reveal cost per type, credit-pack sizes/prices, signup bonus, expiry (doc 07 §1;
   policy decided in [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md), numbers
   are placeholders). Needed before Plans/pricing (Area 5) and credit-pack config.
2. **Peer-approval** — which actions require a second staff approver (full impersonation, GDPR delete,
   large credit grant)? Drives F1's `approved_by` (doc 13 §8 Q2).
3. **Staff-data residency** — may non-EU staff view EU-tenant data, under what controls? Gates F2/Area 8
   residency controls (doc 13 §8 Q3).
4. **Counter vs ledger timing** — ship credit grant/adjust on the counter now (F7) and migrate to
   `credit_ledger` at M11 ([ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md)), or wait
   for the ledger? Recommendation: counter-first behind the same endpoint.

## 7. The per-area "done" bar (from the skills' mandates)

A management feature is not done until its write path is:
- **`withPlatformTx`-audited** — an immutable `platform_audit_log` row in the same tx (security: immutable
  audit; `truepoint-security`).
- **JIT-gated** if sensitive — F1 elevation for credit grants, suspends, deletes, force-resets, full
  impersonation (doc 13 §2).
- **RBAC-gated** to the doc-13 capability matrix — `requireStaffRole`/`requireCapability` (F3).
- **Input-validated** with an `@leadwolf/types` Zod contract; money endpoints carry `Idempotency-Key`
  (`truepoint-platform`).
- **Bounded/paginated** on reads (F5); no unbounded cross-tenant scans.
- **Isolation-tested** where it touches customer data — an itest proving no staff read returns tenant PII
  without an impersonation token, an "audit-row-written" assertion per mutation, and a "JIT-required"
  negative test; the `platformAuditCoverage` drift guard moves each action PENDING → WRITTEN.

> Cross-references: [13](./13-platform-admin.md) (spec) · [07](./07-billing-credits.md) (credits) ·
> [08](./08-compliance.md) (DSAR/consent) · [18](./18-scalability-performance.md)/
> [19](./19-observability-reliability.md) (SLO/FinOps) · ADRs
> 0007/0011/0012/0013/0014/0019/0021/0022/0029/0030/0032/0034/0036/0038.
