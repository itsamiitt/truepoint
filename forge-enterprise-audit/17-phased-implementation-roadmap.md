# 17 — Phased Implementation Roadmap

> **Priority:** P0 (this document sequences everything) · **Effort:** ~9–12 months elapsed for a
> 2–3-engineer data-platform pod · **Phase:** defines F1–F4
> Read `01-current-architecture-audit.md` for the problem IDs (**P-01.x**) this roadmap remediates,
> and each domain document (02–16) for the detail behind each workstream.

## Executive summary

The work divides into four phases that are deliberately ordered by dependency, not by ambition.
**F1 makes the pipeline correct and tested** while capture and sync are dark and volume is zero —
this is where every release-blocking defect in doc 01 is fixed, and it is the only phase that must
happen before anything real flows. **F2 builds the enterprise platform core** — the provenance
model, object-storage archive, the transactional-outbox reliability spine, one entity-resolution
engine, the DSAR/suppression governance, telemetry, and real cost controls. **F3 adds scale and
governance** — partitioning, the ParadeDB search step, the ten operator surfaces, the compliance
spine (whose regulatory clock is already running), and a durable-workflow engine for the
human-review DAG. **F4 is scale-out** — OpenSearch, the lakehouse, Citus, and the
contributory/enterprise options — adopted only at explicit, measured triggers.

The critical path is **F1 → F2 → F3**; F4 items are trigger-gated and can slip without blocking the
product. Two dependencies dominate the whole plan and should be started on day one even though they
resolve late: (1) the **legal/compliance track** (Art-14 notice program, US data-broker
registration, DPDP gap analysis, the interception decision) has external deadlines in 2026 and long
lead times — it is a parallel workstream from F1, not an F3 deliverable; and (2) the **duplication
convergence** (one blind index, one content hash, one ER engine) must land early because it corrupts
identity the longer it persists (`16-technology-recommendations.md`).

Nothing here requires the separate-repository, six-role, HTTP-sync architecture the planning suite
specified. We recommend **ratifying the nested build** and amending the plan
(`20-final-recommendations.md`); the roadmap below is written for the nested reality.

## Current state

The starting line is precisely documented in doc 01: ~5,200 lines of scaffold, a pipeline severed
in at least four places, a write path with client-assertable controls, and zero forge integration
tests. Capture (`FORGE_CAPTURE_ENABLED`) and sync egress (`FORGE_SYNC_EGRESS_ENABLED`) both default
**off** (`packages/config/src/forge.ts:24-38`), and the browser extension currently feeds a
main-app stub that stores nothing — so **there is no production data at risk today**. That is the
window F1 exploits: fix correctness before the flags flip.

## Problems identified

This document does not add new problems; it sequences the remediation of every P-01.x and the
target-state work from docs 02–16. The one roadmap-level risk worth stating as a problem:

- **P-17.1 — RISK · The compliance clock is already running while the platform is a scaffold.** The
  California Delete Act requires broker registration by January 31 annually and DROP-queue polling
  every 45 days from **2026-08-01**; India's DPDP substantive obligations arrive ~May 2027; the
  EDPB's web-scraping guidance was adopted 2026-07-07 (`07-data-governance.md`). Treating compliance
  as an F3/GA gate — as the planning suite's P9 does — misreads the deadlines. The legal track must
  start in F1.

## Research findings

The phasing reflects the research consensus that the correct order for a data platform is
**truth → reliability → scale**, not the reverse. Postgres scales past 500M records
(`09-storage-strategy.md`), so scale-out (F4) is genuinely deferrable; but a pipeline that loses
data or corrupts identity is worthless at any size, so correctness (F1) and the reliability spine
(F2) cannot be. The transactional-outbox-plus-per-record-state pattern that anchors F2 is the single
highest-leverage reliability investment ([AWS prescriptive guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html);
`08-pipeline-architecture.md`), and it is required under *any* future orchestration engine — so it
is sequenced before the engine choice, not after.

## Recommended roadmap

### Phase overview

```text
        F1 Correctness & Truth      F2 Platform Core          F3 Scale & Governance     F4 Scale-out
        (weeks 0–8, P0)             (months 2–5, P1)          (months 5–9, P1/P2)       (months 9+, P2/P3)
        ─────────────────────       ─────────────────────     ─────────────────────     ────────────────
 data   parse FK, persist           provenance model,          partitioning,             OpenSearch @30-50M,
 path   extraction, unify           R2 raw archive,            ParadeDB search,          DuckLake, Citus,
        blind index+hash,           outbox + per-record        CDC fan-out,              contributory network,
        one capture path            state, one ER engine       compliance spine          active-learning ER
 ──────────────────────────────────────────────────────────────────────────────────────────────────────
 gates  capture/sync DARK           canary tenants only        per-tenant canary → GA    scale as triggered
 ──────────────────────────────────────────────────────────────────────────────────────────────────────
 legal  ── DPIA/LIA drafting, counsel on interception, registration prep ──►  registrations live, notices sending
```

The legal track (bottom row) runs continuously from the start of F1; capture and sync stay dark
until the F3 compliance gate passes for a canary tenant.

### F1 — Correctness & Truth (weeks 0–8, P0)

**Goal:** the built pipeline runs end to end, is safe on the write path, and is proven by an
integration test in CI — all while capture and sync remain dark except on synthetic/staging tenants.

Workstreams and the problems each closes:

1. **Fix the pipeline flow** (`08`, `05`, `11`).
   - Persist the parser registry to `forge.parser_versions` and pass real UUIDs (or switch the FK to
     a text natural key) so parse can write — **P-01.1**.
   - Persist AI extraction candidates to a new `extraction_candidates` table and feed them to
     promotion — **P-01.2**; record token/latency in `extraction_runs` — **P-01.21** (partial).
   - Carry the parser's `channels`/`blockKey` through the parse upsert so silver blind indexes and
     block keys populate — **P-01.3**.
   - Add the **sync and maintenance schedulers** (leader-locked repeatable jobs) so the outbox
     drains — **P-01.4**; advance `sync_state` and write `master_id_map` — **P-01.20**.
   - Decompress gzip envelopes; honor or reject `chunk` — **P-01.19**.
2. **Fix the write-path security** (`13`).
   - Server-enforced four-eyes: insert `forge.approval_requests` in the maker step, derive the maker
     from pipeline state/session (never the body), so the DB `CHECK` becomes load-bearing —
     **P-01.10**.
   - Recompute `content_hash` server-side and measure payload bytes; stop trusting client-declared
     hash/size — **P-01.11, P-01.12, P-01.13**.
   - Scope the capture principal to a dedicated capture token/scope, not any user token —
     **P-01.15**.
   - Hard-fail boot if `FORGE_BLIND_INDEX_KEY` is unset; move forge config into the validated env
     schema — **P-01.14, P-01.29**.
3. **Unify the identity-critical duplication** (`16`, `05`, `06`).
   - One blind-index implementation (one key, one encoding, one normalization) and one content-hash
     convention across the monorepo, with a migration proving Forge↔master identity matches —
     **P-01.6, P-01.31 (subset)**.
4. **Reliability primitives** (`08`).
   - Transactional outbox for the parse enqueue so enqueue happens iff commit happens — **P-01.7**.
   - Persisted DLQ + quarantine tables (replace `console.warn`/`console.error`) — **P-01.8,
     P-01.17**; `removeOnComplete`/`removeOnFail` on every queue — **P-01.17**.
   - Idempotent verify and extract handlers (unique constraints / cache) — **P-01.16**.
5. **The one capture path** (`03`).
   - Build the real `@leadwolf/forge-capture-sdk` (envelope-v2 builder + content-hash + client
     redaction) — **P-01.26**; point the extension at forge-api's `/v1/captures`; retire the
     main-app `/ingest` chrome_extension stub so captures stop being discarded — **P-01.5**.
6. **Observability & test floor** (`12`, and the CI gap).
   - Real `/metrics` (queue depth, age-of-oldest, DLQ size, stage latency), structured PII-free
     logging with request IDs in forge-api, OTel baseline — **P-01.27**.
   - Forge integration tests in CI: schema migration, `leadwolf_forge` grants and cross-role
     isolation, promotion atomicity, the outbox drain, `forgeSyncRepository.applyItem`, and one
     end-to-end "capture → verified_records → master_*" assertion — **P-01.28**.
   - Resource limits on forge compose services; lock down the public unauthenticated `/metrics` —
     **P-01.29**, `13`.
7. **Console truth** (`13`-frontend concerns).
   - Fix the console↔BFF contract: implement `/bff/captures` and `/bff/me`, align response shapes,
     add an error boundary — **P-01.25**. (Full console build-out is F3.)

**F1 exit / Definition of Done:** a synthetic capture traverses the whole pipeline in CI and
produces a `verified_records` row and a `master_*` row; zero client-trusted values on the capture
and promotion write paths; one blind index and one content hash monorepo-wide with a passing
identity-match test; every stage idempotent under a redelivery/failure-injection test; the outbox
provably drains; `/metrics` and structured logs exist; forge itests block merge. **Estimated effort:
~6–8 engineer-weeks.**

### F2 — Enterprise platform core (months 2–5, P1)

**Goal:** the platform becomes an actual enterprise data platform — provenance-tracked, durably
archived, reliably orchestrated, resolved into a clean identity graph, governed for deletion, and
observable — running on canary/synthetic tenants.

Workstreams:

1. **Provenance-first data model** (`07`, `04`) — per-field `(source_type, source_detail,
   captured_at, lawful_basis, contract_version)` on silver/gold; this doubles as the GDPR Art-14
   named-source disclosure and the DSAR data map — **P-01.23** (partial).
2. **Raw archive on object storage** (`09`) — move raw payloads out of Postgres into Cloudflare R2
   as immutable content-addressed batches (bronze leaves Postgres text columns; TOAST bloat and
   backup blowup are why); consolidate to one S3 client; encrypt at rest (SSE-KMS) — closes the
   plaintext-raw-PII exposure noted in doc 01.
3. **The reliability spine** (`08`) — the per-record pipeline-state table (partitioned),
   transactional outbox everywhere, stage idempotency keys as unique constraints, reconciliation
   sweeps diffing Postgres vs index/S3, circuit breakers (opossum) per provider, and backpressure
   with per-tenant fairness. Redis becomes replaceable transport.
4. **One entity-resolution engine, end to end** (`05`, `06`) — delete the inert main-app `er/`
   (ADR-0047); build the deterministic-ladder → Fellegi-Sunter → union-find engine with weights
   trained offline in Splink/DuckDB; the identity-graph tables (`entities`, `entity_members`,
   `match_edges`, `entity_events`, `golden_versions`); employment as dated edges; field-level
   survivorship. Wire the resolve stage to actually run it — closes the pass-through **P-01.2/P-05**
   gap.
5. **Governance mechanics** (`07`) — the cross-layer DSAR executor keyed on a subject blind-index
   index; the suppression ledger checked at ingest and every egress; retention sweeps; audit
   hash-chain hardening (serialized sequence + WORM anchoring) — **P-01.18, P-01.23**.
6. **Telemetry & cost control** (`12`, `15`, `11`) — single-node ClickHouse for pipeline telemetry
   and event analytics; OTel traces through jobs; SigNoz; real per-tenant/day AI budgets in a
   durable store; the Anthropic Batch API + prompt caching + content-hash result cache;
   deterministic-first extraction cascade — closes the budget/spend gaps **P-01.21**.
7. **RLS / credential hardening** (`13`, `14`) — add RLS or a hardened tenant-scoping story to forge
   tables where tenant-scoped, and move toward per-service DB credentials instead of the shared
   owner DSN — **P-01.22, P-01.24**.

**F2 exit:** provenance on every gold field; raw payloads in R2, encrypted, none in Postgres;
Redis-wipe survivable (re-enqueue from Postgres); one ER engine producing clustered golden records
with reversible merges; a DSAR request demonstrably erases a subject across bronze→gold→master; AI
spend recorded and bounded per tenant; ClickHouse + SigNoz live. **Estimated effort: ~14–18
engineer-weeks.**

### F3 — Scale & governance (months 5–9, P1/P2)

**Goal:** the platform is ready to carry real volume and to satisfy an enterprise/compliance bar;
capture and sync graduate from canary to GA behind per-tenant flags.

Workstreams:

1. **Scale mechanics** (`14`, `09`) — `pg_partman` partitioning on append-heavy tables; read
   replicas for BFF/analytics; precomputed rollups (or ClickHouse) for the unbounded `COUNT(*)`
   dashboards; bounded pools and separate Redis connections per blocking consumer.
2. **Search step 2** (`10`) — ParadeDB `pg_search` + `pgvector` in Postgres (BM25 + RRF hybrid, no
   sync pipeline), validated at 10M rows; facet rollups; the SearchPort seam retained.
3. **CDC fan-out** (`08`, `10`) — when a second change-stream consumer appears (search indexer +
   ClickHouse), tail the outbox/WAL with Sequin or pgstream.
4. **The operator console** (`13`-frontend) — the ten surfaces (Overview, Imports, Capture monitor,
   Parsers, Review with real approve/reject/diff, Dedup/merge, Data quality, Sync status, Jobs with
   DLQ redrive, Audit) with server-side keyset pagination and virtualization — closes the remaining
   console gaps in **P-01.25**.
5. **The compliance spine goes live** (`07`, `13`) — Art-14 active-notice program; US data-broker
   registrations (CA/TX/VT/OR) and the DROP poller; the DPDP gap work; GPC honoring; the
   interception decision formalized (recommend visible-DOM, interception stays dark).
6. **Durable-workflow engine** (`08`) — adopt Hatchet or DBOS for the human-review DAG once the
   hand-rolled BullMQ state machines exceed two or three flows.
7. **Quality & eval harnesses** (`04`, `11`) — golden-fixture parser tests, the AI eval golden set
   with a CI gate, drift monitors on payload-shape hashes and per-field distributions.

**F3 exit:** partitioning and replicas in place; ParadeDB serving faceted search at target latency;
the console usable by a real operator; registrations filed and notices sending; a per-tenant canary
runs capture→sync in production with the compliance gate green. **Estimated effort: ~16–22
engineer-weeks.**

### F4 — Scale-out & enterprise (months 9+, P2/P3)

Trigger-gated; none of these block the product. Adopt each only at its measured trigger
(`16-technology-recommendations.md`):

- **OpenSearch** (CDC/outbox-fed) when the dataset passes ~30–50M records or ParadeDB facet latency
  misses SLO (`10`).
- **DuckLake over the R2 archive** when raw exceeds ~1–5 TB with multi-writer reprocessing (`09`).
- **Read replicas → Citus** when the primary write-saturates (`09`, `14`).
- **Residency/silo options** for enterprise contracts (`13`, ADR-0021 siloing).
- **Contributory-network / active-learning ER / ML data quality** (`20-final-recommendations.md`
   future track; the planning suite's E-series).

## Implementation details — sequencing and dependencies

The intra-phase critical path:

```text
F1:  [unify blind index + content hash] ─┐
     [persist parser registry] ──► [parse writes] ──► [persist extraction] ──► [promotion real]
     [server-enforced four-eyes] ─────────────────────────────────────────────┘
     [sync scheduler] ──► [outbox drains] ──► [E2E itest in CI]  ◄── gates F1 exit
     [one capture path + real SDK] (parallel)
     [legal track kickoff] ───────────────────────────────────────────────────► (runs into F3)

F2:  [provenance model] ──► [DSAR executor] ──► [suppression ledger]
     [R2 raw archive] ──► [encryption at rest]
     [per-record state + outbox everywhere] ──► [reconciliation sweeps]
     [one ER engine] ──► [identity graph] ──► [survivorship/golden_versions]
     [ClickHouse + OTel + SigNoz] ──► [per-tenant AI budget]

F3:  [partitioning + replicas] ; [ParadeDB] ; [console 10 surfaces] ;
     [compliance spine LIVE] ──► [per-tenant canary GA]
```

Folder-structure changes (exact paths) are specified per-subsystem in the domain documents; the
roadmap-level additions: a shared `@leadwolf/identity` package (blind index + content hash + ER +
survivorship, from `16`), a `forge.extraction_candidates` table and a `forge.pipeline_state` table
(from `08`/`11`), the R2 `FileStore` consolidation in `packages/integrations` (from `09`), and the
`sources` control table for the metadata-driven registry (from `03`).

## Migration strategy

Every phase is delivered behind flags and dual-run where it touches live data
(`19-migration-plan.md`). F1 runs entirely on synthetic/staging tenants because capture and sync are
dark. F2's data-model changes (provenance, R2 archive, ER) are additive-then-backfill: new columns
and tables land dark, backfills run as batched idempotent jobs, and reads cut over behind a flag
once parity is proven. The duplication convergence uses the dual-write/dual-gate pattern the main
app already uses for its channel migration (`CHANNEL_DUAL_WRITE`/`CHANNEL_READ_FROM_CHILD`). F3's
capture/sync GA is a per-tenant canary with the metric-driven rollback the planning suite designed
(`ga.ts` canary logic, once persisted).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Legal track slips and blocks GA | Medium | High | Start counsel + DPIA/LIA in F1; registrations are cheap and fast; interception stays dark regardless |
| Duplication convergence breaks main-app identity | Medium | High | Land the unified blind index/hash behind a dual-gate with an identity-match test; migrate, don't cut over blind (`19`) |
| F1 scope creep pulls in F2 work | High | Medium | F1 is strictly "make the built pipeline correct + tested"; new capability is F2 |
| ER engine underperforms at scale | Medium | Medium | Offline Splink/DuckDB weight training + block-size caps; the Senzing buy trigger is a known escape hatch (`05`) |
| Human-review queue becomes the ceiling | High (at volume) | High | Deterministic-first extraction shrinks AI/review volume; confidence-routing + auto-approve; this is a named hard ceiling (`14`) |

## Success metrics

- **F1:** E2E itest green in CI; zero client-trusted write-path values; one blind index/hash; outbox
  drains; ≥1 idempotency failure-injection test passing.
- **F2:** 100% of gold fields carry provenance; 0 raw payloads in Postgres; Redis-wipe recovery
  drill passes; DSAR erases a subject across all layers in a test; AI spend recorded per tenant.
- **F3:** search p95 within SLO at 10M rows; registrations filed; a canary tenant runs capture→sync
  in production with the compliance gate green; ≤1% of records hit human review.
- **F4:** each scale-out component adopted only after its trigger fired, with the dropped-coverage
  logged.

## Effort & priority

Total elapsed **~9–12 months** for a 2–3-engineer pod: F1 ~6–8 eng-weeks (P0), F2 ~14–18 (P1), F3
~16–22 (P1/P2), F4 trigger-gated (P2/P3). The legal track runs in parallel from F1 at a
low-but-nonzero level (counsel time + ~$7K/yr registration fees, `15-cost-optimization.md`). This is
**P0** as a document because it is the sequencing every other document's work slots into.

## Future enhancements

Beyond F4, the planning suite's E-series (multi-site adapters, event-bus transport, lakehouse,
multi-region, auto-survivorship, contributory co-op, ML data quality, parser auto-generation,
real-time streaming) are the long-horizon options; `20-final-recommendations.md` records which of
them are worth committing to and which remain optional. The contributory-network option (E7) is
called out by the planning corpus itself as "the industry's true primary ingestion moat" and is the
one strategic bet worth evaluating early even though its build is late.
