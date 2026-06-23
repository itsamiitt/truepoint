# Caching

At millions of users, the database cannot answer every read directly. Caching is
how read paths scale. This file is the server-side caching strategy — distinct
from the frontend's TanStack Query cache, which only caches within one user's
browser (see architecture state-and-data). Both exist; this one protects the
backend.

The rule that makes caching safe: **a cache is only as correct as its
invalidation.** Every cached value has an explicit answer to "what makes this
stale, and how does the cache learn?"

> **Implementation status:** the deliberate-caching mandate below is the target;
> it is only partially wired today. Redis is currently used for BullMQ queues and
> rate-limiting, **not** as an identity-keyed key/value response cache — that layer
> does not exist yet. A partial DB-level cache does exist for paid provider calls
> via the `providerCalls` `request_hash` table (`packages/db/src/schema/intel.ts`).
> Edge/CDN today is the **Caddy reverse proxy** (`deploy/Caddyfile`), not a
> separate CDN. Build the Redis response-cache and edge layers toward the model
> below; do not assume they are already in place.

---

## The Layers

Read paths are served from the cheapest layer that can answer them:

1. **CDN / edge** — static assets (the frontend bundles, images) and genuinely
   public, cacheable responses. Served from the edge, never touching origin.
2. **Redis (shared application cache)** — hot data, computed aggregates, session
   lookups, rate-limit counters, the tenant directory. Shared across all backend
   instances so the cache is global, not per-process.
3. **Read replicas** — when a read isn't cacheable, it goes to a replica, not the
   primary (see `data-platform.md`).
4. **Primary** — only writes and read-your-own-write paths.

A read that hits the primary for data that thousands of users request is a scaling
failure — cache it or route it to a replica.

---

## What Redis Holds

- **Rate-limit counters** — shared so limits are global across instances (see
  `api-contract.md`, `truepoint-security` api-security).
- **Sessions / token lookups** — fast auth checks without a DB round-trip.
- **The tenant directory** (tenant→cluster, tenant→plan) — read on every request,
  changes rarely, cache aggressively (see `tenancy.md`).
- **Hot computed values** — dashboard tiles, per-tenant counts, "fit score"
  distributions: expensive aggregates refreshed by a job, not recomputed per
  request (see `data-platform.md` OLTP-vs-analytics).
- **Enrichment results** — so the same lookup isn't re-paid to a provider (see
  `truepoint-data` enrichment-pipeline; this is also a cost control — operations
  FinOps).

Redis holds **no durable source of truth and no unencrypted sensitive PII as a
primary store** — it's a cache and a coordination layer. Postgres remains the
system of record (see `truepoint-security` frontend-security/data-protection on
not stashing sensitive data loosely).

---

## Invalidation: Keyed to Mutations

Every cached value is invalidated by the mutation that changes its underlying data
— the server-side mirror of the frontend's query-key invalidation.

- **Cache keys are tenant-scoped** — `tenant:{tenantId}:prospect:{id}` (add
  `:ws:{workspaceId}` where the value is workspace-scoped). A cache key without the
  tenant is a cross-tenant leak through the cache; never cache tenant data under a
  key that isn't tenant-scoped.
- A mutation **invalidates the narrowest keys it affects** — updating a prospect
  invalidates that prospect and the lists it's in, not the whole tenant's cache.
- Prefer **short TTLs + explicit invalidation** over long TTLs and hope. A stale
  cache showing one tenant old data is a correctness bug; showing it *another
  tenant's*
  data is a breach (hence tenant-scoped keys).
- Computed aggregates are refreshed on a schedule or on the triggering mutation —
  whichever the freshness requirement demands.

---

## Cache Stampede Protection

When a hot key expires, thousands of requests can hit the database at once to
recompute it (a stampede). Guard the expensive ones:

- Use a lock/single-flight so only one request recomputes a hot key while others
  wait or serve the slightly-stale value.
- Stagger TTLs (jitter) so a class of keys doesn't all expire simultaneously.
- For the most expensive aggregates, refresh proactively via a job before
  expiry rather than lazily on a cache miss.

---

## What NOT to Cache

- **Anything you can't invalidate correctly.** If you can't name what makes it
  stale, don't cache it.
- **Per-user write-path reads** without read-your-own-write handling — you'll show
  a user their own change didn't take.
- **Tenant data under a non-tenant-scoped key** — ever.
- **Secrets or credentials** in a shared cache as plaintext.

---

## Checklist

- Is every read served from the cheapest layer that can answer it (edge → Redis →
  replica → primary)?
- Are all cache keys tenant-scoped?
- Does every cached value have an explicit invalidation tied to its mutation, with
  a short TTL as backstop?
- Are hot keys protected against stampede (single-flight, jittered TTLs)?
- Is Redis used as cache/coordination, with Postgres remaining the source of truth?
- Are rate-limit counters and the tenant directory in the shared cache, not
  per-instance?
