# ADR-0030 — Granular tenant org roles

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context doc:** [03-database-design.md](../03-database-design.md), [17-authentication.md](../17-authentication.md)
- **Amends:** [ADR-0019](./ADR-0019-global-identity-and-tenant-membership.md) (tenant-membership
  capability model; global identity unchanged)

## Context

The only tenant-level capability is the boolean `tenant_members.is_tenant_owner` (H8/H16): one bit
gates billing, plan, SSO/SCIM, residency, compliance, and workspace lifecycle. The enterprise audit
([28 §2](../28-enterprise-readiness-audit.md), G-AUTH-10 — Critical) found this blocks **delegated
administration** — a named enterprise buying gate — and that [12 §1](../12-settings.md) already refers to
a "billing admin" that has no schema (drift F-4). The settings/administration architecture
([29 §18](../29-settings-administration-architecture.md)) needs separable billing / security / compliance
duties at the org scope.

## Decision

- Add **`tenant_members.org_role`**: `owner | billing_admin | security_admin | compliance_admin | member`
  (default `member`). A person's org capability is their `org_role`; **workspace roles (H8) are unchanged
  and orthogonal**, as are team roles (ADR-0022).
- **Capability mapping:** `owner` ⊇ everything tenant-scoped (unchanged semantics); `billing_admin` →
  billing/checkout, plan, credit pool + budget allocation, invoices; `security_admin` → auth policies,
  SSO/SCIM, domain claiming, IP allowlists, API keys/OAuth apps, SIEM export; `compliance_admin` →
  tenant/global suppression intake, DSAR, consent, retention, legal holds, audit-log export; `member` →
  no org-scope powers.
- **Migration/compat:** `is_tenant_owner` is kept during migration as a compat alias
  (`is_tenant_owner ⇔ org_role = 'owner'`), then dropped; `invitations.is_tenant_owner` likewise becomes
  an `org_role` field. At least one active `owner` per tenant is enforced.
- **Lands M11** (enterprise settings) with the entitlement gate (granular roles Team+/Enterprise; below
  that, only `owner`/`member` are offered).
- **Custom roles** (capability sets as data) are explicitly deferred — see *Revisit if*.

## Rationale

Four fixed duty-separated roles cover the real enterprise asks (finance ≠ security ≠ privacy officers)
with a small, testable surface, reuse the existing membership row, and resolve the 12 §1 vocabulary drift
by making the named role real instead of striking it.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Fixed `org_role` enum (this ADR)** | Chosen | Covers duty separation; tiny schema delta; clear audits. |
| Keep the boolean | Rejected | All-or-nothing org power fails delegated administration; perpetuates drift F-4. |
| Capability-set custom roles now | Rejected (deferred) | Real demand exists but the builder + ceiling/floor math is large; fixed roles unblock GA first. |
| Per-area boolean columns | Rejected | Unbounded column growth; enum + mapping is clearer. |

## Consequences

- **Positive:** delegated administration; approval workflows ([29 §19](../29-settings-administration-architecture.md))
  get distinct approver roles; cleaner audit attribution.
- **Negative:** every `is_tenant_owner` check site migrates (H8/H16 propagation: 03 §4, 02 §5, 05 §1,
  09 §4, 12, 17 §4); role-escalation paths need tests (only an `owner` may grant `owner`).
- **Wiring:** [03 §4](../03-database-design.md), [02 §5](../02-architecture.md),
  [05 §1](../05-features-modules.md), [09 §4](../09-api-design.md), [12 §1/§4](../12-settings.md),
  [17 §4](../17-authentication.md), [10 M11](../10-roadmap.md), [00 §7](../00-overview.md).

## Revisit if

Enterprise customers need org-level custom roles / permission sets (the [29 §18](../29-settings-administration-architecture.md)
custom-roles row) — build the capability-set model on top of, not instead of, these four.
