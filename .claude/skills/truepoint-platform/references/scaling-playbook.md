# Scaling Playbook

The pre-build pass asks "what breaks first under load, and when?" This file is the
standing answer: the known failure points by tier, and how each scales. Read it
when designing anything load-bearing, and consult it when the question is "will
this hold at 10x?"

The order below is roughly the order things fall over in an under-provisioned
system.

---

## 1. Database Connections (usually first)

**Breaks when:** many stateless `api`/worker instances each open connections and
exhaust Postgres' limit. This is the most common first failure at scale.
**Scales by:** a transaction-mode pooler (RDS Proxy here; equivalent to PgBouncer
transaction mode) in front of every cluster, bounded pools per service, the sum
fitting within limits with headroom (see `data-platform.md`). Never let a service
open unbounded connections.

## 2. The Primary Database (reads)

**Breaks when:** read-heavy paths (lists, dashboards, detail views) all hit the
primary and saturate it.
**Scales by:** routing reads to **replicas** and caching the hot slice in **Redis**
(see `caching.md`), with read-your-own-write handled. A read of data thousands of
users request should rarely touch the primary.

## 3. The Primary Database (writes / hot rows)

**Breaks when:** a write path fans out synchronously, or a hot row/table becomes a
contention point, or a huge table's queries slow as it grows.
**Scales by:** moving fan-out to **jobs** (`async-jobs.md`); **partitioning** large
append-heavy tables (`data-platform.md`); ensuring `(tenant_id, …)` indexes match
the query; never doing N+1 or unbounded scans.

## 4. Expensive Queries / Aggregates

**Breaks when:** reporting aggregates or `COUNT(*)` over millions of rows run on
the OLTP path on every page load.
**Scales by:** pre-computing aggregates via jobs into cache, running heavy
analytics off the OLTP path (analytics replica/warehouse), and serving large-
dataset search from the **search index**, not SQL scans (`truepoint-data`
search-infrastructure).

## 5. The Job Queue / Workers

**Breaks when:** a queue backs up (a flood of user-triggered jobs, a slow provider,
too few workers) and either delays everything or cascades into DB exhaustion.
**Scales by:** scaling workers on **queue depth**; separating slow and fast
queues; per-tenant fairness so one tenant can't monopolise; enqueue rate limits for
backpressure; isolating queues so one runaway can't starve the shared pool
(`async-jobs.md`).

## 6. External Provider Limits and Cost

**Breaks when:** enrichment/verification calls hit provider rate limits or run up
unbounded cost.
**Scales by:** server-side rate limiting per user/tenant, **caching results** to
avoid re-paying, cost-aware provider waterfall ordering, and per-tenant quotas
(`truepoint-data` enrichment-pipeline; `truepoint-operations` FinOps;
`truepoint-security` api-security).

## 7. The Search Engine

**Breaks when:** the index can't keep up with query volume or indexing lag grows.
**Scales by:** scaling the search cluster (shards/replicas), an indexing pipeline
that batches and keeps up, and caching common queries (`truepoint-data`
search-infrastructure).

## 8. Redis

**Breaks when:** memory fills or it becomes a single hot point for counters and
hot keys.
**Scales by:** TTLs and eviction policy, sharding/clustering Redis, and not using
it as a durable store. Stampede protection prevents recompute storms
(`caching.md`).

## 9. The API Tier

**Breaks when:** request volume exceeds instance capacity.
**Scales by:** horizontal scale behind the load balancer — which works *only*
because the tier is stateless (`service-topology.md`). If scaling instances
doesn't help, the bottleneck is downstream (DB, cache) — look there.

## 10. The Edge

**Breaks when:** static assets or public responses hammer origin; or a traffic
spike/attack overwhelms the front door.
**Scales by:** CDN for static and cacheable responses, and edge protection
(WAF/DDoS — see `truepoint-security` abuse-and-edge).

---

## How to Use This in Design

When designing a feature, walk its path through these tiers and name the first
thing that breaks at 10x:

- A new list endpoint → tiers 1–3: is it on a replica, cached, paginated, indexed?
- A bulk action → tier 5: is it a job, fair across tenants, rate-bounded?
- An enrichment feature → tiers 5–6: queued, cached, quota'd, cost-aware?
- A search feature → tiers 4, 7: index-served, not SQL-scanned?
- A new dashboard → tier 4: pre-computed aggregates, not live COUNT?

If you can't name how the feature behaves at each tier it touches, the pre-build
scalability question isn't answered yet.

---

## The Golden Rules

- **Reads scale on replicas + cache. Writes scale on async + partitioning.**
- **Everything user-triggered and expensive is bounded** (rate limits, quotas,
  pagination) — unbounded anything is a scaling and abuse hole.
- **Stateless tiers scale horizontally; stateful concerns live in shared
  infrastructure** (Redis, queue, DB) built to scale on their own terms.
- **Cost is a scaling dimension** for metered subsystems — design it in.
