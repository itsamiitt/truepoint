# 16 — Technology Recommendations

> **Priority:** P1 · **Effort:** decision reference (the convergence work is scoped into F1–F3) ·
> **Phase:** decisions now; duplication kill-list executes F1–F2 · Cite problems as **P-01.x**.

## Executive summary

This document consolidates the stack decisions that docs 02–15 make individually into one decision
table, and it defines the **duplication kill-list** — the fourteen concerns currently implemented
twice across Forge and the main app (P-01.31). Two messages dominate. First, the client's stated
preference (open-source, self-hostable, low-ops, build-internal over expensive SaaS) is the *correct*
posture at this scale and is achievable: **Postgres is the system of record well past 500M records,
and the only near-term new substrates are cheap object storage and single-node ClickHouse.** Nothing
heavyweight — no Iceberg, no Kafka, no data mesh, no managed ER — is warranted yet, and each has an
explicit adoption trigger rather than a default. Second, **the duplication is the most urgent
technical debt in the platform**, because two of the fourteen pairs (the blind index and the content
hash) are *identity-critical* — they silently break dedup, cross-system matching, and DSAR — and must
converge first (P-01.6). The savings from buying nothing heavyweight fund the compliance work that
`07-data-governance.md` and `15-cost-optimization.md` identify as where sales-intelligence vendors
actually fail.

## Current state

The stack as-built mirrors the main platform by design (planning decision L7): **Bun 1.3.14 + Turbo +
Biome + Hono + Postgres/Drizzle (hand-authored migrations; `drizzle-kit generate` is unsafe here) +
BullMQ/Redis + Next 15 + `@leadwolf/ui` + Anthropic**, with `Bun.S3Client` for object storage as the
one net-new substrate. That mirroring is a strength — one toolchain, one mental model. The weakness is
that the *mirroring produced duplication*: rather than sharing the main app's blind index, content
hash, ER scorer, worker primitives, rate limiter, S3 client, and approval engine, Forge re-implemented
each, and they have already drifted at the seams (`16` §duplication below; fact-pack §6.6).

## Problems identified

- **P-16.1 (= P-01.31) — DEBT · Fourteen concerns exist twice.** Enumerated in the kill-list below;
  the identity-critical pairs corrupt data, the rest raise maintenance cost and drift risk.
- **P-16.2 — DEBT · Two object-storage clients in one integrations package** — the hand-rolled SigV4
  `s3FileStore` ("no AWS SDK enters the repo") and `forgeObjectStore` on `Bun.S3Client` — with
  different auth/config/error surfaces against the same class of storage.
- **P-16.3 — RISK · `drizzle-kit generate` is unsafe in this repo** (stale snapshots re-add dropped
  tables); all migrations are hand-authored (fact-pack §2.3). Any recommendation that assumes
  generated migrations is wrong here.

## Research findings

The per-topic research is in the sibling documents and fact-pack §7–§11; the load-bearing points that
drive the table: Postgres scales to 500M+ on one primary + replicas (OpenAI runs 800M users this way);
ClickHouse gives 10–20× compression for events at ~$200–400/mo self-hosted; Cloudflare R2 has zero
egress (free reprocessing); MinIO is no longer a safe default (community edition maintenance-mode Dec
2025) so SeaweedFS/Garage are the self-host fallbacks; Splink is free and proven at this ER scale while
Senzing/AWS-ER/Tamr are six-figure buys; ParadeDB brings BM25 into Postgres with no sync pipeline;
Hatchet/DBOS are the TS-native durable-workflow options vs Temporal's self-host burden; SigNoz is one
ClickHouse-backed app vs Grafana LGTM's three systems; DataHub/OpenMetadata each cost ≥0.5 FTE and are
overkill. Sources are cited in the respective documents (`05`, `08`, `09`, `10`, `11`, `12`, `15`).

## Enterprise best practices

A disciplined data platform makes each substrate earn its place with a trigger, keeps one system of
record, derives everything else from it, and shares identity/normalization logic in exactly one place
because divergent normalization is the classic silent-dedup-failure bug. It buys managed services only
where the operational burden exceeds the license cost (which, at this scale, is almost nowhere), and it
treats duplicated identity logic as a correctness defect, not a style issue.

## Recommended architecture

### A. The consolidated technology table

Every cell is grounded in the sibling document named in "Detail". Costs are self-hosted monthly
estimates unless noted; "trigger" is the condition that justifies moving to the next tier.

| Concern | Chosen | Why | Rejected | Est. cost | Scale ceiling | Maint. | Adoption trigger | Detail |
|---|---|---|---|---|---|---|---|---|
| System of record | **Postgres (existing)** | Scales past 500M; RLS tenancy; one store | Citus/Neon/Oriole now | existing VM + replica ($100–500) | ~500M–1B rows / low-TB before scale-out | low | — | 09 |
| Raw archive | **Cloudflare R2** | Zero egress = free replay; S3 API | S3 (egress), MinIO (dead) | ~$15/TB | none practical | low | now | 09 |
| Backup / 2nd copy | **Backblaze B2** | $6.95/TB, free egress via CF | — | ~$7/TB | — | low | now | 09,19 |
| OLAP / telemetry | **ClickHouse (single node)** | 10–20× compression, sub-s aggregates | Pinot/StarRocks (ops) | $200–400 | tens of TB / tens of B rows | med | event tables >100–200M rows | 09,12,14 |
| Ad-hoc query | **DuckDB over R2 Parquet** | zero-infra, cheap | MotherDuck (repriced up) | ~$0 | — | low | now | 09 |
| Lakehouse (later) | **DuckLake (PG catalog)** | metadata in existing PG, no JVM | Iceberg (no TS writer, premature) | object storage | — | med | raw >1–5 TB multi-writer | 09 |
| Job queue | **BullMQ (existing)** | 10M jobs/day ≪ limit; team knows it | pgmq/pg-boss now | Redis (existing) | tens of K jobs/s | low | — | 08 |
| Pipeline truth | **Postgres outbox + state table** | Redis-wipe becomes re-enqueue | dual-write (unsafe) | eng time | — | med | now (F2) | 08 |
| Durable workflow | **Hatchet or DBOS** | Postgres-backed, TS SDK | Temporal self-host, Airflow | Hatchet: +1 svc; DBOS: $0 infra | 10K runs/s | med | >2–3 HITL flows | 08 |
| ER engine | **Splink-trained FS in Postgres** | free, explainable, proven at scale | Senzing ($58.6K/yr), AWS ER ($25K/pass) | ~$0 + batch box | 100M+ (incremental) | med | match quality revenue-blocking → Senzing | 05 |
| ER weight training | **Splink/DuckDB sidecar (offline)** | PG backend experimental; DuckDB fast | in-DB training | ~$0 | 80M/<2h | low | — | 05 |
| Identity graph | **Postgres (entities/edges/XREF)** | ER = set-ops + merges, not traversal | Neo4j (GPL), Memgraph (BSL), Kùzu (dead) | existing | low billions of edges | med | multi-hop features → Apache AGE | 06 |
| Search P1 | **Postgres tsvector+trgm+rollups** | $0, RLS for free | dedicated engine now | $0 | ~10M | low | ranking pain / 10M+ | 10 |
| Search P2 | **ParadeDB pg_search + pgvector** | BM25 + RRF, no sync pipeline | Typesense/Meili (RAM, no shard) | +$100–300 | ~30–50M | med | facet latency SLO miss | 10 |
| Search P3 | **OpenSearch (CDC-fed)** | proven at 100M B2B-record scale | Quickwit (logs), Vespa (ops) | $150–400 + 0.25 FTE | 100M+ | high | 30–50M+ | 10 |
| Embeddings | **self-host BGE-M3/gte/nomic** | $40–70 one-time for 100M | API (costlier >2M/mo) | GPU one-time | — | low | semantic search step | 10,11 |
| CDC / fan-out | **Sequin or pgstream** | single container, no Kafka | Debezium+Kafka (heavy) | ~$0–small | 50K ops/s | med | ≥2 stream consumers | 08,09,10 |
| Observability | **SigNoz (ClickHouse)** | one app vs LGTM's three | Grafana LGTM, Datadog ($) | on the ClickHouse node | — | med | now (F1 baseline) | 12 |
| Catalog (later) | **none → OpenMetadata** | catalog is overkill now | DataHub (Kafka+ES+7GB) | ≥0.5 FTE | — | high | ≥3 data eng / ≥5 stores | 07 |
| DQ checks | **TS metrics table + z-score (+Soda Core)** | ~200 lines TS; no dbt/GX | Great Expectations (Python, churn) | ~$0 | — | low | now (F2) | 04 |
| Data contracts | **zod v4 + CI BACKWARD diff** | types = validators = contracts | Pact/Confluent registry (no Kafka) | ~$0 | — | low | now | 04 |
| LLM extraction | **Claude cascade (Haiku→Sonnet→Opus)** | deterministic-first + Batch 50% | frontier-only (cost) | $0.5–1.5K/1M records | Batch unbounded | low | — | 11,15 |
| Model IDs | **Haiku 4.5 / Sonnet 5 / Opus 4.8** | verified 2026-07 pricing | older tiers | see 15 | — | — | — | 11,15 |

Every "Chosen" here is open-source or pay-per-use, self-hostable, and reuses the existing
Bun/Postgres/Redis/Docker stack — matching the client's stated preference without capping enterprise
ambition. The only new *persistent* services introduced across the whole roadmap are ClickHouse and
(at F3) a durable-workflow engine; everything else is a library, a table, or object storage.

### B. The duplication kill-list (P-01.31)

For each of the fourteen pairs: what it converges into, and the order. **Order is by blast radius:**
identity-critical first (they corrupt data), then high-churn shared logic, then the rest.

| # | Duplicated concern | Converge into | Order | Why this order |
|---|---|---|---|---|
| 1 | Blind index (hex/bytes, 2 keys, 2 normalizations) | `@leadwolf/identity` (one HMAC, one encoding, one normalize; KMS key) | **F1 #1** | Breaks dedup + master matching + DSAR (P-01.6) |
| 9 | Content-hash convention (3 variants) | `@leadwolf/identity` (one canonical stable-stringify → sha256) | **F1 #2** | Global dedup key; poisoning/oracle depend on it (P-01.12) |
| 2 | Two Fellegi-Sunter ER engines | `@leadwolf/identity` ER (delete main `er/` per ADR-0047) | **F2 #1** | One resolution truth; `05` |
| 4 | Two survivorship policies | `@leadwolf/identity` survivorship | F2 | Golden record must be one function |
| 3 | 3+ dedup key schemes | one blocking-key module in `@leadwolf/identity` | F2 | Follows the ER merge |
| 10 | Two BullMQ worker-primitive sets | `@leadwolf/pipeline-kit` (deadLetter/leaderLock/retry/tuning/deadline) | F2 | High churn; `08` reliability spine |
| 5 | Two source registries | one metadata-driven `sources` registry | F2 | `03` ingestion |
| 6 | Two ingestion envelopes (v1/v2) | one envelope v2 contract in `@leadwolf/types` | F1/F2 | One capture path; `03` |
| 7 | Two rate limiters (+1 in-memory) | one Redis limiter (fail-closed) | F2 | `03`, `14` |
| 8 | Two S3 clients | one `FileStore` (P-16.2) | F2 | `09` |
| 13 | Two maker-checker approval systems | reuse platform `approval_requests` pattern; insert forge rows | F1 | Four-eyes must be real (P-01.10) |
| 14 | Two PII-encryption schemes (one dead) | one AES-GCM envelope (KMS) | F2 | `09`, `13` |
| 11 | Two `match_links` table families | keep both (Layer-0 vs forge staging) but alias cleanly; document | F3 | Legitimately distinct; low risk |
| 12 | Two "verification" subsystems | keep both (channel-verify vs human four-eyes); rename to disambiguate | F3 | Distinct concerns; naming only |

`@leadwolf/identity` (blind index + content hash + ER + survivorship + blocking) and
`@leadwolf/pipeline-kit` (worker primitives) are the two new shared packages this consolidation
creates; both are side-effect-free libraries exported via one `index.ts`, consumed by both the main
app and Forge, and enforced by dependency-cruiser.

### C. Build-vs-buy verdicts

- **Build internally:** the ER engine on Postgres, the DQ metrics layer, observability wiring, minimal
  lineage/provenance, the per-record pipeline-state layer, the source registry. These are small,
  differentiating, and cheaper to own than to license.
- **Adopt open-source / pay-per-use:** ClickHouse, R2/B2, ParadeDB→OpenSearch, SigNoz, Splink (offline),
  Hatchet/DBOS, Sequin/pgstream, self-hosted embeddings, Anthropic (Batch API).
- **Do NOT buy (now):** DataHub/OpenMetadata (≥0.5 FTE, overkill), Temporal self-hosted ($2.5–4.5K/mo +
  SRE), Senzing (until match quality is revenue-blocking), Iceberg/Kafka/data-mesh (premature). Each has
  a documented trigger in the table above.

## Implementation details

- New packages: `packages/identity/` and `packages/pipeline-kit/` (`package.json`, `src/index.ts`,
  side-effect-free, dependency-cruiser rules in `.dependency-cruiser.cjs`).
- The convergence migrations are dual-gate (`19-migration-plan.md`): dual-write the unified blind
  index/content hash, backfill, prove parity, cut reads over, then delete the duplicate implementations.
- Delete `packages/core/src/er/*` (inert) once `@leadwolf/identity` ER is live (ADR-0047).
- Consolidate the two S3 clients into one `FileStore` in `packages/integrations`.

## Migration strategy

Identity-critical convergence (blind index, content hash) lands in F1 behind a dual-gate with a
mandatory identity-match test before any read cutover — a wrong cut here silently corrupts the master
graph. The remaining pairs converge opportunistically in F2 as their subsystems are touched, each with
a parity test. Distinct-but-similarly-named pairs (11, 12) are documented and renamed, not merged.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Convergence introduces a regression in the main app | Medium | High | Dual-gate + parity tests; migrate before deleting |
| A chosen OSS component changes license (BSL creep) | Low | Medium | Every "Chosen" is Apache/MIT or pay-per-use; triggers reviewed |
| Trigger ignored, premature adoption | Medium | Medium | Triggers are explicit and monitored (`14`, `15`) |

## Success metrics

- One `@leadwolf/identity` and one `@leadwolf/pipeline-kit`; the duplicate implementations deleted.
- An identity-match test proves Forge↔master blind indexes and content hashes agree.
- No new persistent service adopted without its trigger firing (logged).
- The stack table is the single source for "what technology, and why," referenced by onboarding.

## Effort & priority

**P1.** The identity-critical convergence is ~2–3 eng-weeks inside F1; the rest is folded into F2
subsystem work at low marginal cost. The stack decisions themselves are free — they are choices, and
this document records them so they are not re-litigated per feature.

## Future enhancements

Revisit the OLAP choice if many concurrent customer-facing dashboards with heavy joins appear
(StarRocks); revisit the catalog when the data-engineering team and store count cross the trigger;
evaluate a contributory-data-network substrate (the planning suite's E7, "the industry's true primary
moat") as a strategic bet in `20-final-recommendations.md`.
