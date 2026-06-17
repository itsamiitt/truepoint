# ADR-0036 — Bulk import/export as a first-class async job + staging pipeline

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context doc:** [30-bulk-import-export-pipeline.md](../30-bulk-import-export-pipeline.md), [05-features-modules.md](../05-features-modules.md), [18-scalability-performance.md](../18-scalability-performance.md), [28-enterprise-readiness-audit.md](../28-enterprise-readiness-audit.md)
- **Supersedes / extends:** the MVP synchronous per-row CSV import ([05 §3](../05-features-modules.md)) — the column-mapping UI, per-workspace dedup keys, and `source_imports` provenance stand; the **execution model** (single `imports` worker, per-row insert) is replaced by the job-resource + staging pipeline below.
- **Amends:** [ADR-0015](./ADR-0015-entity-resolution-dedup-engine.md) (dedup-before-enrich is now an explicit staging step, not a side effect of the unique-index upsert), [ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md) (bulk operations reserve credits once per batch via a lease, not per row).
- **Backs:** G-IMP-1 ([28 §3.3](../28-enterprise-readiness-audit.md)) — pre-commit validation preview + downloadable rejected-rows file; enables G-IMP-2/G-IMP-6 (revert-by-batch, resumable chunked upload).

## Context

The MVP import ([05 §3](../05-features-modules.md)) is a **synchronous, per-row** path on the single
`imports` BullMQ worker ([01 §4](../01-tech-stack.md#4-background-workers)): an HTTP request carries the file,
rows are parsed and inserted one at a time, dedup happens implicitly via the
`(workspace_id, email_blind_index)` / `linkedin_public_id` / `sales_nav_lead_id` unique indexes, and the
importer gets a synchronous new-vs-matched summary. This is correct at thousands of rows and **cannot** do a
million:

- **Synchronous request lifetime.** A million-row file does not parse, dedup, and insert inside any sane HTTP
  timeout; the whole job is hostage to one connection that can drop mid-stream with no resume point.
- **Per-row inserts.** One `INSERT … ON CONFLICT` per row through RDS Proxy is round-trip-bound; it never
  reaches the throughput the [18 §1](../18-scalability-performance.md) bar implies for bulk I/O, and it holds
  index/lock pressure on the live `contacts`/`accounts` tables for the entire run.
- **No accounting, no resume, no revert.** A failure at row 600k leaves a half-applied import with no
  watermark to resume from, no three-way per-row accounting (success / failed / unprocessed), no
  rejected-rows artifact (the G-IMP-1 gap), and no batch handle to revert (the G-IMP-2 gap).
- **No upload safety.** A multi-GB file streamed through the API has no AV-scan/quarantine gate and no
  resumable/multipart path (the G-IMP-6 gap).

Both reference designs treat bulk I/O as an **asynchronous job resource**, never a synchronous call:

- **Salesforce Bulk API 2.0** models a job as an explicit state machine —
  `create → upload (PUT CSV) → close (UploadComplete) → server-side process → poll (JobInfo) → fetch results`
  (`successfulResults` / `failedResults` / `unprocessedrecords`) — with the **server owning chunking** into
  batches and three-way per-row result accounting.
- **HubSpot's batch/import API** likewise accepts a file/import, validates and stages it, returns an import id
  to poll, and exposes per-row errors and an error file for download.

The same shape (presigned upload, server-owned chunking, staged validation, poll-for-status, downloadable
rejected rows) is the floor for Apollo/ZoomInfo/Clay-grade bulk I/O. The companion master spec
([30-bulk-import-export-pipeline.md](../30-bulk-import-export-pipeline.md)) details the surface; this ADR
**locks the execution architecture** that doc and its siblings build on.

## Decision

**Bulk import/export is a first-class async job processed through a presigned-S3 upload → stream-from-S3 →
COPY-to-staging → INSERT…ON CONFLICT pipeline, idempotent / checkpointed / resumable, behind the `imports`
BullMQ queue with a dead-letter queue (DLQ).** No bulk row data ever transits a synchronous API request.

**1. Job resource + state machine.** A bulk operation is a persisted **`import_jobs`/`export_jobs`** resource (sibling tables owned by
[03](../03-database-design.md)) with a Salesforce-2.0-shaped state machine:

```
created → upload_pending → uploaded → av_scanning → validating
        → staged → committing → completed
                              ↘ failed → (DLQ)        ↘ partial (some rows failed, accounted)
```

Each transition is recorded; the client **polls** job status and never holds the work open on a request.

**2. Presigned / multipart S3 upload + AV-scan gate.** The API issues a **presigned (multipart) S3 PUT**; the
client uploads directly to S3 (resumable, multi-GB, off the API path). On `uploaded`, the object lands in a
**quarantine prefix** and an **AV scan** must pass before the job advances to `validating` — an infected or
unscanned object can never reach staging. This closes G-IMP-6 (resumable upload) and adds the missing upload
safety gate.

**3. Flat-memory streaming parse + server-owned chunking + backpressure.** The worker **streams the object
from S3** (never buffering the whole file in memory), parses with bounded memory, and **the server owns
chunking** into ~10k-row chunks. Chunk processing applies **backpressure** so a giant file cannot exhaust the
worker or the DB connection pool.

**4. COPY → (UNLOGGED) staging → dedup → chunked upsert.** Per chunk:
`COPY` into an **UNLOGGED staging table** → **dedup within staging** (dedup-before-enrich, [ADR-0015](./ADR-0015-entity-resolution-dedup-engine.md))
→ chunked `INSERT … ON CONFLICT (…) DO …` from staging into the live `contacts`/`accounts` using the existing
per-workspace unique keys. `COPY` + set-based upsert replaces the per-row insert path entirely. A per-row
conflict policy (keep-existing / overwrite / review — G-IMP-5) is applied at the `ON CONFLICT` step.

**5. RLS constraint (critical).** Postgres **`COPY FROM` is unsupported on tables with row-level security
enabled**, and our workspace-scoped tables are all under RLS via `SET LOCAL app.current_workspace_id` on a
non-`BYPASSRLS` role ([03 §9](../03-database-design.md)). Therefore the **staging tables are NOT RLS tables**
(system-owned, keyed by `job_id` + `workspace_id` columns); the pipeline `COPY`s into non-RLS staging, then
moves rows into the live RLS tables with **`INSERT … SELECT` executed under `SET LOCAL app.current_workspace_id`**
(and `app.current_tenant_id`) so RLS and tenant isolation are enforced on the write into the live tables. The
GUC is set per transaction and reset per pooled connection (RDS Proxy transaction pooling, [03](../03-database-design.md)).

**6. Idempotency + checkpoint / resume.** Each job carries a **batch idempotency key**; each chunk has a
deterministic id. A **resume watermark** records the last committed chunk so a retried or DLQ-replayed job
**resumes** rather than re-applies — re-running a job is a no-op past the watermark. Chunk-level upserts are
idempotent by the unique keys.

**7. Three-way per-row accounting + rejected-rows artifact.** Every row resolves to **success / failed /
unprocessed** (Salesforce's three buckets). Failed/rejected rows are written to a **rejected-rows file in S3**
(downloadable, with row number + reason), and a **pre-commit preview** (counts, errors, dup ratio) is surfaced
before `committing` — directly satisfying **G-IMP-1**.

**8. Revert-by-batch.** Because every applied row is tagged with its `job_id` and carries a `source_imports`
row, a job is **revertible by batch** within a window (G-IMP-2); revert is itself an audited job.

**9. Bulk credit reservation.** Where bulk side effects spend credits, the job reserves credits **once per
batch via a lease** ([ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md)) — not per row — and settles
against actual processed counts; side effects (enrichment, events) are **safe-by-default** (off unless
explicitly requested) with **bounded event fan-out** rather than one event per row.

**10. Async export (symmetric).** Export is the same job resource in reverse:
**keyset cursor under a consistent snapshot → stream → gzip → S3 multipart**, polled for completion, returning
a presigned download URL — never a synchronous response.

**11. New bulk-job API (owned by [09](../09-api-design.md)).** The presign / create-job / close / poll-status /
fetch-results (rejected file, preview) endpoints are specified by [09](../09-api-design.md); this ADR fixes
their **semantics** (async, poll-based, three-way results), not their wire shape.

## Rationale

Treating bulk I/O as a job resource is the one decision both reference designs converge on, and it is what makes
every downstream guarantee possible: a poll-based state machine removes the synchronous-timeout ceiling;
`COPY` → UNLOGGED staging → set-based upsert is the only path that reaches bulk throughput without hammering the
live tables; the watermark makes failures resumable instead of corrupting; three-way accounting + the
rejected-rows file is exactly the G-IMP-1 deliverable; and routing everything through the existing `imports`
queue + a DLQ reuses the worker topology we already run rather than inventing a new one. The RLS/`COPY FROM`
constraint forces the non-RLS-staging-then-`INSERT…SELECT`-under-GUC shape — this is a hard Postgres limitation,
so it is locked here rather than rediscovered in implementation.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Async job resource + presigned-S3 + COPY-to-staging pipeline (this ADR)** | Chosen | Matches Salesforce Bulk API 2.0 / HubSpot; only path to million-row throughput with resume, accounting, and revert; reuses the `imports` queue + DLQ. |
| Keep synchronous per-row import, just raise timeouts / add a spinner | Rejected | Does not survive a million rows — no resume, no accounting, no upload safety; per-row inserts never reach throughput. |
| Per-row inserts on the live RLS tables, no staging | Rejected | Round-trip-bound; holds lock/index pressure on live `contacts`/`accounts` for the whole run; no clean revert handle. |
| `COPY FROM` directly into the live RLS tables | Rejected | **Impossible** — `COPY FROM` is unsupported on RLS tables; the non-RLS staging step is mandatory. |
| One event / one credit decrement per row | Rejected | Unbounded fan-out and ledger contention; replaced by bounded fan-out + a single per-batch credit lease ([ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md)). |

## Consequences

- **Positive:** million-row import/export becomes correct and resumable; G-IMP-1 (preview + rejected-rows
  file) is satisfied and G-IMP-2/G-IMP-6 (revert-by-batch, resumable upload) are unblocked; bulk writes stop
  pressuring the live tables; AV-scan gate adds upload safety; the existing `imports` queue + DLQ is reused.
- **Negative (accepted):** new moving parts — the `import_jobs`/`export_jobs` job-resource + UNLOGGED **non-RLS** staging tables
  (owned by [03](../03-database-design.md)), a bulk-job API surface (owned by [09](../09-api-design.md)),
  an AV-scan/quarantine step, and the asymmetry that staging is **not** RLS-protected (mitigated: system-owned,
  `job_id`+`workspace_id`-keyed, written-then-moved into live RLS tables under `SET LOCAL` GUC).
- **Operational:** UNLOGGED staging trades crash-durability for speed (acceptable — a crashed chunk is replayed
  from the watermark); chunk size (~10k) and concurrency are governors that must respect the
  [18 §1](../18-scalability-performance.md) throughput SLOs and the RDS Proxy pool budget.

## Revisit if

- The single `imports` worker saturates → split a dedicated `bulk` queue / worker pool (the job resource is
  already queue-agnostic).
- `COPY` into UNLOGGED staging is no longer the throughput bottleneck → reconsider partitioned live tables or
  Citus-side bulk paths ([03 §9](../03-database-design.md)).
- Postgres lifts the RLS `COPY FROM` restriction → the non-RLS staging hop could be simplified.
