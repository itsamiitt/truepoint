# ADR-0005 — Multi-tenancy: shared schema, org-scoped rows, global contact DB

- **Status:** Superseded by [ADR-0006](./ADR-0006-per-workspace-multitenant-model.md) (2026-05-29)
- **Date:** 2026-05-29
- **Superseded note:** The 2026-05-29 multi-tenant proposal replaced the global shared contact DB with a **per-workspace** model (each workspace owns its own contacts/accounts) and added a workspace layer. This body is retained as the record of the original shared-asset rationale that ADR-0006 consciously trades away.
- **Revived (as hybrid) by:** [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) (2026-06-09) — reinstates a **global shared contact DB as Layer 0** (the master graph) *beneath* the ADR-0006 per-workspace overlay. The shared-asset rationale below is **live again**, now as one layer of a two-layer model rather than the exclusive design.
- **Context doc:** [02-architecture.md](../02-architecture.md), [03-database-design.md](../03-database-design.md)

## Context

LeadWolf is B2B with **orgs + RBAC** (owner/admin/member/viewer), a shared org credit pool, and shared
lists. But the **contact database itself is the product's core asset** and should be searchable by
every customer — it is *not* per-tenant data. We need isolation for tenant state (credits, reveals,
lists, audit, suppression) while keeping the golden contact graph global. We also need this to be safe
(no cross-tenant leakage) and operable at 100M+ rows.

## Decision

- **Shared schema, single database.** One Postgres database; no per-tenant schemas or databases.
- **Two data classes:**
  - **Global (shared):** `companies`, `persons`, `field_provenance`, `raw_records`, `match_keys`,
    `merge_log`, `provider_calls`, `data_sources`, and **global** `suppression_list` entries. No
    `org_id`.
  - **Tenant-scoped:** `organizations`, `users`, `api_keys`, `reveals`, `credit_ledger`,
    `credit_balances`, `entitlements`, `lists`, `list_members`, `saved_searches`, **org**
    `suppression_list`, `dsar_requests`, `audit_log`, `stripe_customers`, `purchases`. All carry
    `org_id`.
- **Isolation enforced two ways:**
  1. **App layer:** a tenancy guard injects `org_id` from the authenticated context (never the request
     body) into every tenant-scoped query, propagated via AsyncLocalStorage.
  2. **Database:** **Row-Level Security** policies on tenant-scoped tables as defense-in-depth.
- **The meeting point** of the two classes is `reveals` (org × person) and suppression checks: an org's
  *ownership* of a contact (having revealed it) and its *suppression* preferences are tenant-scoped,
  while the contact data is global.

## Rationale

- A global contact DB maximizes product value (everyone benefits from all collection/enrichment) and
  avoids duplicating 100M+ records per tenant.
- Shared schema is operationally simplest at this scale (one migration set, one connection pool
  strategy) and works well with our partitioning plan.
- App-layer scoping + RLS gives belt-and-suspenders protection against cross-tenant leakage.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Schema-per-tenant | Rejected | Migration/ops nightmare at many tenants; contact DB shouldn't be per-tenant anyway. |
| Database-per-tenant | Rejected | Same, worse; defeats the shared-asset model. |
| App-layer scoping only (no RLS) | Rejected | One missed `WHERE org_id` = a breach; RLS is cheap insurance. |
| Per-tenant copies of contacts | Rejected | Massive duplication; breaks the shared-asset value prop. |

## Consequences

- **Positive:** one shared high-value dataset; simple ops; strong isolation for tenant state.
- **Negative:** RLS adds query overhead and care in policy design; the global/tenant split must be
  understood by every engineer (documented here + in [03](../03-database-design.md)).
- **DSAR nuance:** deleting a *data subject* affects the **global** record (and global suppression);
  deleting a *customer/org* affects only tenant-scoped rows. These are different operations — both
  documented in [08](../08-compliance.md).

## Revisit if
A large enterprise demands physical data isolation/residency — introduce a dedicated deployment or an
EU region partition for that tenant's tenant-scoped data (the contact DB remains shared per region).
