# Access Control

This is the most important security file for TruePoint. A CRM's core risk is one
organisation seeing another's data, or one user reaching records they have no right
to. Most real-world CRM breaches are access-control failures, not exotic exploits.
Get this right and the largest class of risk is closed.

Access control here has two layers that compose: **tenant isolation** (keeping orgs
apart, enforced by the database) and **record-level visibility** (keeping users
within an org appropriately scoped). Both are server-enforced; neither relies on the
UI hiding anything.

---

## Layer 1: Tenant Isolation Is Enforced by the Database (RLS)

The original framing of this rule was "remember to filter every query by
`tenantId`." That is necessary but **insufficient as the sole mechanism** — it defends
the single most common and most damaging CRM vulnerability with human discipline,
across millions of queries written by many people and agents. One forgotten filter
is a cross-tenant leak.

**So tenant isolation is enforced at the database with Postgres Row-Level Security
(RLS)** (see **truepoint-platform** tenancy for the mechanism). Tenancy is **two-tier**:
a `tenant_id` on every tenant-owned table, plus a `workspace_id` where a table/row is
workspace-scoped. RLS is `ENABLE` **and** `FORCE` (so even the table owner is subject
to it), fail-closed via `NULLIF` on the GUC (an unset context matches nothing), and the
application connects as the non-`BYPASSRLS` role `leadwolf_app`:

- Every tenant-owned table has an RLS policy filtering by the current tenant (and
  workspace where applicable), set from the authenticated session on the connection. A
  query that forgets its tenant filter returns **zero rows**, not another tenant's data.
- The explicit `where: { tenantId }` / `where: { workspaceId }` filter is **kept as
  defence-in-depth** — belt and braces — but RLS is the backstop that makes a missed
  filter a non-event instead of a breach.

```ts
// Tenant context is set centrally from the session (never from the request body):
await db.transaction(async (tx) => {
  await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${session.tenantId}, true)`)
  await tx.execute(sql`SELECT set_config('app.current_workspace_id', ${session.workspaceId}, true)`)
  // every query in here is RLS-scoped to the session's tenant/workspace — automatically
  return handler(tx)
})
```

The `tenant_id` (and `workspace_id`) come from the authenticated session, **never**
from the request body or a query param. The client can lie about its tenant; it cannot
lie about its verified session token.

---

## The IDOR Threat (Insecure Direct Object Reference)

An attacker takes a request they're allowed to make and changes an ID to one they're
not:

```
GET /api/prospects/123     ← their own prospect, allowed
GET /api/prospects/456     ← someone else's — does the server stop them?
```

With RLS, prospect 456 in another tenant simply isn't visible to this session's queries
— the lookup returns null, the user gets a 404, and they learn nothing. Defence in
depth still applies in app code:

```ts
// ✅ explicit scope on top of RLS — both say no to another tenant's row
const prospect = await tx.prospect.findFirst({ where: { id, tenantId: session.tenantId } })
// returns null for another tenant's id → 404, indistinguishable from "doesn't exist"
```

A denied or missing resource returns the **same** response (a 404), so IDs can't be
enumerated by distinguishing "exists but not yours" from "doesn't exist".

> **Implementation status:** cross-tenant isolation is tested today only at the DB
> layer (`packages/db/test/workspaceSwitch.itest.ts` exercises the RLS GUC switch);
> there is **no per-endpoint IDOR/isolation test** asserting that an HTTP request for
> another tenant's/workspace's ID returns 404. Add per-endpoint isolation coverage
> before relying on app-code defence-in-depth as evidence.

---

## Layer 2: Record-Level Visibility Within a Tenant

Tenant isolation keeps orgs apart; it does not decide which users *within* an org see
which records. That is the ownership-and-sharing model (see **truepoint-data**
ownership-and-sharing), and it is enforced server-side too:

- A record is visible by default to its **owner**, to users it's **explicitly
  shared** with (list/team/per-record), and to users whose **role** grants org-wide
  visibility — not to every user in the org by default.
- The visibility predicate is built from the user's real ownership, shares, team, and
  role — **never** from a client-supplied flag. A normal rep's list query resolves to
  "in this tenant/workspace (RLS) AND (owned by me — `ownerUserId` — OR shared with me
  OR my role sees all)"; a manager's drops the inner restriction by role.
- **Seeing is not editing.** A record visible via a share doesn't imply the right to
  modify or delete it — write paths check the action permission *and* the visibility
  scope (below).

The original skills' coarse `customer|staff|admin` roles could not express this;
record-level visibility is a core CRM requirement, not an edge case.

---

## Defence in Depth: Permission AND Data Scope

Two independent checks guard every sensitive action; either alone is insufficient.

1. **Function-level authorization** — is this user's role allowed to perform this
   action at all? Checked via the permission model (see `enterprise-iam.md`).
2. **Object-level authorization** — is *this specific record* one the user may act
   on? Enforced by tenant scope (RLS) + visibility scope.

```ts
// 1. Function-level: is the role allowed the action?
if (!canDo(session, 'list.delete')) return forbidden()

// 2. Object-level: tenant scope (RLS) + ownership/sharing → can they touch THIS list?
const deleted = await tx.list.deleteMany({ where: { id: listId, tenantId: session.tenantId } })
if (deleted.count === 0) return notFound()   // not theirs / not visible / doesn't exist
```

Permission without scoping lets a user act on anyone's records; scoping without
permission lets a read-only role write. You need both.

---

## Authorization Lives on the Server

The UI hiding a button is not access control — an attacker calls the API directly.

- The design skill may hide an action a user can't perform — good UX.
- The security boundary is the API: every route authenticates, checks permission,
  and scopes data (tenant + visibility) regardless of what the UI showed (see
  `frontend-security.md`, **truepoint-platform** api-contract).
- Never reason "the button is hidden so they can't" — they can, by calling the
  endpoint. The endpoint must say no.

---

## Privilege Escalation via Fields (Mass Assignment)

If an update endpoint blindly applies the request body, a user can set fields you
didn't intend — and escalate:

```
PATCH /api/users/me   { "name": "Jordan", "role": "admin" }   ← made themselves admin
```

**Never spread a request body into a database update.** Allowlist exactly the fields
a user may change, and never include identity/ownership fields in what a user can
self-set:

```ts
// ✅ allowlist — only the fields they may change
const { name, avatarUrl } = req.body
await tx.user.update({ where: { id: session.userId, tenantId: session.tenantId },
                       data: { name, avatarUrl } })
```

Changing a record's owner, a user's role, or moving data between tenants are privileged
operations gated by their own permission checks (see `enterprise-iam.md` and
**truepoint-data** ownership-and-sharing) — never side effects of a general update,
and never settable by the user themselves. RLS `WITH CHECK` additionally blocks a
write that would stamp a row with another tenant's `tenant_id` (or `workspace_id`).

---

## Cross-Tenant Access Is Special and Audited

A few legitimate operations span tenants (platform-admin analytics, support tooling,
billing rollups). These are the only paths that run without a single-tenant context,
and they are restricted to platform-admin roles, implemented via a tiny reviewed set
of functions using an explicit elevated connection (the privileged `leadwolf_admin`
role) that bypasses tenant RLS, and **logged as privileged access** (see
**truepoint-platform** tenancy). Anything else needing cross-tenant access is a design
error to surface, not bypass.

---

## Checklist

- Is tenant isolation enforced by RLS (`ENABLE` + `FORCE`, fail-closed via `NULLIF`,
  app connecting as non-`BYPASSRLS` `leadwolf_app`) — not just an app filter — with the
  app filter kept as defence-in-depth, and `tenant_id`/`workspace_id` taken only from
  the session?
- Within the tenant/workspace, is record visibility enforced by ownership
  (`ownerUserId`)/sharing/role, built from real data, never a client flag?
- Is there both a permission check and object-level (tenant + visibility) scoping?
- Is the route authenticated, and does a denied/missing resource return an
  indistinguishable 404?
- Do updates allowlist fields, with `role`/`tenantId`/`workspaceId`/`ownerUserId`
  impossible to self-set (and RLS `WITH CHECK` blocking cross-tenant writes)?
- Are cross-tenant operations restricted to `leadwolf_admin`, reviewed, and audited?
