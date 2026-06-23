# Multi-Tenancy and Tenant Isolation

This is the most important file in the platform skill. TruePoint holds many
organisations' data in one system. The tenancy model decides how that data is
kept apart — and getting it wrong means one tenant sees another's pipeline. The
model is fixed here so every data path implements the same one.

Tenancy is **two-tier**: a `tenant_id` identifies the organisation, and a
`workspace_id` further scopes rows that belong to a workspace inside that tenant.
Both are carried explicitly and both are enforced by RLS.

The security skill's `access-control.md` covers *why* tenant isolation matters
and the application-level discipline around it. This file covers the *mechanism*
that makes the discipline structural rather than hopeful.

---

## The Model: Shared Schema, RLS-Enforced, Enterprise-Siloed

Three layers, decided once:

1. **Shared schema.** One Postgres schema. Every tenant-owned table has a
   non-null `tenant_id` (and a `workspace_id` where the row is workspace-scoped).
   This is the cheapest model to operate at the scale of millions of mostly-small
   tenants, and the only one where a single migration doesn't have to run
   thousands of times.

2. **Row-Level Security enforces isolation at the database.** Postgres RLS
   policies filter every query by the current tenant automatically. A query that
   forgets `WHERE tenant_id = ...` returns **zero rows**, not another tenant's
   data. Isolation stops being a thing every developer and every agent must
   remember on every query, and becomes a property the database guarantees. RLS is
   `ENABLE` + `FORCE` and fail-closed: the policy uses `NULLIF` on the GUC so a
   missing tenant context matches nothing rather than everything.

3. **Enterprise siloing for the few who need it.** Customers with data-residency
   requirements (EU-only), customer-managed encryption keys (BYOK), or
   contractual blast-radius isolation are assigned to a **dedicated database
   cluster**. A tenant→cluster routing layer sends their requests there. Everyone
   else shares the pooled cluster. The application code is identical; only the
   connection target differs.
   > **Implementation status:** not yet met in the codebase — there is a single
   > shared Postgres today and no tenant→cluster routing or region-pinning layer
   > (`packages/db/src/client.ts`). Dedicated clusters / data residency remain the
   > enterprise target, not a present capability.

---

## Why Not the Alternatives

State the decision *and* why, so it isn't relitigated:

- **App-level filtering only (`where: { tenantId }` everywhere, no RLS)** — what
  the original skills implied. Rejected as the *sole* mechanism: it defends the
  single most common CRM vulnerability with human discipline across millions of
  queries written by parallel agents. One forgotten filter is a cross-tenant leak.
  We keep the explicit filter as defence-in-depth, but RLS is the backstop.
- **Schema-per-tenant** — one Postgres schema per tenant. Rejected as the default:
  migrations must run per-schema (thousands of times), the catalog bloats, and
  connection/search-path management gets fragile at scale. Viable only for a small
  number of large tenants — which is what the siloing layer is for.
- **Database-per-tenant for everyone** — strongest isolation, operationally
  impossible for millions of tenants. Reserved for the enterprise silo tier.

The result is a **hybrid**: pooled shared-schema for the long tail, dedicated
clusters for the enterprise few. This is the realistic enterprise answer.

---

## How Tenant Context Is Established

Every request resolves to exactly one tenant (and a workspace where applicable),
and that context is set on the database session so RLS applies. This is the
load-bearing pattern — get it right once, centrally, and every query inherits it.
In this codebase it lives in `packages/db/src/client.ts` (`withTenantTx`), which
drops to the non-BYPASSRLS `leadwolf_app` role for the scope of the transaction.

```ts
// backend: middleware that runs on every authenticated request
// 1. the tenant/workspace come from the verified session token, NEVER from the body or a param
const { tenantId, workspaceId } = session

// 2. acquire a connection and set the tenant for the life of the transaction
await db.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL ROLE leadwolf_app`)
  await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
  await tx.execute(sql`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`)
  // every query inside this transaction is now RLS-scoped to the tenant/workspace
  return handler(tx)
})
```

The RLS policy on each table reads those settings, and is fail-closed via `NULLIF`
(a missing GUC matches nothing rather than everything):

```sql
ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospects FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON prospects
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
```

`USING` filters reads; `WITH CHECK` blocks writes that would place a row in
another tenant. Both are required — without `WITH CHECK`, a user could insert a row
stamped with someone else's `tenant_id`. `FORCE ROW LEVEL SECURITY` makes the
policy apply even to the table owner, so no application role escapes it.

---

## Rules for Every Data Path

- **Tenant context is set centrally, once, in middleware** — never per-handler,
  never optional. A handler that runs a query outside a tenant-scoped transaction
  is a bug.
- **`tenant_id` (and `workspace_id`) come only from the session.** Never trust a
  `tenant_id` (or any ownership ID) from the request body or query string for
  authorization. The client can lie about its tenant; it cannot lie about its
  verified token.
- **Every tenant-owned table has `tenant_id NOT NULL` and an RLS policy** (plus
  `workspace_id` where workspace-scoped). A new table without both is incomplete.
  Add the column and the policy in the same migration that creates the table (see
  `truepoint-data` data-model and the architecture `database.md`).
- **`tenant_id` is the leading column of composite indexes** on tenant tables, so
  every scoped query is index-supported (see `data-platform.md`).
- **Background jobs set tenant context too.** A worker processing a job for tenant
  X sets `app.current_tenant_id` to X (and `app.current_workspace_id` where
  applicable) before touching data. A job that runs without a tenant context, or
  that loops across tenants in one connection, must switch context per tenant
  explicitly — never run cross-tenant work under one tenant's context.
- **The pooler must not break RLS.** A transaction-mode pooler (RDS Proxy here;
  equivalent to PgBouncer transaction mode) is safe because the GUCs are
  `SET LOCAL` / transaction-local (`set_config(..., true)`), and the client runs
  with `prepare: false` for pooler compatibility. Never use session-level settings
  that outlive a transaction with a transaction pooler — they leak across tenants.
  (See `data-platform.md` on pooling.)

---

## Cross-Tenant Operations Are Special and Rare

A few legitimate operations span tenants: platform-admin analytics, billing
rollups, internal support tooling. These are the *only* code paths that run
without a single-org context, and they are:

- Restricted to the internal/platform-admin surface (`apps/admin`) and
  platform-admin roles (see `truepoint-security` enterprise-iam).
- Implemented with an explicit, audited "elevated" connection — the privileged
  `leadwolf_admin` role (`withPrivilegedTx` in `packages/db/src/client.ts`) — used
  by a tiny, reviewed set of functions, never the general query path. The everyday
  request path runs as the non-BYPASSRLS `leadwolf_app` role.
- Logged as privileged access. Every cross-tenant read by staff is auditable.

If a feature seems to need cross-tenant access and isn't one of these, it is a
design error — surface it rather than bypassing RLS.

---

## Routing a Tenant to Its Cluster

The siloing layer maps `tenant_id → cluster`. Most tenants map to `pool`; siloed
tenants map to their dedicated cluster.

> **Implementation status:** not yet met in the codebase — there is no tenant
> directory or tenant→cluster routing today; every request resolves to the single
> shared Postgres (`packages/db/src/client.ts`). The model below is the enterprise
> target; build toward it, do not assume it exists.

- The mapping lives in a small, highly-cached **tenant directory** (its own tiny
  store, replicated, read on every request — cache it aggressively; it changes
  rarely).
- Connection routing is resolved at the start of the request, before the
  tenant-scoped transaction opens.
- Moving a tenant from pool to a silo (an enterprise upsell, or a residency
  requirement appearing) is a **data-migration operation**, planned and run like
  any other (see `data-platform.md`), not a code change.

---

## The Mandatory Isolation Test

Because isolation is the highest-stakes property in the system, it is tested
explicitly and the test is required (see the architecture `testing.md`):

- A test seeds two tenants, authenticates as tenant A, and asserts that **every**
  read/list/update/delete endpoint cannot see or touch tenant B's records — by ID,
  by enumeration, by filter manipulation.
- A test asserts that a write attempting to set another tenant's `tenant_id` is
  rejected by `WITH CHECK`.
- These tests run in CI and block merge. A multi-tenant CRM without an automated
  cross-tenant isolation test is one refactor away from a breach.

---

## Checklist

- Does every tenant-owned table have `tenant_id NOT NULL` (plus `workspace_id`
  where workspace-scoped) and an RLS policy (`ENABLE` + `FORCE`) with both `USING`
  and `WITH CHECK`, fail-closed via `NULLIF` on the GUC?
- Is tenant context set centrally in middleware from the session, never the body?
- Are `app.current_tenant_id` / `app.current_workspace_id` transaction-local
  (`SET LOCAL`) so they are pooler-safe?
- Is `tenant_id` the leading column of the table's composite indexes?
- Do background workers set tenant context per job/tenant?
- Are cross-tenant operations restricted, audited, and limited to a tiny reviewed
  set of functions?
- Is there an automated cross-tenant isolation test in CI?
