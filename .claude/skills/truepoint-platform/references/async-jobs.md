# Async Jobs and Queues

Anything slow, bulk, fan-out, scheduled, or dependent on an external system runs
as a background job, not inside a request. A request that does heavy work blocks a
connection, times out under load, and gives the user a spinner that may never
resolve. This file is the job system every such feature uses.

The architecture pre-build pass asks "does this need a queue?" — this is the queue.

---

## What Is a Job (Not a Request)

Move to a job anything that is:

- **Slow** — takes more than a request budget (~hundreds of ms) to complete.
- **Bulk** — operates over many records (import a CSV, add 10k prospects to a
  list, bulk-enrich).
- **Fan-out** — one action triggers many writes or many notifications.
- **External** — depends on a third-party API that can be slow or down
  (enrichment, verification, sending email).
- **Scheduled/recurring** — re-indexing, retention sweeps, digest emails, usage
  rollups.

The request that triggers such work returns immediately with an accepted/queued
response (and a job ID the client can poll or subscribe to); the work happens on a
worker.

---

## The Queue

- TruePoint uses a durable job queue: **BullMQ on Redis**. `apps/api` is the
  **producer** (it enqueues work and returns a job ref), and `apps/workers` is the
  **consumer** (it boots the processors via `apps/workers/src/register.ts`). Jobs
  survive process restarts — an in-memory queue is not durable and loses work on
  deploy.
- **Queues are named by purpose** with their own concurrency and priority. The
  registered queues today are `imports`, `enrichment`, `firmographics`, `scoring`,
  `dedup`, `dsar`, and `outreach`, plus an `imports` **dead-letter queue**
  (`apps/workers/src/register.ts`). A slow queue (enrichment, bound by provider
  latency) must not starve a fast one (outreach) — separate queues, separate
  workers.
- **Priority and fairness**: a single tenant's huge bulk job must not monopolise a
  shared queue and delay every other tenant. Use per-tenant fairness (round-robin
  across tenants, or per-tenant concurrency caps) so one tenant's million-row
  import doesn't freeze everyone else's.

---

## Workers

- Workers (`apps/workers`) are **separate processes from the web/API tier**,
  scaled independently. Worker count scales with queue depth — this is a primary
  scaling lever (see `scaling-playbook.md`).
- A worker sets **tenant context** before touching data (RLS — see `tenancy.md`).
  A job carries its `tenant_id` (and `workspace_id` where applicable); the worker
  scopes to it. A worker that processes multiple tenants' jobs switches context per
  job — never runs cross-tenant under one context.
- Workers are **bounded** in concurrency and in the connections they hold (see
  `data-platform.md` pooling) — unbounded worker concurrency exhausts the database.

---

## Idempotency Is Mandatory

Queues deliver **at least once** — a job can run more than once (a worker dies
mid-job and it's redelivered; a retry fires). Every job must be safe to run twice.

- A job checks whether its effect already happened before doing it (does this
  record already exist? was this enrichment already fetched?).
- Record-creating jobs use the same idempotency-key + unique-constraint discipline
  as the API (see `api-contract.md`, `truepoint-data` data-model).
- Enrichment jobs check the enrichment cache first so a redelivery doesn't re-pay
  the provider (see `truepoint-data` enrichment-pipeline and operations FinOps).
- A non-idempotent job in this system is a duplicate-data or double-spend bug
  waiting for a redelivery.

---

## Retries, Backoff, and the Dead-Letter Queue

- **Transient failures retry** with exponential backoff and jitter (a network
  blip, a provider 503). A bounded retry count, not infinite.
- **After max retries, the job goes to a dead-letter queue (DLQ)** rather than
  vanishing or retrying forever. The DLQ is monitored (see `observability.md`) —
  a growing DLQ is an alert, and DLQ'd jobs are inspectable and replayable once
  the cause is fixed.
- **Permanent failures fail fast** — a malformed payload or a 4xx that won't
  succeed on retry is dead-lettered immediately, not retried 20 times.
- Failures are logged with the job ID and shape of the error — never the PII
  payload (see `truepoint-security` data-protection).

---

## Backpressure and Flood Protection

A job system that accepts unlimited work will eventually be buried.

- **Bound enqueue rate** for user-triggered fan-out — a user can't enqueue a
  million jobs in a tight loop (this is also a security/abuse limit — see
  `truepoint-security` api-security and the pre-build "misuse" question).
- **Watch queue depth**; when a queue backs up beyond a threshold, that is a
  signal to scale workers or shed/slow intake — not to let it cascade into
  database exhaustion.
- A backed-up queue must **degrade gracefully**, not take down the rest of the
  system. Isolate queues so one runaway queue doesn't starve the connection pool
  every other queue shares.

---

## Visibility Into Jobs

A job the user triggered needs a status they can see (this answers the pre-build
observability question for async work):

- Jobs have states the user/UI can read: queued, running, succeeded, failed.
- For bulk operations, progress is reportable ("412 of 5,000 enriched").
- Operationally, every queue exposes pending/running/failed counts and DLQ size
  to monitoring (see `observability.md`).

---

## Scheduled Jobs

- Recurring work (retention sweeps, re-indexing, digests, usage rollups) runs on a
  scheduler with a single owner — not duplicated across instances (a cron that
  fires on every instance runs N times). Use a leader/locked scheduler.
- Scheduled jobs are idempotent and observable like any other.

---

## Checklist

- Is anything slow/bulk/fan-out/external moved off the request into a job?
- Is the queue durable, named by purpose, and fair across tenants?
- Do workers set per-tenant context and hold bounded connections?
- Is every job idempotent (safe to run twice), enrichment-cache-aware where paid?
- Do transient failures retry with backoff and land in a monitored DLQ?
- Is user-triggered fan-out rate-bounded, and queue depth watched for backpressure?
- Can the user see job status, and can ops see queue/DLQ depth?
