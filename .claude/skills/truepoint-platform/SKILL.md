---
name: truepoint-platform
description: >
  The backend and platform architecture skill for TruePoint — the system that
  actually has to serve millions of users. Use this skill whenever working on
  anything server-side or scale-related: the backend services, the database and
  its tenancy model, the API contract, async jobs and queues, caching, service
  boundaries, deployment, connection pooling, observability, or any question of
  the form "will this scale", "where does this run", "how is this data isolated",
  or "what breaks under load". This skill owns the decisions the architecture
  skill's pre-build pass asks about but cannot answer alone — tenancy, data
  platform, queues, caching, API shape, SLOs. If a change touches the server, the
  database, a queue, or how the system behaves at 10x load, this skill is active.
---

# TruePoint Platform Skill

This skill governs the part of TruePoint that determines whether it can serve
millions of users: the backend services, the data platform, and the cross-cutting
runtime concerns (tenancy, API, queues, caching, observability). The frontend
skills polish what users see; this skill is the machine underneath.

It exists because the architecture skill's pre-build pass asks the right scale
questions — *what breaks at 10x, does this need a queue, are connections pooled,
how is tenant data isolated* — but those questions need a fixed set of answers to
reason against. This skill is those answers.

---

## Which Skill, When

TruePoint has nine skills — six platform skills plus three `truepoint-extension-*`
skills for the browser extension (see the root `CLAUDE.md` routing table). Most real
features touch several.

- **truepoint-platform** (this skill) — the backend, the data platform, tenancy,
  the API contract, queues, caching, service topology, observability, scale.
- **truepoint-data** — the data *model* and the data *products*: the canonical
  schema, ownership/sharing semantics, the enrichment pipeline, verification, and
  search. Builds on this skill's platform.
- **truepoint-architecture** — WHERE frontend code lives and HOW it is structured.
- **truepoint-design** — HOW it looks and behaves in the browser.
- **truepoint-security** — WHETHER it is safe. Tenancy *enforcement* (RLS),
  access control, IAM, compliance.
- **truepoint-operations** — running it: incident response, FinOps, runbooks.
- **truepoint-extension-{architecture,linkedin,auth}** — the browser extension
  (`apps/extension`), which consumes this skill's `/api/v1` contract.

Take "build prospect search":
- Platform (this skill): the search service, the index, the read path, caching,
  pagination contract, rate limits, the async indexing job.
- Data: the index schema, the OLTP→index pipeline, relevance.
- Security: tenant filter baked into every query (enforced, not hoped).
- Design: the result list, virtualization, facets.

---

## The Foundational Decision: Architecture Shape

These two decisions are made once and everything else follows. They are not
re-litigated per feature.

### 1. Backend is a standalone service tier

The two frontend apps in the monorepo (`apps/web` = `@leadwolf/web`, the customer
surface; `apps/admin` = `@leadwolf/admin`, the internal/platform-admin surface)
are **pure Next.js presentation layers**. They do not own business logic, talk to
the database, or hold secrets. All of that lives in a separate backend service
tier (`apps/api` = `@leadwolf/api`), a standalone HTTP service built on **Hono
4.6.13 on Bun**, listening on its own port (3001), exposed as a versioned HTTP API.

Next.js route handlers (`app/api/`) exist only for **frontend-adjacent concerns**:
auth-cookie handling, BFF aggregation of a few backend calls into one
view-shaped response, and receiving the few webhooks the frontend domain owns.
They never query the database directly and never hold a provider API key. Anything
that reads or writes core data goes to the backend service.

Why standalone, not route-handlers-as-backend: at millions of users you need the
backend to scale, deploy, and fail independently of the web tier; you need
long-running workers and queues that have no place in a request/response web
process; and you need one API contract shared by the web apps, the Chrome
extension, and external integrations. A backend smeared across Next.js route
handlers cannot do any of these.

### 2. Multi-tenancy: shared-schema, RLS-enforced, with enterprise siloing

This is the single most important platform decision. **Read `references/tenancy.md`
before touching any data path.** The summary:

- One shared schema; tenancy is **two-tier** — every tenant-owned table carries a
  non-null `tenant_id` (plus a `workspace_id` where the row is workspace-scoped).
- **Postgres Row-Level Security (RLS) enforces isolation at the database**, so a
  query that forgets its tenant filter returns nothing rather than another tenant's
  data. Tenant scoping is therefore a property of the platform, not of every
  developer remembering to type `WHERE tenant_id = ...`.
- Large enterprise customers who require data residency, customer-managed keys, or
  blast-radius isolation are routed to **dedicated database clusters** by a
  tenant→shard routing layer. The long tail shares the pooled cluster.
  > **Implementation status:** not yet met in the codebase — there is one shared
  > Postgres today and no tenant→cluster routing layer (`packages/db/src/client.ts`).
  > Keep dedicated clusters / region-pinning as the enterprise target.

The security skill (`access-control.md`) owns the *enforcement discipline*; this
skill owns the *topology*. They describe the same wall from two sides.

---

## The Non-Negotiables

These hold for every server-side change. Each has a reference file.

- **Every data path carries tenant context.** The backend establishes the
  authenticated tenant on every request and sets it on the database session so RLS
  applies. No query runs without a tenant context. (`tenancy.md`)
- **The API is a versioned contract, not an accident.** Cursor pagination,
  `/api/v1/` versioning, an idempotency-key header on writes, one error envelope
  (RFC 9457), with request/response types defined by shared Zod schemas in
  `@leadwolf/types` as the single source of truth. (`api-contract.md`)
- **Anything slow, bulk, fan-out, or external is a job, not a request.**
  Enrichment, imports, exports, re-indexing, notifications run on queues
  (BullMQ on Redis) with idempotent workers and a dead-letter queue, consumed by
  `apps/workers` and produced by `apps/api`. (`async-jobs.md`)
- **Read paths are cached deliberately, with explicit invalidation.** CDN at the
  edge, Redis for hot data and counters, documented invalidation keyed to
  mutations. (`caching.md`)
- **Connections are pooled and bounded.** A transaction-mode pooler (RDS Proxy in
  this deployment; equivalent to PgBouncer transaction mode) in front of every
  cluster; no service opens unbounded connections. (`data-platform.md`)
- **Everything is observable.** Structured logs (no PII), distributed traces,
  RED/USE metrics, and an SLO per critical path. A feature you cannot see is a
  feature you cannot operate. (`observability.md`)

---

## Scale Discipline

Every feature is built against the question *"what does this look like at 10x
current load, and what breaks first?"* The pre-build pass asks it; this skill is
how you answer it:

- **Reads** scale on replicas and cache. A read path that only hits the primary
  will not scale — route it to a read replica and cache the hot slice.
- **Writes** scale on partitioning and async. A write that fans out (one action →
  many records or many notifications) becomes a job, never a synchronous loop.
- **Queries** scale on indexes and bounded result sets. No unbounded list, no
  full-table scan, no N+1. Every list endpoint is paginated by cursor.
- **Cost** scales with usage on metered subsystems (enrichment). Per-tenant
  quotas and caching are part of the feature, not an afterthought
  (see `truepoint-operations` FinOps and `truepoint-data` enrichment).

The full per-tier failure-and-scaling guide: `references/scaling-playbook.md`.

---

## Reference Files

Read the file matching your task. Do not read all of them.

| Task | Read |
|---|---|
| Anything touching tenant data; isolation model; RLS; sharding | `references/tenancy.md` |
| Database scaling, replicas, partitioning, pooling, backups | `references/data-platform.md` |
| Designing or changing an API endpoint; pagination; versioning | `references/api-contract.md` |
| Background work, queues, workers, scheduled jobs, fan-out | `references/async-jobs.md` |
| Server-side caching, CDN, Redis, invalidation | `references/caching.md` |
| Where a piece of backend logic lives; service boundaries; deploy | `references/service-topology.md` |
| Logging, tracing, metrics, dashboards, SLOs, alerting | `references/observability.md` |
| "Will this scale", what breaks under load, how to scale a tier | `references/scaling-playbook.md` |

---

## Companion Skills

This skill is the platform. It defers to **truepoint-data** for the data model
and data products that run on it, to **truepoint-security** for how tenancy and
access are *enforced* and for IAM/compliance, and to **truepoint-operations** for
running the system in production. The frontend skills (**architecture**,
**design**) consume this skill's API contract and never reach past it.
