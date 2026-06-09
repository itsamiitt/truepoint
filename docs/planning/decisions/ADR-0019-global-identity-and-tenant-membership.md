# ADR-0019 — Global identity + tenant membership

- **Status:** Accepted
- **Date:** 2026-06-09
- **Context doc:** [17-authentication.md](../17-authentication.md), [03-database-design.md](../03-database-design.md)
- **Amends:** [ADR-0006](./ADR-0006-per-workspace-multitenant-model.md) (the *user-scoping* clause only; the per-workspace **data** model stands)

## Context

[ADR-0006](./ADR-0006-per-workspace-multitenant-model.md) scoped a **user to exactly one tenant**
(`users.tenant_id`, `UNIQUE(tenant_id, email)`), so the same person is a **separate account per org** with
separate credentials and MFA. The redesigned auth flow ([ADR-0020](./ADR-0020-existence-revealing-identifier-first-and-registration.md))
and the product intent require the **Slack/Notion model**: one login (email/username + credentials + MFA)
that belongs to **many** orgs, where the person picks org → workspace after authenticating. A per-tenant
user can't carry one identity across orgs, and it makes the pre-tenant identifier lookup awkward (read
`users` before any tenant context). The per-workspace **data** isolation of ADR-0006 is unaffected.

## Decision

Make **`users` the global identity** — one row per person — and move org membership to a new
**`tenant_members`** table:

- **`users`** (global): keep the table name (so FKs like `contacts.revealed_by_user_id`,
  `workspaces.created_by_user_id`, `workspace_members.user_id`, `user_sessions.user_id`,
  `user_mfa_methods.user_id`, `trusted_devices.user_id` are untouched). Drop `tenant_id` and
  `UNIQUE(tenant_id, email)`; add **global** `UNIQUE(email)` (citext), an optional **global** `UNIQUE(username)`
  (citext), and `email_verified_at`. Password / MFA / sessions / passkeys / OAuth all hang off the global
  identity. The auth service reads it **before** any tenant is chosen, so `users` is **not** tenant-RLS-scoped.
- **`tenant_members`** (new): `id, tenant_id, user_id, is_tenant_owner, status (active|invited|removed),
  invited_by_user_id, created_at`, `UNIQUE(tenant_id, user_id)`. **`is_tenant_owner` moves here** from
  `users` (drift hazard **H8**). Tenant-scoped RLS via `app.current_tenant_id`.
- **`workspace_members`** unchanged structurally; a workspace membership **implies** a `tenant_member` of
  that workspace's tenant.
- **Per-workspace data + RLS GUC unchanged** ([03 §9](../03-database-design.md#9-row-level-security)): contacts/
  accounts stay per-workspace; isolation is still `app.current_tenant_id` / `app.current_workspace_id`.
- JWT claims unchanged (`sub`=user, `tid`=**selected** tenant, `wid`=**selected** workspace). "Switch org" is
  a token re-issue, like workspace switch.

## Rationale

One person = one credential set + MFA across every org is the modern multi-tenant standard and what the user
chose. It simplifies the identifier step to a single global email/username lookup, makes "pick org →
workspace" natural, and lets invites / domain-join / SSO-JIT simply **attach a membership** to an existing
identity. Keeping the `users` table name avoids rewriting every actor FK across the M1 import work.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Global `users` + `tenant_members` (this ADR) | Chosen | Unified login across orgs; simple lookup; minimal FK churn. |
| Per-tenant users ([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md) as-was) | Rejected | Same email = separate account per org; no unified login; re-register per org. |
| New `identities` table + rename `users` everywhere | Rejected | Heavy FK churn across M1 (`revealed_by_user_id`, …) for no functional gain. |

## Consequences

- **Positive:** one identity across all orgs; one MFA/passkey set; pre-tenant lookup is a clean global query;
  invites/domain-join/JIT just add a `tenant_member`.
- **Negative:** a migration that splits `users` (drop `tenant_id`, add global uniqueness) + adds
  `tenant_members` + backfills one membership per existing user; an email is now **one** account globally
  (you can't hold two unrelated accounts on the same email).
- **Mitigation:** keep the `users` name; backfill is mechanical (seed-only data today); a person joins more
  orgs via membership, never a second account.

## Revisit if

A segment needs the identity itself isolated per org (e.g. strict gov/regulated separation) — then revisit a
per-tenant identity for that segment.
