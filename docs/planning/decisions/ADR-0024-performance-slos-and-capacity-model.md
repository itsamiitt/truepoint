# ADR-0024 — Performance SLOs, capacity & scale-hardening model

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context doc:** [18-scalability-performance.md](../18-scalability-performance.md), [02-architecture.md](../02-architecture.md)

## Context

The platform targets **millions of users**, **thousands of concurrent users per workspace**, **100M+
overlay rows / billions in the master graph**, and **real-time** operations. The corpus has good
primitives (RDS Proxy, partitioning, Citus, Typesense/OpenSearch, BullMQ, CDC) but **no quantified
performance contract**: `02 §9` lists one example target (reveal p95 < 300 ms) and tooling, while
capacity, cache policy, connection-pool sizing, read-scaling, and the Citus cutover threshold are open
(`03 §13`). Without numbers, regressions can't be prevented and scaling decisions stay ad-hoc.

## Decision

Adopt an explicit **SLO + error-budget** model with per-endpoint latency budgets and a capacity plan
(full detail in [18](../18-scalability-performance.md)); these numbers are the contract `10`/`19` enforce.

- **Latency budgets (server-side p95 / p99):** masked search `200 / 500 ms`; reveal (in-tx) `300 / 800 ms`;
  list/grid page `150 / 400 ms`; record detail `150 / 400 ms`; import enqueue `100 / 300 ms`; export
  enqueue `100 / 300 ms`; AI assistive first-token `< 1.5 s`. **Availability SLO 99.9%** for the core API.
- **Async freshness SLOs:** enrichment job p95 `< 10 min`; scoring p95 `< 5 min`; search-sync (CDC→index)
  p95 `< 5 s`; bounce→suppression p95 `< 2 min`.
- **Concurrency/throughput:** design for **≥ 5,000 concurrent users per large workspace** and tenant API
  throughput governed by per-tenant quotas (`09`); stateless API horizontally autoscaled on ECS.
- **Caching policy (`18`):** typed cache tiers with explicit TTLs and **invalidate-on-write** for
  entity/entitlement/search-facet caches; no unbounded staleness on money/permission paths.
- **Connection pooling:** RDS Proxy transaction pooling with documented pool sizing + saturation behavior;
  `SET LOCAL` GUCs inside every tx (`H9`).
- **Read-scaling:** analytics/reporting served from ClickHouse + Aurora read replicas, **never** the
  primary writer; heavy exports off-loaded to workers.
- **Citus cutover:** master-graph golden tables move from single Aurora writer to Citus shards at a
  documented threshold (`18`); overlay scales on Aurora Serverless v2.
- **Error budgets:** each SLO has a monthly error budget tracked in `19`; budget burn gates risky releases.

## Rationale

Quantified budgets turn "fast at scale" into something testable (load tests, `18`) and observable (SLOs,
`19`). Routing analytics off the primary and fixing cache-invalidation rules removes the two most likely
sources of online-latency regression at scale.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Explicit SLOs + error budgets (this ADR)** | Chosen | Testable, observable, prevents regressions; standard SRE practice. |
| Keep informal targets (`02 §9` only) | Rejected | Unenforceable; no capacity or cache contract. |
| Over-provision instead of SLOs | Rejected | Cost-inefficient; still no regression guardrail. |

## Consequences

- **Positive:** load-testable contract; clear scaling triggers; protected online latency; budget-gated
  releases.
- **Negative:** SLO/error-budget machinery to build and maintain; load-test + capacity work.
- **Mitigation:** start with these targets, refine post-load-test; reuse existing observability tooling
  (`02 §9` → `19`).

## Revisit if

Measured production load shows the targets are wrong, or a new workload (e.g. very large exports, AI
traffic) needs its own budget.
