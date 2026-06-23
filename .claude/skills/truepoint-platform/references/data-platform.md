# Data Platform — Scaling the Database

TruePoint's system of record is Postgres, holding tenant CRM data plus a large
prospect/company dataset (hundreds of millions of records at maturity). This file
is how that store scales to millions of users. It builds on `tenancy.md` (the
isolation model) and the architecture `database.md` (migration hygiene).

The architecture `database.md` covers *how to change schema safely* (reversible,
additive, indexed, immutable-once-deployed). This file covers *how the store is
shaped to handle load*. Both apply.

---

## The Tiers of Postgres

TruePoint runs more than one database role, not one giant instance:

- **Primary (OLTP)** — the writeable system of record for tenant CRM data. All
  writes go here. Kept lean and fast.
- **Read replicas** — asynchronous copies of the primary. Read-heavy paths
  (lists, detail views, dashboards) are routed to replicas to take load off the
  primary. Accept that replicas are *eventually* consistent — a read immediately
  after a write may lag; route read-your-own-write paths to the primary or read
  from cache (see "Replica Lag" below).
  > **Implementation status:** not yet met in the codebase — there is a single
  > Postgres and no read-replica routing today (`packages/db/src/client.ts`).
  > Read replicas are the scaling target.
- **Pooled cluster vs enterprise silos** — per `tenancy.md`, most tenants share
  the pooled primary+replicas; siloed enterprise tenants get dedicated clusters.
- **Analytics store (separate)** — heavy aggregate/reporting queries do **not**
  run on the OLTP primary. They run against a replica dedicated to analytics, or a
  warehouse fed by CDC (see "OLTP vs Analytics").

---

## Connection Pooling Is Mandatory

At millions of users with many stateless backend instances (and serverless web
functions), unpooled connections exhaust Postgres' connection limit almost
immediately — this is one of the first things that falls over under load.

- **A transaction-mode pooler** (RDS Proxy in this deployment; equivalent to
  PgBouncer transaction mode) sits in front of every cluster. Backend services
  connect to the pooler, not directly to Postgres.
- Transaction mode is compatible with the RLS tenant-context pattern *because*
  that pattern uses transaction-local settings — the GUCs are `SET LOCAL` per
  transaction (`set_config(..., true)`), and the client runs with `prepare: false`
  for pooler compatibility (`packages/db/src/client.ts`). Never use session-level
  state (session `SET`, advisory-lock-across-statements, prepared statements that
  span transactions) under a transaction pooler — it leaks between tenants and
  breaks correctness.
- Each service has a **bounded** pool size. The sum of all services' pools must
  fit within the pooler's and Postgres' limits with headroom. An unbounded pool is
  a self-inflicted outage.

---

## Indexing for Scale

The architecture `database.md` says "index any column used in WHERE/JOIN/ORDER BY."
At scale, add:

- **`tenant_id` leads composite indexes** on tenant tables. Because every query is
  tenant-scoped (RLS), `(tenant_id, <other>)` indexes serve the real query shape;
  an index on `<other>` alone is far less useful.
- **Cover the common query**, not just the column. A list sorted by
  `created_at` within a tenant wants `(tenant_id, created_at DESC)`.
- **Create indexes concurrently** on large tables so the migration does not lock
  writes (`CREATE INDEX CONCURRENTLY`).
- **Watch index bloat and unused indexes.** Every index slows writes; an index
  nothing queries is pure cost. Review periodically.
- **Partial and expression indexes** for skewed predicates (e.g. only index rows
  where `status = 'active'` if that's what's queried).

---

## Partitioning the Large Tables

A handful of tables grow without bound: activity/event logs, the prospect/company
dataset, call logs, audit. These are partitioned so no single table or index
becomes unmanageable.

> **Implementation status:** not yet met in the codebase — the high-volume tables
> (`enrichmentJobRows`, `activities`, `scores`, `intentSignals`, `providerCalls`)
> are plain, non-partitioned tables today. Keep the append-heavy → time-partitioned
> mandate as the target and partition these before they reach billions of rows;
> repartitioning a huge live table is painful.

- **Time-partition append-heavy logs** (activity, audit, calls) by month. Old
  partitions can be detached and archived to cold storage cheaply; queries that
  filter by time prune to the relevant partitions.
- **Consider tenant-aware partitioning** for the largest tenant tables only when a
  single tenant's volume justifies it — most do not, and over-partitioning hurts.
- Partition keys must be part of the query predicate to get pruning; a query that
  doesn't filter on the partition key scans every partition.

Decide partitioning when designing the table (see `truepoint-data` data-model),
not after it's already a billion rows — repartitioning a huge live table is
painful.

---

## OLTP vs Analytics

Reporting, dashboards, cohort queries, and "how many prospects across the whole
org by stage" are aggregate workloads that will crush an OLTP primary if run
against it.

- **Heavy aggregates run off the OLTP path** — against a dedicated analytics
  replica or a warehouse (e.g. fed by change-data-capture/logical replication).
- Per-user dashboard tiles that need fresh numbers use **pre-computed/cached
  aggregates** refreshed by a job, not a live `COUNT(*)` over millions of rows on
  every page load.
- The large prospect/company search dataset is served by the **search index**
  (see `truepoint-data` search-infrastructure), not by `LIKE`/`ILIKE` scans on
  Postgres. Postgres is the source of truth; the index is the query surface.

---

## Replica Lag and Consistency

Read replicas lag the primary by milliseconds to seconds under load. Design for it:

- **Read-your-own-write**: after a user performs a mutation, the immediate re-read
  must reflect it. Either read from the primary for that path, or serve the value
  from the just-updated cache, or use the optimistic-UI value the frontend already
  holds (see architecture state-and-data + dependency-wiring). Never show a user
  their write "didn't happen" because a replica lagged.
- **Cross-entity consistency**: don't assume a write to A and a read of B on a
  replica are in sync. Where it matters, read both from the same source.
- Most list/browse paths tolerate slight staleness — route them to replicas
  freely.

---

## Backups, Restore, and DR

A data platform isn't done until it can be restored.

- **Automated backups** with point-in-time recovery on every cluster, pooled and
  siloed alike. Encrypted at rest (see `truepoint-security` data-protection).
- **Restore is tested**, not assumed — a backup never restored is not a backup.
- **RPO/RTO are defined** per the operations skill's targets; siloed enterprise
  tenants may have stricter ones contractually.
- Cross-region replication for DR where availability requirements demand it;
  residency-constrained tenants replicate only within their permitted region.

---

## What NOT to Do

- Do not run application queries directly against Postgres bypassing the pooler.
- Do not use session-level connection state under the transaction pooler.
- Do not run reporting aggregates against the OLTP primary.
- Do not serve large-dataset search with SQL `LIKE` scans — use the index.
- Do not add an unbounded list endpoint — everything is cursor-paginated
  (`api-contract.md`).
- Do not create an index on a huge table non-concurrently in a migration.
- Do not let a single service open an unbounded number of connections.

---

## Checklist

- Are reads routed to replicas and writes to the primary, with read-your-own-write
  handled?
- Is a transaction-mode pooler (RDS Proxy / PgBouncer-equivalent) in front of
  every cluster, with bounded pools and `prepare: false`?
- Do tenant tables have `(tenant_id, …)` composite indexes matching the query shape?
- Are append-heavy/large tables partitioned with a prunable partition key?
- Do heavy aggregates run off the OLTP path?
- Are backups automated, encrypted, region-correct, and restore-tested?
