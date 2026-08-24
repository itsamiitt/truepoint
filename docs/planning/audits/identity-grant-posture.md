# `users` / `user_sessions` grant posture — evidence and options

> **Status:** 📐 Analysis + options. **Nothing here is implemented, and nothing here should be implemented
> without the security review 32 §6.4-2 already asks for.** Written 2026-08-22 while closing the RLS guard's
> pgTable blind spot, because the guard's exception ledger points at this gap and the ledger entry is thinner
> than the problem.
>
> What this adds to [32 §9.3-1](../32-database-audit-frontend-api-plan.md): the gap **re-verified against
> today's code** (the audit predates several REVOKEs, so "still open" needed checking rather than assuming),
> the specific exposures spelled out, and — most usefully — the reasons the two obvious fixes do not work as
> written. One of them fails for a Postgres semantics reason that would only surface after the change shipped.

---

## 1. Verified state, 2026-08-22

Both statements were re-checked against the current tree, not carried over from the audit.

| | `users` | `user_sessions` |
|---|---|---|
| RLS policy | **none** (`grep 'CREATE POLICY.*ON users' rls/*.sql` → nothing) | **none** (`rls/auth.sql` covers its siblings, not this) |
| REVOKE from `leadwolf_app` | **none** | **none, deliberately** — `applyMigrations` says so in a comment |
| Effective grant | blanket `SELECT, INSERT, UPDATE, DELETE` from the `GRANTS` block | same |
| Tenant key | none — global identity (ADR-0019/0020) | `tenant_id` and `workspace_id`, both **nullable** |

Seven sibling auth tables *are* revoked (`platform_staff`, `impersonation_sessions`, `jit_elevations`,
`support_notes`, `account_holds`, `announcements`, `retention_policies`, plus `auth_email_tokens`,
`trusted_devices`). These two are the ones left out, so the pattern exists and these are the exceptions to it.

## 2. What that actually exposes

Not "unrestricted DML" in the abstract — three specific things:

1. **`users.password_hash` is readable by the customer app role.** Argon2id, so not directly usable, but it is
   the highest-value column in the database and any SQL-injection or over-broad query under `leadwolf_app`
   returns it.
2. **`users.is_platform_admin` is WRITABLE by the customer app role.** This is the sharpest edge here: it is a
   privilege-escalation primitive. A single injected `UPDATE users SET is_platform_admin = true WHERE id = …`
   under the app role grants platform super-admin (ADR-0032). Nothing at the database layer prevents it.
3. **Every session row is readable cross-tenant.** The workspace-admin session views compensate in the query
   text — each joins `workspace_members` (which IS RLS-isolated under `withTenantTx`) and pins
   `user_sessions.workspace_id`. That is a correct control that lives in the wrong place: it holds only for
   as long as every future query remembers to write it, which is what "a RAW query bypasses the join" in the
   `applyMigrations` comment means.

## 3. Why the two obvious fixes do not work as written

### 3a. Blanket `REVOKE ALL ON users FROM leadwolf_app` breaks the product

`users` is joined from **20 sites across the repositories** to render display names and emails —
the workspace-admin session table (`userEmail`, `userName`), member lists, audit views. Those run under
`withTenantTx`, i.e. as `leadwolf_app`. Revoking the table denies all of them. This is why option (b) in the
audit ("move all access behind the auth service") is scoped as a rerouting project rather than a grant edit.

### 3b. Column-level REVOKE does **not** cut into a table-level grant

The tempting surgical version is:

```sql
REVOKE SELECT (password_hash), UPDATE (password_hash, is_platform_admin) ON users FROM leadwolf_app;
```

It reads like it removes exactly the two dangerous capabilities and leaves the 20 join sites working. **It
does nothing.** In PostgreSQL, table-level and column-level privileges are separate grants, and a
column-level REVOKE cannot subtract from a table-level one — the blanket `GRANT SELECT ON ALL TABLES` in the
`GRANTS` block keeps satisfying every column read. To get column granularity you must revoke the *table*
privilege and re-grant per column:

```sql
REVOKE SELECT, UPDATE ON users FROM leadwolf_app;
GRANT SELECT (id, email, username, full_name, avatar_url, created_at, …) ON users TO leadwolf_app;
```

That works, and it creates a standing obligation: **every column added to `users` afterwards is invisible to
the app role until someone remembers to grant it**, and the failure mode is a runtime `permission denied for
column`, not a build error. Worth taking only with a test that pins the granted column list against the
schema — otherwise it trades a known risk for a recurring outage.

One thing that makes this less scary than it looks, and is worth knowing before the review: **the login path
would not be affected either way.** `sessionRepository` and the identity lookups use the bare `db` handle,
which is the **owner** connection (`packages/db/src/client.ts:179`); only `withTenantTx` uses `leadwolf_app`.
The single unqualified `select().from(users)` — `findByEmailOrUsername`, the login lookup that would break
first under a column re-grant — runs on the owner connection. So both password verification and session
creation/rotation/validation are outside the blast radius.

### 3c. RLS on `user_sessions` keyed on `tenant_id` would hide legitimate rows

`tenant_id` is **nullable** and **optional at creation** (`CreateSessionInput.tenantId?`, and
`SessionContext.tenantId?` above it); nothing ever back-fills it — only `workspace_id` is updated later, by
`setWorkspace`. So a fail-closed predicate `tenant_id = current_setting('app.tenant_id')::uuid` silently
excludes every session created before an org was chosen.

Whether that matters depends entirely on the consumer, and here it does not much: the only `leadwolf_app`
reader is the workspace-admin view, which already pins `workspace_id` to the target workspace, so
NULL-tenant rows were never in its result set. The audit's option (a) — keying on
`user_id = current_setting('app.current_user_id')` — sidesteps the nullable column entirely and is the better
predicate for the self-service "my sessions" read.

## 4. Options, with what each actually costs

| | Change | Breaks | Leaves open |
|---|---|---|---|
| **A** | RLS policy on `user_sessions` keyed on `user_id` (self-service) + `workspace_id` (admin view) | nothing measured — the login path is owner-connection | `users` entirely |
| **B** | Revoke `users` table SELECT/UPDATE, re-grant the safe columns | nothing at the 20 join sites *if* the column list is right; a new column breaks at runtime | needs a column-list test to be safe |
| **C** | Route all `users`/`user_sessions` access through the auth service, REVOKE both (the audit's option b) | the 20 join sites must be rerouted through privileged audited reads | nothing — matches the sibling pattern |
| **D** | Do nothing more than today | — | all three exposures in §2 |

**A is separable and cheap and does not need C to happen first.** B is the one that removes the
privilege-escalation primitive, and it is also the one with a maintenance tail. C is the honest end state and
a project rather than a change.

## 5. What a reviewer should ask for before any of this lands

- An isolation itest per change, in the shape the repo already uses: `withTenantTx` as tenant A must see zero
  rows of tenant B's sessions, asserted by `session_user` rather than by intent.
- For B: a test pinning the granted column list against the Drizzle schema, so a new column fails the suite
  rather than production.
- Confirmation that no worker or sweep reads these tables under `leadwolf_app` — the audit's §9.3-2 notes
  ~40 raw-owner call sites across 18 repositories, and that inventory should be checked, not assumed.

## 6. Deliberately not done here

No grant, policy or migration was written. The audit flags this as decision-gated with security review
required either way (32 §6.4-2), the sharpest option (B) carries a recurring-outage tail that a human should
accept knowingly, and `user_sessions` is the auth spine: getting an RLS predicate wrong on the session table
locks every user out, which is not a failure mode to discover from a test refactor.
