# 00 — Overview

> **TruePoint Forge — Enterprise Data-Platform Audit & Implementation Blueprint**
> Prepared as a Principal Data Architect / Platform Engineering / Data Governance review.
> Audience: engineering leadership. Scope: the nested Forge platform (`apps/forge`,
> `apps/forge-api`, `apps/forge-worker`, `packages/forge-core`, `packages/forge-capture-sdk`,
> Postgres schema `forge`) and its relationship to the main TruePoint platform.

## What this is

Twenty-one documents that (1) audit the Forge implementation as it exists in the repository
today, without assuming it is correct; (2) research the 2025–2026 state of the art for every
subsystem an enterprise data platform needs; and (3) lay out a phased, costed, migration-safe
blueprint to take Forge from a scaffold to the single source of truth for all data entering
TruePoint — a platform meant to stand comparison with ZoomInfo, Apollo, Clearbit, and Cognism.

The review is grounded in the actual code (every claim carries a `file:line` citation) and in
primary research (every external claim carries a URL). Where the codebase does not yet meet a
mandate, that gap is stated as work to do, never softened.

## The headline

**Forge is a well-shaped scaffold that does not yet run end to end, and it has drifted from
its own design.** ~5,200 lines landed in one wave on 2026-07-07. The medallion skeleton
(ingest → parse → AI-extract → resolve → verify → sync), the entity-resolution scorer, the
four-eyes promotion gate, and the hash-chained audit are all present and thoughtfully written.
But no captured record can currently traverse the pipeline: the parse stage cannot write to
its own database, AI extraction throws its output away, the sync stage has no scheduler, the
browser extension writes to a stub endpoint that stores nothing, and the four-eyes gate that
protects the golden layer is bypassable by a single operator. None of this is caught, because
there is no Forge integration test in CI.

Three themes run through every document:

1. **Reconcile plan and build.** The frozen planning suite (`docs/planning/forge/`) specifies a
   *separate repository* with an *HTTP* sync contract, *six database roles*, and a real capture
   SDK. The build is *nested*, syncs *in-process*, uses *one role on the owner connection*, and
   ships the SDK as a *stub*. We recommend **ratifying the nesting** and formally amending the
   plan — the nested shape is the right call for a small team — while adopting the plan's rigor
   (outbox, provenance, governance) that the build skipped.

2. **Make it correct before making it big.** The defects in `01-current-architecture-audit.md`
   are cheap now and ruinous later. Phase **F1** fixes them while capture and sync are dark and
   volume is zero.

3. **Buy nothing heavyweight; spend the savings on compliance.** Postgres remains the system of
   record well past 500M records; the only near-term new substrates are cheap object storage
   (raw archive) and ClickHouse (telemetry). The budget that saves goes to the legal and
   governance work — Art-14 notices, US data-broker registration, DPDP — which is where
   sales-intelligence vendors actually fail.

## Document map

| # | Document | What it covers |
|---|---|---|
| 00 | Overview | This document |
| 01 | Current-architecture audit | The canonical problem inventory (**P-01.x**), what works, what is broken |
| 02 | Enterprise data platform | The target architecture and the medallion-as-vocabulary model |
| 03 | Data-ingestion architecture | The one capture path, envelope v2, the extension, connectors |
| 04 | Data-quality framework | Validation, contracts, scoring, decay, verification states |
| 05 | Entity resolution | One ER engine: blocking → scoring → clustering → survivorship |
| 06 | Identity graph | The person/company graph in Postgres, employment edges, hierarchies |
| 07 | Data governance | Provenance, lineage, DSAR, retention, suppression, compliance spine |
| 08 | Pipeline architecture | Outbox, per-record state, idempotency, DLQ, reconciliation, orchestration |
| 09 | Storage strategy | Postgres at scale, object storage, ClickHouse, when the lakehouse arrives |
| 10 | Search & indexing | The 3-phase path: engineered Postgres → ParadeDB → OpenSearch |
| 11 | AI-assisted processing | The extraction cascade, cost engineering, AI for data quality, HITL |
| 12 | Observability | OTel, metrics catalog, freshness SLOs, the DATA plane, dashboards |
| 13 | Security | Tenant isolation, the write-path threats, credentials, secrets, the interception question |
| 14 | Performance & scaling | The volume model, the two hard ceilings, scale-out triggers |
| 15 | Cost optimization | Infra, LLM, verification, object-storage economics; build-vs-buy |
| 16 | Technology recommendations | The consolidated stack decisions and the duplication kill-list |
| 17 | Phased implementation roadmap | F1–F4, sequencing, dependencies, effort |
| 18 | Risk analysis | The risk register with likelihood/impact/mitigation |
| 19 | Migration plan | Dual-run, backfill, flag gating, cutover, rollback |
| 20 | Final recommendations | The decisions leadership must make, in priority order |

## The four phases (defined in full in doc 17)

- **F1 — Correctness & Truth (weeks 0–8, P0).** Make the built pipeline real, safe, and tested.
  Fix the parse FK break, persist extraction output, add the sync/maintenance schedulers, unify
  the blind index and content hash, make four-eyes server-enforced, recompute hashes and measure
  sizes server-side, persist DLQ and quarantine, wire forge integration tests in CI, and decide
  the one capture path. Capture and sync stay dark except on synthetic/staging tenants.
- **F2 — Enterprise platform core (months 2–5, P1).** Provenance-first data model; raw payloads
  to object storage; transactional outbox + per-record pipeline state + reconciliation; one ER
  engine end to end; DSAR executor + suppression ledger; quality scoring; ClickHouse telemetry;
  OpenTelemetry + SigNoz; real per-tenant AI budgets; Anthropic Batch API + caching.
- **F3 — Scale & governance (months 5–9, P1/P2).** Partitioning; ParadeDB search; CDC fan-out;
  the ten operator surfaces; the compliance spine (Art-14 notices, US registrations, DPDP);
  audit hardening; a durable-workflow engine for the human-review DAG; eval harnesses.
- **F4 — Scale-out & enterprise (months 9+, P2/P3).** OpenSearch at 30–50M+; DuckLake over the
  archive; read replicas → Citus if needed; residency/silo options; contributory-network and
  active-learning options.

## The recommended stack, in one paragraph

Keep **Postgres** as the system of record (it scales past 500M records with partitioning,
replicas, and pooling — OpenAI runs 800M users on one primary + replicas). Add **Cloudflare R2**
as the immutable raw-capture archive (zero egress makes reprocessing free) and **single-node
ClickHouse** for pipeline telemetry and event analytics. Keep **BullMQ**, but make **Postgres
the pipeline's source of truth** via a transactional outbox and a per-record state table, so a
Redis wipe becomes a re-enqueue, not a data loss. Resolve identity with **one Postgres-native ER
engine** (deterministic ladder → Fellegi-Sunter, weights trained offline in Splink/DuckDB →
review queue → union-find → field-level survivorship). Extract with a **deterministic-first
Claude cascade** (JSONPath/Zod mappers → Haiku via the Batch API → Sonnet escalation → Opus for
evals), cached by content hash. Search evolves **Postgres → ParadeDB → OpenSearch**. Observe with
**OpenTelemetry + SigNoz**. Adopt **Hatchet or DBOS** for the durable human-review workflow only
when the hand-rolled state machines exceed two or three flows. Buy nothing heavyweight; the
compliance work is the real spend.

## How to read this

Leadership can read 00, 01, 17, and 20 for the full decision picture. Engineers implementing a
subsystem should read 01 (for the defects in their area), the relevant target-state document
(02–16), and the roadmap slice in 17. Every target-state document follows the same structure:
executive summary, current state, problems, research, best practices, recommended architecture,
implementation details, migration, risks, success metrics, effort, and future enhancements.
