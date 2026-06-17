# ADR-0039 — Bulk CSV enrichment pipeline (match-first, chunked, async)

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context doc:** [31-bulk-enrichment-pipeline.md](../31-bulk-enrichment-pipeline.md) (lead), [06-enrichment-engine.md](../06-enrichment-engine.md), [03-database-design.md](../03-database-design.md), [09-api-design.md](../09-api-design.md), [18-scalability-performance.md](../18-scalability-performance.md)
- **Extends:** [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) (matches a whole upload against the two-layer model), [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md) (charge-only-for-`valid` + credit-back applies per row)
- **Sibling ADRs:** [ADR-0037](./ADR-0037-bulk-match-first-resolution-and-candidate-index.md) (bulk match-first resolution & candidate index — amends [ADR-0015](./ADR-0015-entity-resolution-dedup-engine.md), extends [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md)), [ADR-0038](./ADR-0038-bulk-enrichment-billing-forecast-and-quota.md) (bulk billing, forecast & quota — extends [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md)/[ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md)/[ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md))

## Context

LeadWolf can already (a) **reveal/enrich a single contact on demand** — the per-field provider waterfall
with cache, breaker, and budget ([06 §4](../06-enrichment-engine.md#4-the-enrichment-flow-per-requested-field)),
charged honestly per verified result ([ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md)) — and
(b) **import a raw CSV** into a workspace as overlay copies with `source_imports` provenance ([03 §5](../03-database-design.md#5-data-layer)).
What it **cannot** do is the product enterprises actually buy from Apollo/ZoomInfo: take a customer's **sparse
CSV** (a list of names, companies, or partial emails) and **enrich every row against our own data** — overlay,
then the [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) global master graph — falling through to
paid providers **only** for the rows we genuinely don't have. The two existing capabilities, naively composed,
would be one provider call per requested field per row: for a 250k-row upload that is millions of calls,
catastrophically slow and expensive, ignoring that **most rows are already in our universe for free**.

We also have no control surface for a long-running, expensive, fan-out job: no way to estimate cost/match-rate
before committing the spend, no chunk/worker model, no per-row status, no resumable progress, and no
deliverable (enriched CSV + an unmatched report). Single-contact reveal is synchronous and cheap; a bulk run is
neither. This is the gap [doc 30](../31-bulk-enrichment-pipeline.md) opens and milestone **M17 — Bulk CSV
Enrichment (enterprise scale)** owns.

## Decision

Adopt a **match-first, chunked, asynchronous bulk-enrichment job model** (detail in
[doc 30](../31-bulk-enrichment-pipeline.md)). A bulk run is a first-class **job**, not a loop over single-reveal:
it matches each row against **our own data first** and pays a provider **only on the residual misses**.

**1. Job lifecycle (control plane).** A bulk run is an `enrichment_jobs` row moving through
`enrichment_job_status` ∈ `queued → estimating → awaiting_confirmation → running → completed`, with
`paused`, `failed`, and `cancelled` as off-path states. Upload goes to S3 via **presigned URL**, is parsed and
staged, then **estimated** (a sample is matched to forecast match-rate + credit cost, [ADR-0038](./ADR-0038-bulk-enrichment-billing-forecast-and-quota.md)).
The job **waits for explicit user confirmation** before spending — no surprise bill. On confirm it is split
into `enrichment_job_chunks` and fanned out across workers; each row lands in `enrichment_job_rows`
(**partitioned monthly**, like the other high-volume tables in [03 §12](../03-database-design.md#12-indexing-partitioning--scale-overlay-100m-master-graph-billions)).

**2. Match-first waterfall (per row).** Normalize the row's match keys (email blind index, registrable domain,
LinkedIn id, E.164 phone, name+company), then resolve in **strict cost order**, stopping at the first hit:

1. **Workspace overlay** — free; blind-index / exact lookup against the workspace's own contacts/accounts.
2. **Global master graph, Layer 0** — free; deterministic KV match + blocking/MinHash-LSH candidate
   generation behind a **`MatchPort`** ([ADR-0037](./ADR-0037-bulk-match-first-resolution-and-candidate-index.md)).
   This is **infra-gated** (the billions-scale candidate index is built over the M17 horizon) and is therefore
   seamed now behind a **`masterGraphMatcher` stub** so the pipeline ships and is testable before the index exists.
3. **Provider waterfall** — **only** on rows still unmatched after steps 1–2, reusing the existing
   `packages/core` waterfall + cache + circuit-breaker + budget ([06 §4/§5/§6](../06-enrichment-engine.md#4-the-enrichment-flow-per-requested-field)),
   so we never re-pay for what we already hold.

Each row records its `match_method` ∈ `deterministic_email | deterministic_linkedin | deterministic_phone |
deterministic_domain | fuzzy_name_company | provider | none` and its `match_outcome` ∈ `matched_internal |
matched_provider | unmatched | suppressed | error`.

**3. Persistence & billing reuse.** A matched/enriched row **upserts the overlay copy** and writes
`source_imports` + `provider_calls` exactly as single-reveal does — bulk is the same write path at volume, not
a parallel one. **Verification happens on reveal and we charge only for `valid`**, with credit-back, **per row**
([ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md)); internal matches that resolve from our own
already-revealed data are not re-charged. Forecast, per-row metering, and quota are owned by
[ADR-0038](./ADR-0038-bulk-enrichment-billing-forecast-and-quota.md).

**4. Queue, progress & delivery.** Fan-out runs on a dedicated **`BULK_ENRICHMENT_QUEUE = "bulk-enrichment"`**
with a **`"bulk-enrichment-dlq"`** dead-letter queue, isolating bulk load from the interactive reveal path.
Live **progress + match-rate** is exposed by **polling now**, upgrading to **SSE on the M12 event backbone**
([ADR-0027](./ADR-0027-real-time-delivery-and-event-backbone.md)) without an API change ([09 §2](../09-api-design.md#2-resource-model)).
On completion the job yields a **downloadable enriched CSV** and a separate **unmatched report**, both as
**S3 signed URLs**.

**SLO note.** Throughput, end-to-end completion, and match-rate figures in [doc 30](../31-bulk-enrichment-pipeline.md)
are **design targets, to be validated via k6 at M17** ([18 §10](../18-scalability-performance.md#10-load-soak--capacity-testing)),
not contractual promises.

## Rationale

Match-first is the whole point: the value proposition is "we already have most of these for free." Ordering
overlay → master graph → providers, and calling a provider **only** on the residual misses, is what makes the
product fast and affordable at enterprise scale instead of a linear pile of provider bills. Making it a **job**
with an `estimating`/`awaiting_confirmation` gate keeps the spend honest and predictable — the same trust wedge
[ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md) established, now applied before a large commit
rather than after a single reveal. Chunked fan-out on a dedicated queue + DLQ gives crash-safety, resumability,
and isolation from the interactive path, reusing the BullMQ/outbox machinery already in the stack
([ADR-0027](./ADR-0027-real-time-delivery-and-event-backbone.md)). Seaming Layer-0 behind a `MatchPort` +
`masterGraphMatcher` stub lets the pipeline land and be tested now, before the billions-scale candidate index
([ADR-0037](./ADR-0037-bulk-match-first-resolution-and-candidate-index.md)) is built. Reusing the existing
overlay write path + reveal/credit transaction means bulk inherits provenance, suppression-gating, and
charge-only-for-`valid` for free, with no second billing path to keep consistent.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Match-first, chunked, async job (this ADR)** | Chosen | Resolves most rows from our own data for free; pays providers only on residual misses; estimate-then-confirm keeps spend honest; chunked fan-out + DLQ is crash-safe and scales; reuses the overlay write path + reveal/credit + ADR-0013. |
| Naive per-row provider calls (one waterfall call per field per row) | Rejected | Slow and expensive at enterprise scale — millions of provider calls for a single large upload — and it ignores that the overlay + master graph already hold most rows **for free**; the exact anti-pattern this product exists to beat. |
| Synchronous in-request enrichment (extend single-reveal to a loop) | Rejected | A 250k-row run cannot complete in a request; no estimate/confirm gate, no resumability, no progress, no isolation from the interactive reveal path. |
| Match-first but **provider-only**, skipping the master graph | Rejected | Throws away the free Layer-0 matches that are the core advantage; reintroduces avoidable provider cost on rows we already have. |

## Consequences

- **Positive:** an enterprise bulk-enrichment product that resolves most rows for free; predictable, confirmed
  spend; reuse of the enrichment waterfall, cache, breaker, budget, overlay write path, and reveal/credit
  transaction (one billing path, not two); crash-safe resumable jobs; honest per-row charging and credit-back
  inherited from [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md).
- **Negative (consciously accepted):** new control-plane surface — three tables (`enrichment_jobs`,
  `enrichment_job_chunks`, `enrichment_job_rows`), three enums, a dedicated queue + DLQ, an estimate step, and a
  staged-upload/parse stage; Layer-0 matching is **infra-gated** and ships behind a stub until the candidate
  index exists ([ADR-0037](./ADR-0037-bulk-match-first-resolution-and-candidate-index.md)); progress is
  **poll-based** until the M12 event backbone lands SSE.
- **Mitigation:** the additive tables follow the existing partitioned-table pattern ([03 §12](../03-database-design.md#12-indexing-partitioning--scale-overlay-100m-master-graph-billions));
  the `masterGraphMatcher` seam means the pipeline is testable before the index exists, and the overlay-only and
  provider-only steps still deliver value with Layer-0 returning no matches; the polling→SSE upgrade is behind a
  stable API contract ([09 §2](../09-api-design.md#2-resource-model)); throughput/match-rate are stated as
  design targets validated by k6 at M17 ([18 §10](../18-scalability-performance.md#10-load-soak--capacity-testing)),
  never as fabricated promises.

## Revisit if

The free internal match-rate proves too low to justify match-first ordering (then weight the waterfall by
measured per-segment hit-rate), the dedicated `bulk-enrichment` queue can't absorb enterprise volume on BullMQ
(then move bulk fan-out to a log-based bus, same job contract), or sample-based estimation diverges materially
from realized cost/match-rate (then re-tune the estimator with [ADR-0038](./ADR-0038-bulk-enrichment-billing-forecast-and-quota.md)).
