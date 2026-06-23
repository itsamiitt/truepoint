# ADR-0011 — Internal platform-admin console & privileged cross-tenant access

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context doc:** [13-platform-admin.md](../13-platform-admin.md), [02-architecture.md](../02-architecture.md), [03-database-design.md](../03-database-design.md)

## Context

TruePoint staff need to operate the platform — manage tenants/billing, support customers (incl.
**impersonation**), oversee abuse/deliverability, run data-management/quality jobs, and read data
**across tenants**. This conflicts with the customer app's hard per-workspace RLS isolation
([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)): the app deliberately runs under a
non-`BYPASSRLS` role so no handler can read another workspace. Staff tooling must bypass that — which is
exactly why it is the platform's highest-risk surface and needs its own governed design.

## Decision

1. **Separate internal app** — `apps/admin` (own domain, own ECS service/deploy), with its **own staff
   auth + RBAC**, never the customer app behind a feature flag.
2. **Staff identity & RBAC** — `staff_users` + `staff_roles` (`super_admin`/`support`/`billing_ops`/
   `compliance_officer`/`read_only`), staff **SSO + mandatory MFA**, **IP allowlist**, least-privilege,
   **just-in-time elevation** (time-boxed, reason-required, optionally peer-approved) for sensitive
   actions.
3. **Dedicated privileged DB role** — cross-tenant reads use a **separate privileged role** that
   bypasses workspace RLS, **distinct** from the app's non-`BYPASSRLS` role. It is used *only* by
   `apps/admin` / the internal `/admin/*` API.
4. **Immutable platform audit** — every privileged access and staff action writes to
   **`platform_audit_log`** (separate from tenant `audit_log`), append-only, exportable.
5. **Impersonation** — login-as is read-only or full, **time-boxed**, shows a persistent **banner** in
   the impersonated session, requires a reason, and is fully logged; subject to a customer
   visibility/consent policy ([08](../08-compliance.md)).

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Separate internal console + privileged role (this ADR) | Chosen | Blast-radius isolation, distinct identity, single audited path. |
| Super-admin section inside the customer app (flag-gated) | Rejected | One app bug could expose cross-tenant data; muddies the non-`BYPASSRLS` guarantee. |
| Direct DB / cloud-console access for staff | Rejected | Unaudited, unscoped, ungoverned — unacceptable for PII at scale. |
| Third-party internal-tooling (e.g. Retool) for v1 | Deferred | Possible accelerator, but still needs the privileged role + audit; revisit ([13 §8](../13-platform-admin.md)). |

## Consequences

- **Positive:** customer-app RLS guarantee stays intact; staff power is centralized, scoped, and
  auditable; clean separation of identities and deploys.
- **Negative:** a second app + auth system + privileged role to build and secure; the privileged role is
  a high-value target (mitigated by SSO/MFA/IP-allowlist/JIT/audit).
- **Compliance:** platform-level DSAR oversight + staff-access auditing live here; impersonation needs a
  documented consent/visibility policy; staff-access data-residency is an open question
  ([13 §8](../13-platform-admin.md), [08](../08-compliance.md)).

## Revisit if
Staff volume/needs grow enough to warrant peer-approval workflows everywhere, or a managed
internal-tooling platform proves safer/cheaper than the in-house console.
