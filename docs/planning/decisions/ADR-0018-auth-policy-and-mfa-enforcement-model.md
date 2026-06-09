# ADR-0018 — Auth policy & MFA enforcement model

- **Status:** Accepted
- **Date:** 2026-06-08
- **Context doc:** [17-authentication.md](../17-authentication.md), [12-settings.md](../12-settings.md), [03-database-design.md](../03-database-design.md)

## Context

MFA, allowed login methods, IP allowlists, and session timeouts must be controllable at more than one
level: an individual user may opt into MFA, a workspace admin may require it for a team, and a tenant may
mandate it org-wide (Enterprise, [12 §4](../12-settings.md#4-tenant-settings-tenant-owner--billing--tier-as-noted)).
The same tension applies to disabling social login, requiring SSO, restricting IP ranges, and session
lifetime. Without one resolution rule, these settings would conflict across scopes and could be set in a
way that *weakens* a stricter parent policy. We need a single, predictable model for how per-scope auth
policies combine.

## Decision

Auth policy is expressed at two scopes and resolved as the **strictest applicable**:

- **`tenant_auth_policies`** (tenant owner / Enterprise): `mfa_enforcement ∈ off|optional|required`,
  `allowed_methods`, `disable_social`, `require_sso`, `ip_allowlist` (CIDR), `session_timeout`.
- **`workspace_auth_policies`** (workspace admin): an override of a **subset** — `mfa_enforcement`,
  `allowed_methods`, `session_timeout`, `ip_allowlist` — that may only **tighten**, never loosen, the
  tenant policy.
- **MFA enforcement levels** combine across user opt-in / workspace-required / tenant-mandated as
  `effective = max(user, workspace, tenant)` (a parent `required` always wins; a child can escalate but
  not relax).

The effective policy is computed at login and on each token refresh; method restrictions gate the
identifier-step routing ([17 §2](../17-authentication.md#2-progressive-identifier-first-login)), and
`session_timeout` bounds refresh-token lifetime ([17 §5](../17-authentication.md#5-session-token--device-architecture)).
Tables in [03 §4](../03-database-design.md#4-tenancy--auth).

## Rationale

"Strictest wins" is the only composition rule that can't be used to silently downgrade security: a tenant
mandate can't be undercut by a workspace or user setting, while teams handling sensitive data can still go
beyond the org baseline. Restricting workspace overrides to *tightening* keeps the tenant policy as a hard
floor. Re-resolving on refresh means a newly-mandated policy takes effect within the 15-min access-token
window without forcing immediate global re-login.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Two scopes, strictest-wins, workspace may only tighten (this ADR) | Chosen | Predictable; a parent policy is a hard floor; teams can escalate. |
| Most-specific-scope-wins (workspace overrides tenant either way) | Rejected | Lets a workspace **relax** a tenant mandate — a security downgrade. |
| Tenant-only policy (no workspace scope) | Rejected | Can't accommodate a high-sensitivity team inside a looser org. |
| Per-user enforcement only | Rejected | No org-wide guarantee; unenforceable for compliance. |

## Consequences

- **Positive:** no policy combination can weaken a stricter parent; Enterprise can mandate org-wide MFA/SSO;
  sensitive workspaces can exceed the baseline; one rule to reason about and audit.
- **Negative:** resolving the effective policy spans tenant + workspace lookups on the hot login path; a
  too-strict combination can lock users out (e.g. IP allowlist + required hardware key).
- **Mitigation:** cache resolved policy in Redis; recovery codes + an admin-reversible override
  ([17 §5](../17-authentication.md#5-session-token--device-architecture)) provide a break-glass path; policy
  changes are audited ([17 §9](../17-authentication.md#9-audit--events)).

## Revisit if

Customers need finer scoping (per-role or per-resource step-up policies) or conditional/risk-based access
beyond static IP allowlists (move toward a policy engine).
