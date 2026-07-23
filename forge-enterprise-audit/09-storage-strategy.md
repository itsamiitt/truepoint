# 09 — Storage Strategy

> **Priority:** P1 · **Effort:** 8–12 eng-weeks · **Phase:** F2–F4
> (phases are defined in 17-phased-implementation-roadmap.md)

## Executive summary

This document sets the storage architecture for Forge across four tiers — Postgres as system of
record, object storage for immutable raw, ClickHouse for telemetry, and an ad-hoc analysis
lane — and gets bronze payloads out of Postgres before volume makes the move expensive. The two
most important findings: first, raw LinkedIn payloads are stored today as **plaintext** text
columns in Postgres (≤8 KB inline, larger via S3 through `Bun.S3Client` — with the PUT issued
**inside the open database transaction**), no column encryption exists despite a config comment
claiming it, no lifecycle ever advances a capture's status, and the batch/idempotency table is
dead (fact pack §3.2, §3.3, §4). Second, the platform's Postgres-as-truth posture is correct —
research places the single-node envelope at billions of rows and OpenAI runs a single primary
for 800M users — but only if bronze blobs leave the heap: at the plan's own volume model
(~31 GB/day of blobs) Postgres TOAST, vacuum, and backup costs compound while object storage
costs $15/TB-month with zero egress (fact pack §7.3, §7.5, §2.5). Headline recommendation:
adopt content-addressed, immutable, zstd-compressed batch objects on Cloudflare R2 with a
Backblaze B2 second copy in F2; make `raw_captures` a pointer index; add ClickHouse as the one
second database for telemetry at its stated trigger; climb the DuckDB → DuckLake → Iceberg
ladder only at its stated triggers; and wire retention as put-beyond-use with a replayable
erasure ledger rather than crypto-shredding. Platform-shape context is
02-enterprise-data-platform.md; the spend consequences are priced in 15-cost-optimization.md;
retention obligations are owned by doc 14 (compliance).

## Current state

### What is stored where today

- **Bronze in Postgres, plaintext.** `forge.raw_captures.payload_inline` is a bare `text`
  column (packages/db/src/migrations/0070_forge_schema.sql:18), XOR a `payload_ref` pointer
  (0070_forge_schema.sql:24). There is **no column encryption**, despite the config comment
  claiming inline payloads are "(column-encrypted)" (packages/config/src/forge.ts:6; fact pack
  §3.2). The gold-layer `email_enc`/`phone_enc` bytea columns have no writer — the encryption
  scheme is dead code (fact pack §3.2, §6.6 #14).
- **Inline threshold 8 KB.** `OBJECT_STORE_THRESHOLD_BYTES = 8 * 1024`
  (packages/config/src/forge.ts:7); payloads above it are PUT to S3-compatible storage via
  `Bun.S3Client` (packages/integrations/src/forgeObjectStore.ts:16-31) — and that PUT happens
  **inside the open Postgres transaction** for the whole envelope (fact pack §3.3). The
  adapter's header says "SSE-KMS in prod" (forgeObjectStore.ts:2-3) but the client config
  passes no SSE settings and nothing else configures encryption — unverified at the bucket
  level, absent in code.
- **Sizes are client-declared.** The 20 MB envelope / 5 MB record caps and the inline-vs-offload
  decision run against client-declared `envelope.size` / `record.byteSize`, never measured
  server-side; `byte_size` (0070_forge_schema.sql:20) stores the declared value (fact pack
  §4.1).
- **No lifecycle.** `status` has a CHECK for `landed|parsed|erased` (0070_forge_schema.sql:25)
  but no code ever updates it past the `landed` default (fact pack §3.2). No archival, no
  tiering, no retention sweep; `erased` is unreachable.
- **capture_batches is dead.** The table and its unique `idempotency_key` index exist
  (0070_forge_schema.sql:32-45) but are never written or read (fact pack §3.2); envelope
  idempotency keys are validated then discarded and `batchId` is a throwaway randomUUID
  persisted nowhere (fact pack §3.3).
- **gzip is stored but never decompressed.** `is_gzipped` is recorded
  (0070_forge_schema.sql:21) yet no decompression happens in the forge ingest path — gzip=true captures mis-parse
  downstream (fact pack §3.3).
- **Dedup is global and unverified.** `content_hash` is globally UNIQUE
  (0070_forge_schema.sql:28) and never recomputed server-side, enabling dedup poisoning and a
  cross-tenant existence oracle (fact pack §4.1) — a storage-integrity issue as much as a
  security one.
- **Deploy substrate.** Single-VM Docker Compose; Postgres and the object store share fate with
  every other service; no resource limits on forge services (fact pack §0, §4.4).

### Intent (the plan — not reality; cite docs/planning/forge/)

The planning suite specified object-store offload above ~2 KB, monthly RANGE partitioning on
the 23-table schema, KMS envelope encryption (per-record DEK wrapped by a KEK), and a raw-PII
posture per layer (raw encrypted, silver blind-index-only, gold ciphertext + blind index)
(fact pack §1, §2.1 doc-14). None of this landed: the threshold is 8 KB, there is no
partitioning, and there is no encryption at any layer.

### Volume model this strategy is sized against (doc-17, uncalibrated)

Raw 2.5M captures/day baseline → 25M/day stress; payload p50 6 KB / p99 120 KB / cap 1 MB;
raw ~5 GB/day into Postgres plus ~31 GB/day of blobs; verified UPSERTs ~1.2M/day; golden
dataset 15M → 50M+ persons over 18–24 months (fact pack §2.5). The suite itself flags these
numbers as uncalibrated — treat every figure below as planning arithmetic, not a measurement.

## Problems identified

1. **P-09.1 — RISK: plaintext PII at rest at every layer.** Bronze payloads (verbatim LinkedIn
   profiles) are plaintext in PG text columns and in the object store; the config comment
   claiming column encryption is false (packages/config/src/forge.ts:6; fact pack §3.2); gold
   `*_enc` columns have no writer (fact pack §3.2). A breach of either store discloses raw
   PII wholesale; the planning suite's per-layer posture (fact pack §2.1 doc-14) exists only
   on paper.
2. **P-09.2 — BUG: S3 PUT inside the open PG transaction.** A slow or failing PUT holds the
   envelope transaction (and its connection) open; a PUT that succeeds before a rollback
   leaves an orphan object with no row (fact pack §3.3). At 10× volume this couples object-store
   latency directly to Postgres connection exhaustion.
3. **P-09.3 — BUG: storage decisions trust client-declared sizes.** A false `byteSize: 2` on a
   multi-megabyte payload passes the 413 check, under-counts the rate limit, and lands inline
   in Postgres (fact pack §4.1) — attackers choose where their bytes go. Server-side measured
   sizes + contentHash recompute are F1 items (S.1 F1).
4. **P-09.4 — GAP: no lifecycle, tiering, or retention.** Status never leaves `landed` (fact
   pack §3.2); nothing archives, expires, or erases; backups grow without bound; the DSAR
   erasure plan in `dsar.ts` has zero production callers (fact pack §3.1).
5. **P-09.5 — GAP: batch manifests and idempotency are dead.** `capture_batches` never
   written (0070_forge_schema.sql:32-45; fact pack §3.2) means no batch-level replay unit, no
   idempotent envelope accounting, and no natural unit for the content-addressed batch layout
   this document recommends.
6. **P-09.6 — DEBT: bronze blobs on the Postgres heap will not scale.** JSONB/TOAST cliff:
   values >~2 KB TOAST out-of-line; compressed reads ~2× slower, external ~5×, worst ~10×;
   every update rewrites the whole blob (fact pack §7.3). At ~31 GB/day of blobs (fact pack
   §2.5), heap bloat, vacuum pressure, and backup size dominate within months. Research
   verdict: "raw payloads don't belong in PG" (fact pack §7.5).
7. **P-09.7 — RISK: MinIO is assumed in comments while no longer a safe default.** The adapter
   and config say "S3/MinIO" (packages/integrations/src/forgeObjectStore.ts:2;
   packages/config/src/forge.ts:43), but MinIO's community console was stripped in May 2025 and
   the AGPL community edition entered maintenance mode in December 2025 (fact pack §7.5). Any
   self-host plan built on MinIO inherits an unmaintained substrate.
8. **P-09.8 — GAP: gzip ambiguity makes bronze non-replayable.** Payloads stored gzipped are
   never decompressed on read (fact pack §3.3); the archive's promise — capture once, replay
   forever — fails for exactly the captures large enough to be gzipped.

## Research findings

- **Postgres single-node envelope.** OpenAI: single PG primary + ~50 read replicas serving
  800M users at millions of QPS; billions of rows / single-digit TB routine on one node; 32 TB
  per-table limit; "97% of problems = indexing + vacuuming" ("Scaling PostgreSQL at OpenAI,"
  PGConf.dev 2025 talk, Bohan Zhang — summarized in fact pack §7.3; conference:
  https://pgconf.dev; limits: https://www.postgresql.org/docs/current/limits.html).
- **Write throughput.** Single-row INSERT ~2.3K rows/s; batched ~37K; COPY ~63K (pgx CopyFrom
  ~357K at 50K batches) — millions of enrichment writes/day are trivial if batched (fact pack
  §7.3).
- **TOAST economics.** Values >~2 KB TOAST out-of-line
  (https://www.postgresql.org/docs/current/storage-toast.html); LZ4 vs pglz vs external
  storage measured 38/41/98 GB on the same corpus ("What is the new LZ4 TOAST compression in
  PostgreSQL 14?", Fujitsu PostgreSQL blog:
  https://www.postgresql.fastware.com/blog/what-is-the-new-lz4-toast-compression-in-postgresql-14
  — figures per fact pack §7.3). Promote hot JSONB fields to columns.
- **Partition + pooling hygiene.** pg_partman for partition lifecycle
  (https://github.com/pgpartman/pg_partman); PgBouncer transaction mode is standard
  (https://www.pgbouncer.org/); PG17 logical replication matured (failover slots,
  pg_createsubscriber) (fact pack §7.3).
- **Object storage economics.** Cloudflare R2: $15/TB-month Standard, $10 Infrequent Access,
  **zero egress** (https://developers.cloudflare.com/r2/pricing/); Backblaze B2 $6.95/TB-month
  (https://www.backblaze.com/cloud-storage/pricing); S3 Standard ~$23/TB-month + ~$90/TB
  egress (https://aws.amazon.com/s3/pricing/); Glacier Deep Archive ~$1/TB-month for
  compliance cold copies. Worked anchor: 50 TB ≈ $750/mo on R2 vs ~$5,650/mo on S3 with one
  monthly full re-read (fact pack §7.5).
- **The bronze pattern.** Append-only, content-addressed batches (hour/day-partitioned zstd
  JSONL or Parquet), never mutated — capture once, replay forever; research says adopt
  immediately (fact pack §7.5). This is "the 20% of event sourcing that pays": immutable raw
  log + rebuildable projections, without event-sourcing the app (fact pack §7.6).
- **MinIO status.** Community console stripped May 2025; AGPL community edition
  maintenance-mode December 2025 (fact pack §7.5; repo: https://github.com/minio/minio). If
  self-hosting is ever forced (DPDP residency, 200–500 TB+): SeaweedFS
  (https://github.com/seaweedfs/seaweedfs) or Garage (https://garagehq.deuxfleurs.fr/).
- **ClickHouse as the second database.** Single node <10 GB/day ≈ $200–400/mo; 3-node
  ~$1,070/mo; ops 4–8 h/week; compression 10–20× (Cloudflare's HTTP analytics: ~600 B → 60 B
  per record — https://blog.cloudflare.com/http-analytics-for-6m-requests-per-second-using-clickhouse/);
  PG→CH CDC solved by PeerDB, free OSS after the ClickHouse acquisition (July 2024:
  https://clickhouse.com/blog/clickhouse-acquires-peerdb-to-boost-real-time-analytics-with-postgres-cdc-integration)
  (fact pack §7.4).
- **Lakehouse ladder.** DuckDB over object-storage Parquet now, no table format
  (https://duckdb.org/); DuckLake v1.0 (Apr 2026) — all metadata in Postgres, Parquet on
  object storage, no JVM/catalog/compaction fleet (https://ducklake.select/); Iceberg v3
  ratified 2025 but JVM/Python-first with real maintenance burden
  (https://iceberg.apache.org/spec/). MotherDuck repriced upmarket ($250/mo+,
  https://motherduck.com/pricing/) — self-hosted DuckDB is the budget path (fact pack §7.2).
- **Retention engineering.** Crypto-shredding (per-subject DEK) is heavy for a search-centric
  DB — defer unless a contract demands provable backup erasure. The ICO-accepted backup
  position is "put beyond use": prompt live deletion, bounded documented backup aging, and a
  restore runbook that replays the deletion/suppression ledger post-restore ("Deleting
  personal data," UK ICO guidance: https://ico.org.uk — position per fact pack §9.6). Audit
  immutability: append-only + hash chain + periodic segment-root anchoring to WORM object
  storage (versioning + object lock) (fact pack §9.6).

## Enterprise best practices

- **Tier by access pattern, not by age alone.** Hot truth (Postgres) stays lean; immutable raw
  lives on object storage from day one; analytics reads never touch OLTP (fact pack §7.1,
  §7.4).
- **Content addressing everywhere.** Batch objects keyed by their own hash make replay
  verifiable, dedup trivial, and tampering evident — the same property the audit chain needs
  (fact pack §7.5, §9.6).
- **Zero-egress reprocessing as a product capability.** A ZoomInfo-class vendor re-parses its
  entire archive on every parser/model upgrade; egress-free storage turns that from a budget
  line into a nightly job (fact pack §7.5; the reprocessing cascade is doc 15's AI-cost
  concern).
- **Encryption posture per layer.** Raw encrypted at rest; silver carries blind indexes only;
  gold carries ciphertext + blind index (planning doc-14 posture, fact pack §2.1) — the target
  remains right even though nothing implements it yet.
- **Retention is a pipeline, not a policy PDF.** Suppression checked at ingest AND egress;
  hashed tombstones prevent re-ingestion; DSAR spans every store including the archive
  (fact pack §9.5, §9.6; doc 14).

## Recommended architecture

### Target tier map

```text
        hot / authoritative                        immutable / cheap                cold / compliance
 ┌─────────────────────────────┐   ┌──────────────────────────────┐   ┌─────────────────────────┐
 │ Postgres (forge schema)     │   │ Cloudflare R2                │   │ S3 Glacier Deep Archive │
 │  silver + gold + pointers   │   │  bronze: content-addressed   │   │  7-yr compliance copies │
 │  pipeline state, outbox,    │──▶│  zstd JSONL batch objects    │──▶│  (only if contractually │
 │  audit chain, manifests     │   │  + WORM audit anchors        │   │   required)             │
 └──────────────┬──────────────┘   └──────────────┬───────────────┘   └─────────────────────────┘
                │ CDC (PeerDB) / outbox           │ nightly copy
                ▼                                 ▼
 ┌─────────────────────────────┐   ┌──────────────────────────────┐
 │ ClickHouse (single node)    │   │ Backblaze B2                 │
 │  telemetry, pipeline events,│   │  second copy of bronze       │
 │  record analytics (derived) │   │  (different provider/blast   │
 └─────────────────────────────┘   │   radius)                    │
                ▲                  └──────────────────────────────┘
                │ ad-hoc SQL over R2 Parquet/JSONL
        ┌───────┴────────┐
        │ DuckDB sidecar │  → DuckLake (PG catalog) when raw >1–5 TB
        └────────────────┘  → Iceberg only at external-reader / 50–100 TB+ trigger
```

### Bronze layout (content-addressed immutable batches)

- Object key: `raw/{source}/{yyyy}/{mm}/{dd}/{hh}/batch-{batch_hash}.jsonl.zst` — the batch
  hash is the sha256 of the compressed object (content address); objects are never mutated.
- Each record inside the batch carries the light bronze contract: source, endpoint,
  schema_version, captured_at, per-record content_hash, consent snapshot (fact pack §7.7).
- `forge.capture_batches` becomes the real manifest (finally using its idempotency index);
  `forge.raw_captures` becomes a pointer index: per-record row with `batch_id` +
  `batch_offset` + measured size, no payload bytes.
- Compression: zstd on JSONL (JSON payloads typically compress 5–8×; estimate, validate on
  real captures). Parquet conversion is a later, additive optimization for the DuckDB lane.
- Encryption: R2 server-side encryption on the bucket plus the platform's `encryptPii`
  AES-256-GCM for the specific PII fields that remain in Postgres (convergence item #14 in
  02-enterprise-data-platform.md). Per-record DEK envelope encryption (planning doc-14) is
  deferred to the crypto-shredding trigger in §9.6 — see Future enhancements.

### DDL / migration sketches (bronze leaves Postgres)

```sql
-- Hand-authored migration (drizzle-kit generate is forbidden — fact pack §2.3).

-- 1) Make capture_batches the batch manifest (dead today — 0070:32-45, fact pack §3.2).
ALTER TABLE forge.capture_batches
  ADD COLUMN IF NOT EXISTS object_key    text,
  ADD COLUMN IF NOT EXISTS batch_hash    text,                       -- content address (sha256, converged encoding — see 02 P-02.2)
  ADD COLUMN IF NOT EXISTS record_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compression   text NOT NULL DEFAULT 'zstd',
  ADD COLUMN IF NOT EXISTS stored_at     timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_batches_hash
  ON forge.capture_batches (batch_hash);

-- 2) raw_captures becomes a pointer index with lifecycle + measured sizes.
ALTER TABLE forge.raw_captures
  ADD COLUMN IF NOT EXISTS batch_id        uuid REFERENCES forge.capture_batches (id),
  ADD COLUMN IF NOT EXISTS batch_offset    integer,
  ADD COLUMN IF NOT EXISTS measured_bytes  bigint,       -- server-measured; byte_size is client-declared (fact pack §4.1)
  ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS erased_at       timestamptz;

-- 3) Exactly one payload location (replaces the two-way XOR at 0070:24).
ALTER TABLE forge.raw_captures DROP CONSTRAINT raw_captures_one_payload;
ALTER TABLE forge.raw_captures ADD CONSTRAINT raw_captures_one_payload
  CHECK (num_nonnulls(payload_inline, payload_ref, batch_id) = 1);

-- 4) Erasure ledger — the put-beyond-use spine (fact pack §9.6); doc 14 owns policy.
CREATE TABLE IF NOT EXISTS forge.erasure_ledger (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_blind_index    bytea NOT NULL,   -- the ONE converged blind index (02 P-02.2)
  reason                 text  NOT NULL,   -- 'dsar' | 'retention' | 'suppression'
  requested_at           timestamptz NOT NULL DEFAULT now(),
  live_deleted_at        timestamptz,      -- PG rows tombstoned/anonymized
  bronze_rewritten_at    timestamptz,      -- affected batch objects rewritten by sweep
  UNIQUE (subject_blind_index, reason, requested_at)
);
```

Migration notes: steps 1–2 are additive and safe to land early; step 3 lands only after the
backfill (below) verifies every row resolves to exactly one location; the final
`payload_inline`/`payload_ref` drop is a separate, last migration after two green
reconciliation sweeps. All migrations hand-authored in `packages/db/src/migrations/` —
and note the journal already carries a duplicate-index quirk (two 0053s) to avoid repeating
(fact pack §6.4).

### Postgres actions (keep the truth store lean — fact pack §7.3)

- `ALTER SYSTEM SET default_toast_compression = 'lz4';` for the remaining large values.
- pg_partman on append-heavy tables — `raw_captures` (pointer index), `extraction_runs`,
  `forge_audit_log`, `sync_outbox` — monthly ranges, automated retention (F3 per S.1).
- PgBouncer transaction mode in front of the shared DSN (also narrows the blast radius of
  P-09.2-style long transactions).
- Batch every bulk write path (COPY into staging for imports — fact pack §10.7).
- Promote hot JSONB fields (e.g., `parsed_records.fields` keys used in blocking) to real
  columns before they become filter predicates.

### ClickHouse (the second database — F2/F3)

Adopt single-node ClickHouse when event/telemetry tables exceed 100–200M rows or telemetry
begins hurting OLTP — the research judgment is "arguably now" (fact pack §7.4). Patterns:
MergeTree `ORDER BY (tenant_id, source, ts)` for capture/pipeline events;
ReplacingMergeTree for dedup; materialized-view rollups for console counters (replacing the
unbounded BFF COUNT(*) reads — 15-cost-optimization.md P-15.6); fed by PeerDB CDC or
dual-written outbox events. ClickHouse never owns tenant-authoritative state (fact pack §7.4).

### DuckDB → DuckLake → Iceberg ladder (F3–F4, trigger-gated)

- **Now:** DuckDB sidecar reads bronze JSONL/Parquet straight off R2 for ad-hoc analysis and
  ER weight training (05-entity-resolution.md uses this for Splink offline training).
- **Raw >1–5 TB + multi-writer reprocessing:** DuckLake with its catalog in the existing
  Postgres — no new stateful service (fact pack §7.2).
- **External engines must read / 50–100 TB+:** Iceberg + Lakekeeper/Polaris. Not before —
  the TS-ecosystem adoption tax is real (fact pack §7.2).

### Lifecycle, tiering, and retention integration

- **Tiering:** bronze Standard → R2 Infrequent Access after 90 days (access pattern permitting)
  → optional Deep Archive copy for 7-year contractual retention only.
- **Second copy:** nightly R2 → B2 sync (different provider = different blast radius);
  restore drill quarterly.
- **Put-beyond-use flow (fact pack §9.6):** erasure request → live PG rows
  tombstoned/anonymized promptly and `erasure_ledger.live_deleted_at` set → suppression hash
  prevents re-ingestion (ingest checks the ledger) → a scheduled bronze sweep rewrites
  affected batch objects (immutability is preserved by writing a new object and updating
  manifests; the old object is deleted, not edited) → backups age out on a bounded, documented
  schedule → the restore runbook replays the ledger after any restore. `status='erased'`
  finally becomes reachable (P-09.4).
- **Audit anchoring:** daily segment roots of `forge_audit_log`'s hash chain written to a
  WORM-configured (versioned + object-lock) bucket (fact pack §9.6) — this also mitigates the
  chain-fork defect doc 01 catalogs (fact pack §3.2).

## Implementation details

Dependency-ordered:

1. **F1 prerequisites (owned by doc 01, restated):** server-side contentHash recompute +
   measured sizes (closes P-09.3); decompress-on-read for gzip or reject gzip at the edge
   (closes P-09.8); `forge.ts` config into the validated env schema (fact pack §4.4).
2. **Move the PUT out of the transaction (closes P-09.2).** In
   `packages/forge-core/src/ingest.ts`: stage the object PUT before opening `withForgeTx`
   (write-then-commit-pointer), or write inline and offload asynchronously; either way the
   orphan-object case is swept by the reconciliation job (step 6). Also fixes the sibling
   enqueue-mid-transaction defect (ingest.ts:131; fact pack §3.3) in the same restructuring.
3. **Batch writer.** New `packages/forge-core/src/bronze/batchWriter.ts`: accumulate landed
   records per source-hour, write `batch-{hash}.jsonl.zst` via the single converged S3 adapter
   (packages/integrations/src/forgeObjectStore.ts — the one client per
   02-enterprise-data-platform.md #8), insert the `capture_batches` manifest row, then insert
   pointer rows. Envelope `idempotencyKey` maps to the manifest's unique index (closes
   P-09.5).
4. **Backfill.** One-shot job: export existing `payload_inline`/`payload_ref` payloads into
   batch objects, verify per-record content_hash on read-back, set `batch_id`/`batch_offset`,
   null the inline payload only after verification. Chunked (1–10K rows/job — fact pack
   §10.7), resumable, leader-locked.
5. **Encryption.** Enable bucket-level SSE on R2; converge on `encryptPii` AES-256-GCM for
   PII columns that stay in PG (02 #14); delete or write the gold `*_enc` columns —
   dead columns claiming a posture are worse than none (P-09.1).
6. **Lifecycle jobs.** On the `forge-maintenance` queue (which first needs a producer — a
   repeatable-job scheduler is an F1 item, fact pack §4.2): tiering transitions, B2 sync
   verification, erasure-ledger bronze sweeps, orphan-object reconciliation (S3-vs-PG diff),
   pg_partman maintenance.
7. **ClickHouse.** Compose service + PeerDB (or outbox dual-write) for `extraction_runs`,
   pipeline events, and capture telemetry; console counters move to rollups.
8. **API changes:** none externally; `POST /v1/captures` semantics unchanged (still returns
   202 with server-computed accounting once F1's measured sizes land).

**UI/UX changes:** N/A — no UI surface in this area (the console's captures/lineage views are
doc 12's; they read the pointer index identically).

## Migration strategy

Dual-run, additive, reversible:

1. Land additive DDL (manifest + pointer columns). New captures dual-write: inline/ref as
   today AND batch objects (flag `FORGE_BRONZE_BATCHES`).
2. Backfill history into batches with hash verification; nightly reconciliation compares PG
   pointer count vs manifest record_count vs object listing.
3. Flip reads (parse stage fetches via batch pointer; `BlobFetcher` gains a range-read for
   `batch_offset`); inline writes stop.
4. Two green reconciliation sweeps → drop `payload_inline` contents (bulk NULL + VACUUM),
   then the final constraint/column migration.
5. Rollback at any step = flag off; inline data is not destroyed until step 4, and batches
   are additive throughout.
6. Capture stays dark except staging/synthetic tenants during the whole move (S.1 F1), so the
   riskiest steps run against synthetic volume first.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Backfill corrupts or loses payloads | Low | High | Content-hash verification on read-back before nulling inline; inline retained until two green sweeps |
| R2 outage blocks ingest | Low | Medium | Write-inline fallback path retained behind flag; bounded local spool; ingest ack does not depend on batch flush |
| Orphan objects / pointer drift accumulate | Medium | Low | Nightly reconciliation diff (PG vs manifest vs listing) with alert on drift >0.1% |
| Egress assumptions wrong (provider repricing) | Low | Medium | B2 second copy makes provider exit a copy job, not a migration; economics re-checked quarterly in 15-cost-optimization.md |
| Erasure sweep misses a subject in bronze (batch rewrite bug) | Medium | High | Erasure itests with synthetic subjects across inline/batch/archived tiers; DSAR executor (F2) verifies absence post-sweep; doc 14 audits the ledger |
| Partitioning retrofit locks large tables | Medium | Medium | pg_partman applied at F3 while tables are still small; the pointer index is far smaller than payload tables would have been |
| ClickHouse becomes accidentally authoritative | Low | High | Derived-plane rule in the 02 ADR; no service reads CH for correctness decisions; rebuild-from-PG runbook |

## Success metrics

- 100% of new bronze payloads in object storage by end of F2; `payload_inline` dropped;
  Postgres total size growth ≤ 2 GB/day at baseline volume (vs ~5 GB/day plan number, fact
  pack §2.5).
- Reprocessing drill: full-archive re-parse executes with $0 egress and completes overnight at
  baseline volume (R2 zero-egress economics realized — fact pack §7.5).
- Restore drill quarterly: B2 copy restores a sampled day byte-identically (hash-verified).
- Erasure SLO: live deletion < 72 h from request; bronze rewrite ≤ 30 days; DSAR end-to-end
  ≤ 1 month including raw (fact pack §2.5 NFR).
- Zero plaintext-PII findings at rest in the next security review (bucket SSE on; PG PII
  columns under `encryptPii`; comment/code agreement — P-09.1 closed).
- Orphan-object drift < 0.1% sustained; gzip round-trip itest green (P-09.8 closed).

## Cost table (doc-17 volume model, month-12 run rates)

Planning arithmetic at fact-pack §2.5 volumes and §7.5 unit prices; the volume model is
explicitly uncalibrated. Uncompressed blob figures use the plan's ~31 GB/day; "zstd" assumes
6× compression (estimate — validate on real captures). Baseline = 2.5M captures/day; stress =
25M/day. Full spend roll-up including AI lives in 15-cost-optimization.md.

| Tier | Volume at month 12 (baseline) | $/mo baseline | Volume at month 12 (10× stress) | $/mo stress |
|---|---|---|---|---|
| R2 bronze (uncompressed) | ~11.2 TB | ~$168 | ~112 TB | ~$1,680 |
| R2 bronze (zstd 6×) | ~1.9 TB | ~$28 | ~19 TB | ~$280 |
| B2 second copy (zstd) | ~1.9 TB | ~$13 | ~19 TB | ~$132 |
| S3 alternative (zstd, 1 full re-read/mo) | ~1.9 TB | ~$43 + ~$168 egress | ~19 TB | ~$430 + ~$1,680 egress |
| Deep Archive 7-yr copy (zstd) | ~1.9 TB | ~$2 | ~19 TB | ~$19 |
| Postgres (post-move: silver/gold/pointers, on-VM NVMe/EBS-class) | ≤ 0.7 TB | ~$30–80 | ~5–7 TB | ~$300–700 |
| ClickHouse node (telemetry, 10–20× compression) | low hundreds of GB | $200–400 | ~1–3 TB | $400–1,070 (3-node at the top) |

Reading: the R2+B2 posture at baseline is ~$41/mo compressed — storage is effectively free
relative to AI spend (15-cost-optimization.md), and the S3 alternative's egress line alone
exceeds the entire R2 bill on the first monthly re-read. The §7.5 anchor at scale: 50 TB ≈
$750/mo R2 vs ~$5,650/mo S3 with one monthly full re-read.

## Effort & priority

P1, Phase F2–F4: nothing here blocks F1 correctness work, but bronze-out-of-Postgres must land
in F2 before volume makes the backfill a project of its own, and before the compliance spine
(doc 14) needs the erasure ledger this document creates. 8–12 eng-weeks for the pod: ~1–2
weeks PUT-restructuring + measured-size prerequisites (shared with doc 01), 3–4 weeks batch
writer + backfill + reconciliation, 1–2 weeks lifecycle/erasure jobs, 1–2 weeks encryption
alignment, ~2 weeks ClickHouse + PeerDB + rollups. The F3/F4 ladder items (pg_partman at
scale, DuckLake) are trigger-gated follow-ons, not part of this effort number.

## Future enhancements

- **Parquet bronze lane** alongside JSONL for columnar ad-hoc reads (cheap conversion job;
  makes the DuckDB/DuckLake lane faster).
- **DuckLake catalog in Postgres** at the >1–5 TB trigger; **Iceberg + Lakekeeper** only at
  external-reader / 50–100 TB+ (fact pack §7.2).
- **Crypto-shredding for high-sensitivity fields** if a contract demands provable backup
  erasure (per-subject DEK; fact pack §9.6) — deliberately deferred.
- **Residency silos:** per-region R2 buckets + regional PG (F4; DPDP counsel input — doc 14;
  self-host fallback SeaweedFS/Garage only if forced, fact pack §7.5).
- **Read replicas → Citus** if the primary saturates after reads are offloaded (fact pack
  §7.3; F4 per S.1).
- **WORM audit anchoring cadence upgrade** from daily to hourly segment roots once volume
  justifies it (fact pack §9.6).
