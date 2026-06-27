# 06 — Storage & Scale (design)

> **Gate:** PLAN (design). Cites `00-overview.md` DM4 and `01-research-brief.md §2.5/§3.5`.
> **Posture: mostly reuse** — scalability is the most-locked dimension in the repo (`18` + ADR-0024).
> Net-new is a **consolidated index-strategy view** for owner+tenant queries, the **projection/search
> pattern** for lakh-row filtered search, and a **scale-gate for the new dimensions** (verifier,
> sync). **No code changes in this gate.**

## 1. Reuse map (cite — do not re-derive)

| Already designed / built | Where |
|---|---|
| Two-tier tenancy: overlay FORCE-RLS (workspace GUC) + Layer-0 by access path | `db/src/rls/contacts.sql:17-48`, `masterGraph.sql`; ADR-0006/0021 (`01 §3.5`) |
| Scale targets: millions of users, 100M+ overlay rows, billions golden | `18 §1`; ADR-0024 |
| SLOs/latency budgets (search p95 200ms, reveal 300ms, …) + async freshness SLOs | `18 §2` |
| Capacity model + autoscale units (ECS, Aurora Sv2, Citus, search nodes) | `18 §3`; ADR-0024 |
| Connection pooling: RDS Proxy transaction pooling + **GUC-per-tx discipline (H9)** | `18 §4`; `db/src/client.ts:64-84`; `03 §9` |
| Caching tiers + invalidation (money/permission never stale) | `18 §5` |
| Read-scaling off replicas/ClickHouse; consistent-snapshot bulk export | `18 §6` |
| Per-tenant rate limits / quotas / backpressure | `18 §9` |
| Deferred engine topology: OpenSearch (global) + ClickHouse (facets) + Typesense (overlay), CDC-fed | ADR-0021/0035; `prospect-company-data` PLAN_05 |
| Layer-0 sharding (Citus), S3+Iceberg lake, partitioning | ADR-0021; `03-database-design.md §5` |

**Conclusion:** the scale contract is locked. Net-new is synthesis + the new dimensions' scale-gates.

## 2. Net-new A — consolidated index strategy (owner-scoped + tenant-scoped)

The brief asked for the index strategy for owner+tenant queries. It exists across files; this
consolidates it as one design view (cite, don't re-create):

| Query pattern | Index | Where |
|---|---|---|
| Workspace isolation (every read) | RLS predicate on `workspace_id` (B-tree via FK/PK) | `rls/contacts.sql` |
| "My prospects" (owner filter) | `idx_contacts_ws_owner (workspace_id, owner_user_id)` | `schema/contacts.ts` |
| Hot leads | partial `idx_contacts_ws_priority_score (workspace_id, priority_score DESC) WHERE deleted_at IS NULL AND priority_score IS NOT NULL` | `schema/contacts.ts` |
| Custom-field facets | GIN `idx_contacts_custom_fields_gin` on `custom_fields` | `schema/contacts.ts` |
| Account rollups | `idx_contacts_ws_account (workspace_id, account_id)` | `schema/contacts.ts` |
| Per-workspace dedup | UNIQUE `(workspace_id, email_blind_index)`/`linkedin_public_id`/`sales_nav_lead_id` | `schema/contacts.ts` |
| Master keys (Layer 0) | UNIQUE `linkedin_public_id`, `primary_domain`, `email_blind_index`, `phone_blind_index`; GIN trgm on names | `03 §5.1` |

**Design rule (net-new):** every new owner/tenant-scoped access path added by `02`–`07` must lead its
composite index with `workspace_id` (so RLS + the filter share one index), and use a **partial** index
where the predicate is selective (the `priority_score`/`deleted_at` pattern). New keys (e.g. the
optional LinkedIn URN, `02 §2.2`) get a **partial** index `WHERE <col> IS NOT NULL`.

## 3. Net-new B — projection / search-table pattern (lakh-row filtered search)

- **Today:** Postgres-native faceted search runs **inside `withTenantTx`** so RLS is the hard boundary
  (`db/src/repositories/searchRepository.ts`): term/numeric/boolean facets + keyset pagination over
  `contacts`/`accounts`. Adequate for per-workspace overlay scale (~100k–lakh rows).
- **Deferred (scale track):** the billions-row **global masked** search moves to OpenSearch
  (sharded inverted index, `search_after`) + ClickHouse facet counts + Typesense for the overlay,
  fed by CDC / a `search_outbox` (ADR-0021/0035; PLAN_05). Permissions are **re-checked at read** —
  the index is a candidate generator, never an authorization bypass.
- **Design rule (net-new):** the overlay search stays Postgres-native + RLS-bound until a workspace's
  overlay crosses the Typesense envelope; the global search is the deferred engine path. A projection
  table/materialized view is justified only when a query can't be served by an index within the `18 §2`
  SLO — and it inherits the same scoping predicate (DM4).

## 4. Net-new C — scale-gate for the new dimensions

| New dimension | First bottleneck at 10x | Fix |
|---|---|---|
| **Verification** (`03`) | SMTP-probe throughput (port-25 limits, greylisting) | async job + rotating IP pool/proxy; cache results; re-verify at point of use (`18` async-freshness SLO; `prospect-company-data` PLAN_06) |
| **Sync** (`07`) | CRM API rate limits (SF ~100k req/day; HubSpot 100/batch) + write fan-out | batch (100/call), upsert-on-key, diff-and-write-changed-only, 429 backoff; ride the per-tenant queue quotas (`18 §9`) |
| **Compliance** (`05`) | Art.14 notice fan-out + DNC scrub volume | batch the 1-month sweep; set-based suppression (`08 §3.1`); cache DNC within the 31-day window |
| **Identity** (`02`) | bulk MATCH-AGAINST candidate gen | deferred scale track (blocking/LSH/Splink-on-Spark) |

## 5. RLS / scoping implications

Unchanged and load-bearing (DM4): overlay `ENABLE`+`FORCE` RLS on the fail-closed workspace GUC, set
tx-local by `withTenantTx`; Layer-0 carries no `workspace_id` and is isolated by **grant-off** (no
`leadwolf_app` DML on `master_*`). The **GUC-per-tx discipline (H9)** is mandatory under RDS Proxy
transaction pooling (`prepare:false`; GUCs reset per checkout) — any new repository path opens its
scope via `withTenantTx`/`withErTx`/`withPrivilegedTx`, never a raw connection (`18 §4`; `client.ts`).

## 6. Failure modes

- **F1 — a new query bypasses RLS via a raw connection / wrong role:** prevented by the
  `with*Tx`-only rule (H9); a raw-connection path is a review blocker.
- **F2 — search index used as an authorization grant:** prevented by re-checking permissions at read;
  the masked global index never returns PII channels (`prospect-company-data` PLAN_00 §6.2).
- **F3 — connection-pool saturation hangs requests:** RDS Proxy queues then **fail-fast 503**, never
  hangs (`18 §4`).
- **F4 — analytics load on the OLTP writer:** reports/exports read replicas/ClickHouse (`18 §6`).

## 7. Open questions

1. **When does the overlay search cross the Typesense envelope** (the scale-track trigger) — owner:
   `truepoint-operations` (inherited from `prospect-company-data` PLAN_00 §11.6).
2. **Where Layer 0 physically lives pre-scale** (same Aurora separate schema vs separate DB) —
   inherited freeze input (PLAN_00 §11.4); shapes the projection boundary.
3. Verifier/sync egress + queue sizing — owner: platform/ops (depends on `03`/`07` vendor choices).
