# Ownership and Sharing

Within a single org, not every user should see every record. A sales rep's
prospects, a team's list, an individual's deals — visibility inside the tenant is
its own access model, layered *on top of* tenant isolation. Tenant isolation
(RLS — see `truepoint-platform` tenancy) keeps orgs apart; this model keeps users
within an org appropriately scoped. Both are enforced server-side (see
`truepoint-security` access-control).

This is the model the original skills' coarse `customer|staff|admin` RBAC could
not express. It is a core CRM feature, not an edge case.

---

## The Default: Owner-Scoped Visibility

A record is, by default, visible to:

- its **owner** (`owner_id` — see `data-model.md`), and
- users explicitly granted access through **sharing** (below), and
- users whose **role** grants org-wide visibility (managers, admins).

It is **not** visible to other users in the org by default. A rep does not see
another rep's prospects unless they're shared, on a shared list, or the viewer has
an elevated role. This is the principle of least privilege applied inside the
tenant.

This default is deliberate: a CRM where everyone sees everyone's pipeline by
default leaks competitive/commission-sensitive information within the org and
doesn't match how sales teams actually operate.

---

## Sharing Is Explicit

Broader access is *granted*, never assumed. The sharing mechanisms, in order of
how they're typically used:

- **List-based sharing** — the primary, explicit sharing path. A List has its own
  visibility (private to owner, shared with named users, shared with a team, or
  org-wide). Sharing a list shares *visibility of its member prospects in the
  context of that list*. This is the main way collaboration happens, and it is the
  exception-to-the-default that the original skills' owner-scoped model needs.
- **Team visibility** — records owned by team members can be visible to the team
  (or to team leads) per the team's configuration. Expresses "the pod sees the
  pod's work."
- **Role-based org-wide visibility** — managers/admins with a role permission see
  across owners. A reporting or oversight role legitimately needs the whole org's
  data; that's a role grant, checked server-side.
- **Explicit per-record share** — a record shared directly with a named user
  (less common; for one-off collaboration).

Each of these is a *grant* that widens the default. None of them crosses the org
boundary — sharing is always within one tenant.

---

## How It's Enforced

Visibility is enforced on the server, on every read and write — never by hiding UI
(see `truepoint-security` access-control and frontend-security). The enforcement
composes two layers:

1. **Tenant scope (RLS)** — the query is already scoped to the org. (Platform
   tenancy.)
2. **Visibility scope** — *within* that org, the query further filters to records
   the user owns, has been shared, or their role lets them see.

Concretely, a list-prospects read for a normal rep resolves to: prospects in this
org **and** (owned by me **or** on a list shared with me **or** I have org-wide
read). A manager's same read drops the inner restriction because their role grants
it. The visibility predicate is built from the user's ownership, shares, team, and
role — never from a client-supplied flag.

Writes are scoped the same way and tighter: seeing a record (via a share) does not
imply being able to edit or delete it. Edit/delete check both the visibility scope
*and* the action permission (see `truepoint-security` access-control's
permission-AND-scope rule), and ownership-changing operations (reassign owner,
move between teams) are their own privileged actions, not side effects of a normal
update (mass-assignment — security access-control).

---

## Ownership Transfer and Reassignment

- Reassigning a record's owner (rep leaves, territory changes) is a **privileged,
  audited action** with its own permission — not something a user can do to an
  arbitrary record by editing a field.
- Bulk reassignment (a departing rep's whole book moving to another) is a
  bulk/admin operation: permission-gated, audited, and run as a job if large (see
  platform async-jobs).
- When a user is deprovisioned (SCIM offboarding — `truepoint-security`
  enterprise-iam), their owned records don't vanish — they're reassigned per
  policy. Orphaned ownership is a data-integrity problem.

---

## Why Not Just Roles

The original `canDo(role, action)` model answers "may this *kind* of user do this
*kind* of action" — necessary but not sufficient. It cannot answer "may this user
see *this specific record*," which depends on ownership and sharing, not just role.
Both checks are needed (the defence-in-depth rule in `truepoint-security`
access-control): role/permission for the *action class*, ownership/sharing scope
for the *specific record*. This file is the second half.

---

## Checklist

- Is the record visible by the owner-scoped default, and is any broader access an
  explicit grant (list share, team, role)?
- Is visibility enforced server-side by composing tenant scope (RLS) + visibility
  scope, built from the user's real ownership/shares/role — never a client flag?
- Does seeing a record (shared) correctly *not* imply editing/deleting it?
- Is changing owner / moving teams a privileged audited action, not a field edit?
- On deprovisioning, are owned records reassigned, not orphaned?
