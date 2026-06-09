# 13 — Platform Admin (internal super-admin console)

> Operated by **LeadWolf staff, not customers.** A **separate internal app** (`apps/admin`, e.g.
> `admin.leadwolf.internal`) with its own staff auth + RBAC and a **privileged, fully-audited**
> cross-tenant data path — *never* the customer app behind a flag. Governed by
> [ADR-0011](./decisions/ADR-0011-platform-admin-and-privileged-access.md); reinforces the modular,
> not-monolith stance ([02](./02-architecture.md), [ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md)).

## 1. Why separate

- **Blast-radius isolation** — staff tooling can read across tenants; keeping it a separate deploy +
  separate auth means a customer-app bug can never expose it, and vice-versa.
- **Different identity** — staff are not tenant users; they have their own accounts, SSO, and roles.
- **Auditability** — all cross-tenant access flows through one privileged, logged path.

## 2. Staff access model

- **`staff_users`** + **`staff_roles`**: `super_admin`, `support`, `billing_ops`, `compliance_officer`,
  `read_only`. Permissions are per-area + per-action (e.g. `tenants:suspend`, `credits:grant`,
  `impersonate:full`).
- **Staff SSO** (Google Workspace / SAML) + **mandatory MFA**; **IP-allowlisted**; least-privilege.
- **Just-in-time (JIT) elevation** for sensitive actions (credit grants, impersonation, deletes) —
  time-boxed, reason required, optionally peer-approved.
- **Privileged DB path:** cross-tenant reads run under a **dedicated privileged role** that bypasses
  workspace RLS — **distinct** from the customer app's non-`BYPASSRLS` role ([03 §9](./03-database-design.md#9-row-level-security)).
  Every access writes to the immutable **`platform_audit_log`**.
- **Impersonation:** "login-as" (read-only or full) requires a reason, is **time-boxed**, shows a
  persistent **banner** in the impersonated session, and is fully logged. Subject to a
  customer-visibility/consent policy ([08](./08-compliance.md)).

## 3. Console areas

1. **Tenants** — directory (plan/status/seats/credits/MRR) + detail (workspaces, members, usage,
   billing); **suspend / reactivate / churn**; plan & limit overrides; **manual credit grants /
   adjustments** (JIT + audited); GDPR delete.
2. **Users (global)** — cross-tenant user search; deactivate; **reset MFA / force password reset**;
   revoke sessions; login/audit history.
3. **Impersonation & support** — time-boxed, audited, banner-flagged login-as; customer-360; support
   notes; ticket links.
4. **Billing & revenue ops** — Stripe oversight; subscriptions/plans; **refunds/adjustments**; failed
   payments/dunning; **MRR/ARR + churn**; coupons/discounts; **credit economics** (provider spend vs
   revenue, cost-per-reveal); reconciliation.
5. **Plans, pricing & feature flags** — plan/entitlement templates; **credit pack & pricing config**;
   **feature flags** (global + per-tenant overrides; gradual rollout / A-B).
6. **Data sources & providers** — manage enrichment providers (Apollo/ZoomInfo/Clearbit): keys,
   rate-limits, **cost budgets**, enable/disable; provider **health & spend**; Sales Nav config; global
   enrichment defaults ([06](./06-enrichment-engine.md)).
7. **Trust, abuse & deliverability** — signup **abuse/fraud** dashboards (velocity, disposable domains,
   Stripe Radar); **sending reputation** (bounce/complaint per tenant/domain); spam-report queue;
   **global blocklists**; rate-limit config; account flags/holds.
8. **Compliance ops** — **DSAR oversight across all tenants**; global suppression; consent/lawful-basis
   & **retention policy** config; **sub-processor registry**; legal holds; data-residency controls;
   **audit-log export**; **certification & data-broker-registration tracking** (SOC 2 / ISO 27001 status,
   per-state registrations); **DROP deletion-request processing** (poll ≥ every 45 days → DSAR fan-out,
   [08 §4.4](./08-compliance.md#44-california-drop-data-broker-deletion-platform)); + **Trust Center content**
   management ([ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md), [08 §15](./08-compliance.md)).
9. **System health & ops** — service health (ECS/Aurora/Redis/Typesense/OpenSearch/ClickHouse); **queue depth +
   DLQ**; worker/job status; error rates (GlitchTip); **CDC lag**; SES bounce/complaint; uptime;
   deep-links to Grafana/X-Ray; **maintenance mode** + status-page/banner control.
10. **Content & comms** — system/email templates; **in-app announcements/banners**; changelog/release
    notes; terms/privacy version management.
11. **Platform audit log** — every staff action (impersonation, grants, suspensions, config changes) —
    immutable, exportable, **separate** from tenant `audit_log`.
12. **Staff & access (internal RBAC)** — staff accounts, roles/permissions, staff SSO, JIT elevation,
    periodic access reviews.
13. **Data management & quality** — the data-operations cockpit:
    - **DQ monitoring** — global + per-tenant/workspace/source **verification pass-rate** (email/phone),
      **coverage**, **staleness** (past freshness SLA), **duplicate** detection, bounce/invalid rates;
      per-provider **accuracy & cost-per-valid-field** scorecards.
    - **Database management / ops** — Drizzle **migration status**; **partition** management (the
      monthly-partitioned tables, [03 §12](./03-database-design.md#12-partitioning--scale-100m)); index
      & **slow-query** health (Performance Insights); bloat/vacuum; **storage per tenant**; Aurora
      **ACU + read-replica** status; **RDS Proxy** pool stats; **CDC lag**; **backup/PITR** status.
    - **Hygiene jobs** — bulk **re-verification / re-enrichment** (AWS Batch); dedup/merge tools; purge
      stale/unverified; bulk field corrections; GDPR **retention sweeps**; orphan cleanup.
    - **DQ rules & config** — validation rules; **freshness SLA per field**; confidence/quality
      thresholds; auto-suppress-on-bounce; **per-source trust weights** ([06](./06-enrichment-engine.md)).

> The **customer-facing** counterpart is the **Data Health** surface in Reports + per-record quality
> badge ([11 §4.5](./11-information-architecture.md)); this console is the platform-wide DQ + DB-ops view.

## 4. Platform-scope schema (follow-up [03](./03-database-design.md) amendment)

`staff_users`, `staff_roles`/`staff_permissions`, `impersonation_sessions`, **`platform_audit_log`**,
`feature_flags` (+ per-tenant overrides), `plan_templates`/`pricing`, `provider_configs`,
`announcements`, `abuse_flags`/`account_holds`, `system_status`. **DQ** record-level fields
(`last_verified_at`, `verification_source`, `data_quality_score`, `is_duplicate_of`) +
`data_quality_rules`, `verification_jobs`, `dedupe_candidates`. DB-management views read from Postgres
catalogs / Performance Insights / CloudWatch (dashboards, not new schema).

## 5. Deployment & API

- **`apps/admin`** — separate ECS Fargate service, separate domain, separate ALB target; reuses
  `packages/db` under the **privileged role** ([01](./01-tech-stack.md), [02](./02-architecture.md)).
- **Internal `/admin/*` API** — staff-auth + staff-RBAC + JIT; every handler audited to
  `platform_audit_log`; impersonation endpoints mint short-lived, banner-flagged tenant sessions
  ([09](./09-api-design.md)).

## 6. Security stance (highest-risk surface)

Mandatory controls: dedicated privileged role (separate from the app role), JIT elevation, immutable
platform audit, banner-flagged + time-boxed impersonation, IP allowlist, mandatory staff MFA/SSO, and a
customer-visibility/consent policy for support access. See [ADR-0011](./decisions/ADR-0011-platform-admin-and-privileged-access.md)
and [08](./08-compliance.md).

## 7. Roadmap
Basic **Tenants + Billing + Impersonation + System health** land early (ops need them around M3–M5);
**Trust/abuse, feature-flags, data-management/quality, content/comms** follow ([10](./10-roadmap.md)).

## 8. Open questions
1. Build the admin console in-house vs adopt an internal-tooling base (e.g. Retool) for v1? *(Default: in-house, same stack.)*
2. Peer-approval requirement for the most sensitive actions (full impersonation, GDPR delete)?
3. Staff-access data-residency: can EU-tenant data be viewed by non-EU staff, and under what controls?
