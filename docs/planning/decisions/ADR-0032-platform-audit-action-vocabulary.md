# ADR-0032 — Platform-audit action vocabulary (`platform_audit_log`)

- **Status:** Proposed
- **Date:** 2026-06-15
- **Context doc:** [13-platform-admin.md](../13-platform-admin.md), [08-compliance.md](../08-compliance.md), [03-database-design.md](../03-database-design.md), [audit-log-enum.md](../audit-log-enum.md)
- **Relates to:** [ADR-0011](./ADR-0011-platform-admin-and-privileged-access.md) (`platform_audit_log`), [ADR-0031](./ADR-0031-auth-event-audit-tenancy.md) (routes tenant-less auth events here)

## Context

`platform_audit_log` is the **separate, immutable, append-only, exportable** log for privileged cross-tenant
staff actions ([ADR-0011 §4](./ADR-0011-platform-admin-and-privileged-access.md), [13 §11](../13-platform-admin.md)) —
distinct from the tenant-scoped `audit_log`. Its `action` vocabulary is **unspecified corpus-wide** — the
open question **OQ-D** in [audit-log-enum.md §9.1](../audit-log-enum.md): does it *share* the tenant
`audit_log.action` enum, or get its own?

Two forces need a home here:
1. **Staff/admin actions** — tenant suspend/reactivate, manual credit grants, plan/limit overrides,
   impersonation start/stop, feature-flag and provider-config changes, audit-log export
   ([ADR-0011](./ADR-0011-platform-admin-and-privileged-access.md), [13 §2/§11](../13-platform-admin.md);
   the `staff_roles` per-action permissions like `tenants:suspend`, `credits:grant`, `impersonate:full`).
2. **Tenant-less identity events** — [ADR-0031 §3](./ADR-0031-auth-event-audit-tenancy.md) routes the
   pre-tenant auth events (`login.failure`, `mfa.*`, `password.reset.*`) here, because `audit_log.tenant_id`
   is `NOT NULL` and those events have no tenant. They **cannot be written until this vocabulary (and the
   `apps/admin` table) exist** — they are the open §5.2 backlog the audit doc tracks to OQ-D.

## Decision (proposed)

1. **Separate enum.** `platform_audit_log` uses its **own** closed `platform_audit_action` enum, **not** the
   tenant `audit_log.action` enum.
2. **Scope = platform-scoped events** = staff/admin actions **plus** tenant-less identity events. This
   broadens `platform_audit_log` slightly from "staff audit" ([ADR-0011](./ADR-0011-platform-admin-and-privileged-access.md))
   to **"platform-scoped (non-tenant) audit."**
3. **Initial vocabulary** (dotted convention, matching `audit_log` per [08 §5](../08-compliance.md)):
   - *Staff/admin:* `tenant.suspend`, `tenant.reactivate`, `credit.grant`, `plan.override`,
     `impersonation.start`, `impersonation.end`, `feature_flag.set`, `provider_config.update`,
     `audit.export`, `staff.login`, `staff.login.failure`.
   - *Tenant-less identity (from [ADR-0031 §3](./ADR-0031-auth-event-audit-tenancy.md)):* `login.failure`,
     `mfa.challenge`, `mfa.success`, `mfa.failure`, `password.reset.request`, `password.reset.complete`.
4. **No tenant GUC.** `platform_audit_log` rows are written on the **privileged** staff path (the
   `BYPASSRLS` role, [ADR-0011 §3](./ADR-0011-platform-admin-and-privileged-access.md)), not under
   `app.current_tenant_id`; a staff action's *target* tenant is a reference column/metadata, not the RLS
   scope. So there is **no** `audit_log`-style `tenant_id NOT NULL` + `WITH CHECK` constraint to satisfy —
   which is exactly why the tenant-less events belong here.
5. **Type alignment** mirrors `audit_log`: a `platformAuditAction` Zod enum in `packages/types` + a DB
   `CHECK`, both materialized **with the `apps/admin` track** (the table does not exist in code yet).

## Rationale

A separate enum keeps the compliance-significant tenant `audit_log` **clean and exhaustively switchable**
for tenant DSAR/export (no staff-only values leak into a tenant's audit export), while giving staff actions
and tenant-less identity events a governed home. It honors [ADR-0031](./ADR-0031-auth-event-audit-tenancy.md)'s
routing without weakening the tenant `audit_log` `NOT NULL` / RLS invariant (H1/H9).

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Separate `platform_audit_action` enum** (this ADR) | Proposed | Clean separation; tenant exports stay pure; matches the separate-table + privileged-role design. |
| Share the tenant `audit_log.action` enum | Rejected | Pollutes tenant audit exports with staff-only values; conflates two RLS / retention / consumer models. |
| A third "identity/security events" store for the tenant-less auth events | Considered | Cleaner split of user-auth from staff-ops, but adds a third store **and** amends [ADR-0031](./ADR-0031-auth-event-audit-tenancy.md)'s routing; defer unless volume/semantics demand it. |

## Consequences

- **Positive:** the tenant `audit_log` stays clean; staff + tenant-less events have a governed home;
  [ADR-0031](./ADR-0031-auth-event-audit-tenancy.md)'s pre-tenant routing becomes implementable; resolves
  **OQ-D**.
- **Negative:** a second audit vocabulary to maintain (a parallel enum/`CHECK` track); `platform_audit_log`'s
  scope broadens beyond pure staff actions.
- **On acceptance (wiring):** add the `00 §7` decision-log row + the tripod; define `platformAuditAction`
  (`packages/types`) + the `platform_audit_log` table/`CHECK` with the `apps/admin` track; add a
  `recordPlatformEvent` sink and wire the 6 tenant-less auth events from `packages/auth`; add a coverage
  gate for `platform_audit_action`; flip those 6 events out of the [audit-log-enum.md §5.2](../audit-log-enum.md)
  backlog.

## Revisit if

The tenant-less identity events grow into a high-volume **security-events** stream (then split them into a
dedicated store), or staff volume warrants a richer permission-derived action taxonomy.
