# Observability

A feature you cannot see is a feature you cannot operate. At millions of users,
the first question when something breaks is always "what's happening and since
when?" — and without observability the answer is "we don't know." This file makes
observability part of building, not a thing bolted on after the first incident.

The architecture pre-build pass asks "how will we know when this is broken in
production?" — this is the answer, system-wide.

> **Implementation status:** the full stack below is the target, not yet wired.
> Today there is structured logging (e.g. `apps/workers/src/logger.ts`) but no
> distributed tracing/OpenTelemetry, no RED/USE metrics pipeline, and no codified
> SLOs/error budgets. Keep these as the standard to build toward; do not assume
> they already exist.

---

## The Three Signals

Every service emits all three:

1. **Logs** — structured, queryable records of discrete events.
2. **Traces** — the path of a single request across services, with timing.
3. **Metrics** — aggregate numbers over time (rates, latencies, counts).

They answer different questions: logs say *what happened*, traces say *where the
time/error was*, metrics say *how the system is behaving in aggregate and whether
to alert*.

---

## Structured Logging — and Never PII

- Logs are **structured (JSON)**, not free-text strings — so they can be filtered,
  aggregated, and alerted on. An event name, a `requestId`, a `traceId`, the
  actor's user ID, the tenant ID, a status — fields, not prose.
- **Never log PII, tokens, or secrets** (see `truepoint-security` data-protection
  and secrets). Log a prospect's ID and the shape of the problem, never their
  email; log that a request failed, never the request body. This holds especially
  in error logs, which are read exactly when something is going wrong.
- Every log line carries the `requestId`/`traceId` so logs, traces, and the API
  error envelope (see `api-contract.md`) all correlate.
- Log levels are used meaningfully: error = something needs attention; warn =
  notable but handled; info = significant events; debug = off in production.

---

## Distributed Tracing

- A request gets a **trace ID** at the edge that propagates through `api`, into
  jobs it enqueues, across to `search`/`realtime`, and to outbound provider calls.
- Tracing (OpenTelemetry as the baseline) shows where latency and errors actually
  are — which DB query, which provider call, which service hop. At scale, "the app
  is slow" is unactionable; "the enrichment provider call p99 tripled" is.
- Async jobs are traced too — a job carries the trace context of the request that
  enqueued it, so a slow user-visible flow can be followed into the worker.

---

## Metrics: RED and USE

- **RED for request-driven services** (`api`, `search`): **R**ate (requests/sec),
  **E**rrors (error rate), **D**uration (latency distribution, p50/p95/p99). Per
  endpoint and overall.
- **USE for resources** (DB, queues, Redis, workers): **U**tilisation,
  **S**aturation, **E**rrors. Connection-pool saturation, queue depth, Redis
  memory, worker concurrency — the things that fall over first (see
  `scaling-playbook.md`).
- **Business/health metrics** that reveal a broken feature even when nothing
  errors: enrichment success rate, search result latency, login success rate, DLQ
  size, signup rate. A drop in a usage metric is often the first sign of a silent
  break (the pre-build "would a dashboard show an unexpected drop?" question).

---

## SLOs and Error Budgets

Critical user-facing paths have a defined **Service Level Objective** — the target
for how often they work and how fast:

- e.g. "list and search reads succeed 99.9% and return under Xms at p95";
  "enrichment jobs complete within Y for 99% of jobs."
- The SLO defines the **error budget** — the allowed amount of failure. Burning
  the budget fast triggers a response; staying within it means the path is healthy
  enough to keep shipping features.
- SLOs are owned with the operations skill (incident response, on-call) and drive
  alerting — you alert on SLO burn and on resource saturation, not on every
  transient blip.

---

## Alerting

- Alerts fire on **symptoms users feel** (SLO burn, error-rate spikes) and on
  **leading indicators of collapse** (pool saturation, queue/DLQ growth, replica
  lag spiking), not on noise.
- Every alert has an **owner and a runbook** (see `truepoint-operations`
  runbooks). An alert no one knows how to act on trains people to ignore alerts.
- The pre-build "on-call runbook entry, even one sentence" requirement is where
  this starts for each feature.

---

## Wiring Observability Into a Feature

Like tests and dependency-wiring, observability is wired at build time, not after:

- The **primary success path emits an event/metric** (the analytics/health signal).
- **Failures log structured errors** that are alertable — enough context to act,
  zero PII.
- **Async work exposes** queue depth, success/failure, DLQ size.
- A **dashboard or metric exists** that would show this feature silently dropping.
- A one-line **runbook entry** says what to check first when it breaks.

---

## Checklist

- Are logs structured, correlated by `requestId`/`traceId`, and free of PII/secrets?
- Are requests traced across services and into jobs?
- Are RED metrics emitted per endpoint and USE metrics for DB/queue/Redis/workers?
- Do critical paths have SLOs driving error budgets and alerting?
- Do alerts fire on symptoms + saturation, each with an owner and a runbook?
- Does each new feature ship a success signal, alertable errors, and a runbook line?
