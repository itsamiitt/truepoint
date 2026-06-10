# ADR-0027 — Real-time delivery & event backbone

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context doc:** [20-event-driven-realtime-backbone.md](../20-event-driven-realtime-backbone.md), [02-architecture.md](../02-architecture.md)

## Context

The architecture already uses BullMQ queues, CDC→search, and Redis pub/sub (`02 §2/§3.2–§3.4`), but the
**event/real-time backbone is only described inline**: there is no domain-events catalog, no transactional
**outbox** guaranteeing "DB commit ⇒ event published", no documented DLQ/retry/idempotency contract, and
no real-time delivery spec for live UI updates (search-sync, inbox replies, notifications, automation).
At scale, "enqueue after commit" without an outbox drops events on crashes, and ad-hoc realtime can't meet
the freshness SLOs ([ADR-0024](./ADR-0024-performance-slos-and-capacity-model.md)).

## Decision

Formalize an **event-driven backbone** with a transactional outbox and a real-time delivery gateway
(detail in [20](../20-event-driven-realtime-backbone.md)).

- **Domain events:** a versioned catalog (e.g. `reveal.completed`, `score.updated`,
  `signal.received`, `outreach.status_changed`, `import.completed`, `record.updated`) carrying
  `tenant_id`/`workspace_id` + entity ids; the **single source of truth** for async consumers
  (search-sync, scoring, automation `ADR-0026`, webhooks, AI indexing).
- **Transactional outbox:** writers append an `outbox` row **in the same transaction** as the state
  change; a relay publishes to the queue/bus and marks it sent — **at-least-once**, crash-safe. Consumers
  are **idempotent** (event id + natural keys), reusing the money-path idempotency pattern (`H2`).
- **Queue topology + DLQ/retry:** per-domain BullMQ queues, bounded retries with backoff, a **dead-letter
  queue** with alerts, and documented **backpressure** (depth thresholds → autoscale + shed/slow
  producers) so workers never silently fall behind the freshness SLOs.
- **Real-time delivery:** an authenticated **SSE** stream (WebSocket where bidirectional) per
  user/workspace, fanned via Redis pub/sub across ECS instances, for live search-sync, inbox, scores,
  notifications, and automation status. Channels are RLS/visibility-scoped (`H18`).
- **CDC:** Aurora logical replication → search-sync worker → Typesense/OpenSearch/ClickHouse stays the
  index/analytics path; CDC and domain events are complementary (CDC for projections, outbox for
  semantics).

## Rationale

An outbox is the standard way to make "commit ⇒ publish" reliable without distributed transactions, and
idempotent consumers make at-least-once safe. A scoped SSE/WebSocket gateway over Redis pub/sub delivers
real-time UI within the freshness SLOs while keeping the monolith stateless and horizontally scalable.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Outbox + idempotent consumers + SSE gateway (this ADR)** | Chosen | Crash-safe events; reliable real-time; reuses BullMQ/Redis/CDC. |
| Enqueue-after-commit (no outbox) | Rejected | Drops events on crash between commit and enqueue. |
| Poll for updates (no realtime) | Rejected | Misses freshness SLOs; wasteful at scale. |
| Adopt Kafka now | Rejected | Operational weight not yet justified; revisit at very high event volume. |

## Consequences

- **Positive:** reliable async semantics; live UI; clean trigger source for automation (`ADR-0026`) and
  AI indexing; backpressure protects SLOs.
- **Negative:** outbox table + relay to build; SSE/WebSocket gateway + connection scaling to operate.
- **Mitigation:** reuse BullMQ/Redis/CDC; cap + scale SSE connections; DLQ + alerts; backpressure rules.

## Revisit if

Event volume or multi-region fan-out outgrows BullMQ/Redis — then introduce a log-based bus (e.g. Kafka)
behind the same event catalog.
