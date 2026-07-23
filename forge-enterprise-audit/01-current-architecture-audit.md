# 01 — Current Architecture Audit

> **Priority:** P0 · **Effort:** n/a (assessment) · **Phase:** F1 anchor
> This is the canonical problem inventory. Every other document references its findings as
> **P-01.x**. Read this before any target-state document.

## Executive summary

Forge is real code — ~5,200 lines across five workspaces (`apps/forge`, `apps/forge-api`,
`apps/forge-worker`, `packages/forge-core`, `packages/forge-capture-sdk`) plus an isolated
Postgres schema `forge` — but it is a **scaffold that does not yet run end to end**, and it
diverges materially from the frozen planning suite it claims to implement. The entire tree
landed in a single wave on 2026-07-07 (commits `0b7f13b3` → `8d377aba`), with one fix since
(`94216174`, 2026-07-22). What exists is a faithful skeleton of the intended medallion
pipeline (ingest → parse → AI-extract → resolve → verify → sync) with clean dependency
injection in the core and correct role/schema isolation at the database. What does **not**
exist is a working data path: the parse stage cannot succeed against the real database, the
AI extraction result is computed and thrown away, the sync stage has no scheduler and can
never drain, the browser extension writes to a different endpoint that stores nothing, and
the four-eyes promotion gate — the one control protecting the "golden" layer — is bypassable
by a single operator.

Three findings dominate and should frame the whole program:

1. **Plan-vs-build divergence is systemic, not cosmetic.** The planning suite
   (`docs/planning/forge/`, drafted through 2026-07-06) specifies a *separate repository*
   (`truepoint-forge`, scope `@forge/*`) with an HTTP `POST /api/v1/master-sync` egress, six
   disjoint database roles, envelope-v2 object-store offload, and a capture SDK with
   client-side redaction. The build is *nested* in the main monorepo under `@leadwolf/*`, syncs
   **in-process** (no HTTP), uses a single database role reached by `SET LOCAL ROLE` on the
   owner connection, and ships the capture SDK as a **five-line version-string stub**. Neither
   the plan nor the build is authoritative right now; the program must reconcile them
   deliberately (see `20-final-recommendations.md`).

2. **The pipeline is severed in at least four places** (P-01.1 – P-01.6, P-01.9). No captured
   observation can currently traverse bronze → gold → master. These are correctness bugs, not
   scaling concerns, and they are invisible because there is **no forge integration test in
   CI** (P-01.28).

3. **The security posture of the write path is unsound.** The four-eyes gate is
   client-assertable (P-01.10), promotion trusts client-supplied content hashes, fields, and
   confidence (P-01.11), the global content-hash dedup key enables cross-tenant poisoning and
   an existence oracle (P-01.12), and a deterministic default HMAC key ships when the
   environment variable is unset (P-01.14). For a system whose stated mandate is to be the
   single source of truth for all ingested PII, these are release-blocking.

The rest of this document records the current state per component and the full problem
inventory. The corollary is optimistic: because so little is load-bearing yet, most of these
are cheap to fix now and ruinous to fix after real volume lands. The remediation is
sequenced in `17-phased-implementation-roadmap.md`, phase **F1**.

---

## Current state

### Component footprint

| Workspace | Files | LOC | Role |
|---|---|---|---|
| `packages/forge-core` | 27 | 2,414 | Pure domain logic (DI'd stages, ER, extraction, verification) |
| `apps/forge` | 48 | 1,619 | Operator console (Next 15, staff-gated) |
| `apps/forge-api` | 13 | 600 | Capture-ingest edge + dashboard BFF + review approve (Hono) |
| `apps/forge-worker` | 11 | 594 | The stage processors (BullMQ) |
| `packages/forge-capture-sdk` | 3 | 5 | **Stub** — one exported version constant |

Database: schema `forge`, one hand-authored migration `packages/db/src/migrations/0070_forge_schema.sql`
(271 lines, 17 tables), owned by role `leadwolf_forge` (created in
`packages/db/src/applyMigrations.ts:62-64`, granted DML only within schema `forge` at
`applyMigrations.ts:159-165`). Reached via `withForgeTx` = `SET LOCAL ROLE leadwolf_forge`
per transaction (`packages/db/src/client.ts:70-75`).

### What the planning suite specifies (intent, not reality)

The design corpus in `docs/planning/forge/` (00–20, plus `_context/` frozen inputs) is a
complete, internally-cross-referenced blueprint that the codebase does **not** yet meet. It
was authored as if for a standalone repository and is explicit that "nothing is built" at the
time of the Stage-8/9 review (2026-07-06). Its load-bearing decisions (decision ledger
L1–L11):

- **L1** separate repo `truepoint-forge`, scope `@forge/*` — **diverged**: the build is nested,
  scope `@leadwolf/*`.
- **L2** four medallion layers (raw_captures → parsed_records → verified_records →
  sync_state/master_id_map) — **partially built** (tables exist; the flow between them does not
  work, see below).
- **L3** envelope v2 + MAIN-world raw API interception (ADR-0046, which *reverses* ADR-0043 #4's
  explicit rejection of interception), dark until legal sign-off — **envelope-v2 type built;
  interception not built; extension still on visible-DOM capture**.
- **L4** Forge owns entity resolution; the main app's `er/` + `erSweep` go inert; `master_*`
  becomes a downstream serving projection (ADR-0047) — **the ER engine is duplicated, and
  neither copy runs in production**.
- **L5** HTTP-push sync via `POST /api/v1/master-sync` with an outbox and a machine principal —
  **built as an in-process apply; the HTTP endpoint exists but has no caller**.
- **L7** stack mirrors TruePoint + object storage as the one net-new substrate — **object
  storage wired (`Bun.S3Client`); no lakehouse**.

ADR-0046 and ADR-0047 are cited suite-wide as "Locking ADRs" but remain formally
**Proposed, not Accepted**. This is itself a governance gap (P-01.30).

### The pipeline as-built, stage by stage

**S0 — Ingest (`POST /v1/captures` → `landEnvelope`).** Works partially. Per record: route
payload (>8 KB → S3 under `hash[0:4]/hash`, else inline), `INSERT … ON CONFLICT
(content_hash) DO NOTHING`, and if newly landed, enqueue a BullMQ `forge-parse` job with
`jobId = contentHash`. The whole envelope lands inside one `withForgeTx`
(`apps/forge-api/src/server.ts:54-57`), and the S3 PUT for large records happens **inside that
open transaction** (`packages/forge-core/src/ingest.ts:96-97`). The enqueue also happens
inside the transaction, before commit (`ingest.ts:131`).

**S1 — Parse (`forge-parse` → `runParse`).** **Cannot succeed in production.** The worker
passes the in-memory registry identifier string `"voyager-profile-1-0-0"`
(`packages/forge-core/src/parsers/index.ts:18`) as `parser_version_id`, which the schema
declares as `uuid NOT NULL REFERENCES forge.parser_versions(id)`
(`0070_forge_schema.sql:75`, `packages/db/src/schema/forge.ts:122`) — and the
`parser_versions` table is never populated. The upsert therefore fails on both a uuid cast and
a foreign-key violation. Separately, the parse upsert drops the parser's `channels`
(blind-index) and `blockKey` outputs, so `email_blind_index` and `block_key` on silver are
always NULL.

**S2 — AI extract (`forge-ai-extract` → `runExtraction`).** Runs, spends money, and **discards
its output.** The processor invokes the real Anthropic port, meters the run, and then ignores
the returned candidate fields entirely (`apps/forge-worker/src/processors.ts:112-127`) before
enqueuing resolve regardless of outcome. Nothing persists the extracted data. The metering row
itself omits token counts and latency (`packages/forge-core/src/extraction.ts:283-303`), so
spend is never recorded either.

**S3 — Resolve (`forge-resolve`).** A pure pass-through that enqueues verify
(`processors.ts:132-136`). No entity resolution runs; `er.ts` has zero production callers.

**S4 — Verify (`forge-verify`).** Inserts one `review_tasks` row per capture with hardcoded
`taskType: "ai_low_confidence"`, `confidence: 0.5`, `priority: 50`
(`processors.ts:143-147`). Promotion to gold is human-driven via `POST /v1/review/approve`,
which is the one genuinely complete transaction: `promoteVerifiedRecord` atomically writes
`verified_records` + event + `sync_state` + `sync_outbox` + audit in one tx, idempotent on
`content_hash`.

**S5 — Sync (`forge-sync`).** Drains the outbox (`FOR UPDATE SKIP LOCKED`, batch 50) and
applies to `master_*` **in-process** via `withErTx` + `forgeSyncRepository.applyItem`. But
**nothing ever enqueues a `forge-sync` job** — there is no producer and no repeatable/scheduled
job anywhere in the repo (verified across `apps/forge-worker` and repo-wide). The outbox fills
and never drains, even with `FORGE_SYNC_EGRESS_ENABLED=true`.

**Maintenance (`forge-maintenance`).** Leader-elected `console.info` no-op; the reconciler was
"dropped in the nest" (`processors.ts:181-189`). Also has no producer.

### Data model as-built

Schema `forge` has 17 tables. Bronze `raw_captures` stores the verbatim payload as
**plaintext** `text` (no column encryption, despite the config comment claiming
"column-encrypted" at `packages/config/src/forge.ts:6`), with `content_hash` **globally
unique** across all tenants (`0070:28`). Gold `verified_records` has **no tenant column** —
it is deliberately cross-tenant — and its `email_enc`/`phone_enc` bytea columns are **never
written**. There is **no RLS anywhere in the forge schema**; isolation is grants-plus-schema
only (`schema/forge.ts:2-4`).

A significant fraction of the schema is dead: `capture_batches`, `parsers`,
`parser_versions`, `match_candidates`, `forge.match_links`, `merge_log`,
`verified_record_events` (beyond the single `("verified",1)` insert), `master_id_map`,
`forge.approval_requests`, and the `email_enc`/`phone_enc` columns are never written by any
code path. Several enum states (`erased`, `superseded`, `synced`, `failed`) and event types
(`verified.superseded`, `verified.suppressed`) are typed but never emitted.

### What genuinely works (for balance)

- **`packages/forge-core` is well-structured.** Every stage is dependency-injected with a clean
  port/adapter split; the pure functions are cohesive and thoughtfully written (the extraction
  guardrails, the SchemaVer math, the hash-chained audit helper, the Fellegi-Sunter scorer).
- **The database isolation model is correct in principle.** `leadwolf_forge` cannot read the
  public schema and the app/er/admin roles cannot read `forge`; the master-graph resolver is
  reused (not re-implemented) and mints identity data only, never PII values.
- **The operator console's shell, auth, and design-system compliance are solid** — real PKCE +
  silent refresh against the shared IdP, per-request staff resolution, `@leadwolf/ui` tokens
  throughout.
- **The promotion transaction itself** (`promoteVerifiedRecord`) is atomic and idempotent — the
  right shape, undermined only by the client-trust and missing-scheduler problems around it.
- **Unit-test quality is good where it exists** — behavioural and adversarial (tampered
  audit chains, no-spend-on-injection, budget refunds).

---

## Problems identified

Ordered by severity within class. **BUG** = wrong today · **GAP** = missing capability ·
**DEBT** = works but won't scale/maintain · **RISK** = exposure.

### Release-blocking correctness & security (P0)

- **P-01.1 — BUG · The parse stage cannot write to the database.** The registry string
  `"voyager-profile-1-0-0"` is passed into the `uuid` FK `parsed_records.parser_version_id`
  against the empty `parser_versions` table (`parsers/index.ts:18`, `0070:75`). Every
  production parse upsert fails. *Fix: persist the parser registry to `parser_versions` and pass
  real UUIDs, or change the FK to a text natural key.*

- **P-01.2 — BUG · AI extraction output is discarded.** `runExtraction`'s candidate fields are
  never persisted; only metering survives (`processors.ts:112-127`). There is no data path from
  extraction to a promotion candidate — the gold layer has nothing real to promote.

- **P-01.3 — BUG · Silver blind indexes and block keys are dropped.** The parse upsert omits
  `channels`/`blockKey` (`parseStage.ts` upsert vs `parsedRecordRepository.ts:15-17`), so
  `email_blind_index`/`block_key` are always NULL — entity-resolution blocking and DSAR lookup
  on silver are impossible.

- **P-01.4 — GAP · The sync stage has no producer or scheduler.** Nothing enqueues
  `forge-sync`; no repeatable job exists. The outbox never drains even with the flag on;
  promoted gold records never reach `master_*`. Same for `forge-maintenance`.

- **P-01.5 — GAP · The extension capture path stores nothing and loses data.** The extension
  posts to the main `/api/v1/ingest`, which is a 202 stub that persists nothing; with the
  connector flag off it 400s and the extension **deletes the queued capture**
  (`apps/extension/.../scheduler.ts:34-39`); with it on, the server discards. Either way the
  record is marked `saved` and removed from the durable queue — observations are silently lost.
  Forge's capture edge, built for exactly this feed, has no producer.

- **P-01.6 — BUG · The blind-index seam between Forge and the master graph is
  cryptographically broken.** Forge computes HMAC-SHA256 **hex** under `FORGE_BLIND_INDEX_KEY`
  with trim+lowercase normalization; the main app computes HMAC **raw bytes** under
  `BLIND_INDEX_KEY` with plus-tag stripping; and `applyItem` decodes Forge's hex string **as
  base64** into a bytea column (`forgeSyncRepository.ts:63-65`). Forge-synced identities can
  never match main-app identities on the "globally unique dedup + DSAR key." Silent.

- **P-01.10 — RISK · Four-eyes promotion is client-assertable.** `POST /v1/review/approve`
  takes `requestedByUserId` (the "maker") from the request body
  (`apps/forge-api/src/features/review/schema.ts:20-22`); the only check is body-maker ≠
  authenticated approver (`verification.ts:108`). `forge.approval_requests` is never inserted,
  so `promoteVerifiedRecord`'s UPDATE matches zero rows and the DB `CHECK (decided_by <>
  requested_by)` (`0070:198`) never engages. Any single `data:review` operator can fabricate a
  maker id and promote self-authored records into the only layer that syncs to master.

- **P-01.11 — RISK · Promotion trusts the client for content, hash, and confidence.**
  `contentHash` is validated as `min(1)` not 64-hex, `fields` is `z.unknown()`, and the 0.8
  confidence gate operates on a client-supplied number (`schema.ts`, `verification.ts:116`).
  Nothing links the candidate to `parsed_records`/`extraction_runs`/`review_tasks` — arbitrary
  invented records can be promoted into gold and the sync outbox.

- **P-01.12 — RISK · Global content-hash dedup enables cross-tenant poisoning and an existence
  oracle.** `content_hash` is never recomputed server-side (regex-checked only) and is globally
  unique (`0070:28`). A caller can land junk under a legitimate payload's hash; any later
  genuine capture of that content — from any tenant — is reported `duplicate` forever and never
  landed. The `duplicate` count also reveals whether another tenant has captured a given exact
  payload.

- **P-01.13 — RISK · Size caps and storage routing trust client-declared byte counts.** The
  413 caps, the byte-based rate limiter, and inline-vs-S3 routing all use `envelope.size` /
  `record.byteSize` (`captures/routes.ts:49-54`, `ingest.ts:94`), never measured against
  `rawPayload.length`. A false `byteSize: 2` on a multi-megabyte payload passes every gate and
  lands inline in Postgres. The real ceiling is Bun's 128 MB default body limit.

- **P-01.14 — RISK · A deterministic default HMAC key ships in production.**
  `FORGE_BLIND_INDEX_KEY` falls back to the committed literal `"forge-dev-blind-index-key"`
  when unset (`packages/config/src/forge.ts:41`); the production template leaves it blank and
  `deploy.sh` never preflights it (it does check the main `BLIND_INDEX_KEY`). Blind indexes
  become forgeable and correlatable.

- **P-01.15 — RISK · Any authenticated platform user can post captures.** `resolveCaller`
  requires only a valid access token with a `tid` — no scope or role
  (`apps/forge-api/src/middleware/auth.ts:55-60`). A customer-app user token is accepted at the
  capture edge; the only additional gate is the tenant allowlist.

### Reliability & data-integrity (P1)

- **P-01.7 — BUG · Enqueue happens before commit.** The parse job is enqueued inside the land
  transaction (`ingest.ts:131`); a worker can run it before commit, find no row, treat that as
  success (`processors.ts:53-54`), and — because `jobId = contentHash` dedups re-enqueue and no
  `removeOnComplete` is set — the capture is never parsed. A rolled-back envelope leaves orphan
  jobs. *This is the transactional-outbox gap; see `08-pipeline-architecture.md`.*

- **P-01.8 — GAP · The quarantine lane is a log line.** Drifted/unparseable captures are
  `console.warn`'d and recorded nowhere (`processors.ts:78-82`), contradicting the design's
  "never silently into silver." No table, no DLQ row, no alert.

- **P-01.9 — BUG · The dormant HTTP `/api/v1/master-sync` ingress has no caller and no test.**
  It is always mounted with a bespoke machine-auth chain (`apps/api/src/app.ts:159`) that
  nothing exercises — a privileged, untested attack surface.

- **P-01.16 — BUG · Non-idempotent handlers on at-least-once queues.** Verify inserts review
  tasks with a plain INSERT and extract re-bills Anthropic + duplicates metering on every retry
  or redelivery — the header's "idempotent, so a retry converges" claim is false for both.

- **P-01.17 — DEBT · No dead-letter persistence and no `removeOnComplete/Fail`.** The DLQ is a
  `console.error` at exhaustion — not persisted, not replayable (`register.ts:77-86`,
  `deadLetter.ts:12-26`). No forge queue sets `removeOnComplete`/`removeOnFail`, so Redis grows
  unbounded (contrast the platform queues, which set both).

- **P-01.18 — BUG · The audit hash-chain is race-prone and not tamper-proof.** `prev_hash` is
  read via `SELECT max(seq)` then inserted (`promotionRepository.ts:98-117`); concurrent
  promotions fork the chain. `leadwolf_forge` holds UPDATE/DELETE on `forge_audit_log` with no
  append-only trigger or REVOKE.

- **P-01.19 — GAP · gzip envelopes are stored but never decompressed** (no decompression in the
  forge ingest path); `is_gzipped=true` captures mis-parse. `chunk` descriptors are accepted and
  ignored.

- **P-01.20 — GAP · `sync_state` is never advanced past `pending`; `master_id_map` is never
  written.** The console's "synced" count is therefore permanently zero, and there is no
  forge→master id mapping for reconciliation. Supersede/version-guard logic exists only in
  types.

- **P-01.21 — DEBT · The AI budget is not a real control.** The production budget store is
  `inMemoryBudgetStore` (`processors.ts:103`) — per worker process, reset on restart, keyed
  per-capture rather than per-tenant/day. There is no global spend cap, and the entire raw
  payload (verbatim PII) is sent to Anthropic; `sensitiveFields` is never set so the
  always-review posture is inert.

### Tenant isolation & governance (P1)

- **P-01.22 — RISK · Credential isolation is nominal.** Every service — forge-api and
  forge-worker included — connects with the same owner DSN and reaches `leadwolf_forge` only via
  `SET LOCAL ROLE` (`client.ts:70-75`). The processes hold owner-level credentials at all times;
  the wall is process discipline, not credential separation.

- **P-01.23 — GAP · Tenant attribution is lost after bronze.** Only `raw_captures` (and
  `extraction_runs` for cost) carry a tenant id; `parsed_records`, `verified_records`, and
  `sync_outbox` carry none, and consent (`consent_snapshot`) is never propagated past bronze.
  Gold is deliberately cross-tenant — defensible for a canonical dataset, but it means the
  per-source lawful basis and consent needed for GDPR/DPDP are not carried through.

- **P-01.24 — GAP · No RLS in the forge schema.** Isolation rests entirely on grants; a future
  bug that grants `leadwolf_app` USAGE on `forge`, or a query run under the owner role, has no
  row-level backstop. The platform's own doctrine is "RLS is the backstop, app filtering is
  defence in depth" — Forge has neither the RLS nor a tenant column to filter on past bronze.

### Developer-experience & operability (P1/P2)

- **P-01.25 — GAP · The operator console does not display real data against its own BFF.**
  `/bff/captures` and `/bff/me` have no server implementation (Captures page always errors;
  the whole capability-UX layer is dead code); the Overview response shape mismatch renders
  `undefined` KPIs and crashes `DataTable` with no error boundary; Review/Parsers/Sync unwrap
  envelope keys the server never sends and render permanently blank while suppressing their
  empty states. The one action Forge supports — four-eyes promotion — has no UI and is
  unreachable same-origin (`/v1/*` is not proxied by Caddy).

- **P-01.26 — GAP · `packages/forge-capture-sdk` is a five-line stub.** The promised
  envelope-v2 builder, content-hash computation, and client-side redaction/PII guards do not
  exist; nothing imports it.

- **P-01.27 — DEBT · Observability is effectively absent.** Bare `console.*` logging;
  forge-api logs nothing (a 500's cause is invisible); `/metrics` emits static gauges only —
  no queue depth, latency, failure, stage, or token-spend metrics — despite `forge-core`
  shipping unused SLO/alert/autoscale helpers. No OpenTelemetry, no request IDs, no tracing.

- **P-01.28 — RISK · There are no forge integration tests in CI.** The itest glob finds zero
  forge itests; the schema migration, the `leadwolf_forge` grants, promotion atomicity, the
  outbox drain, and `forgeSyncRepository.applyItem` have never run against real Postgres under
  CI. Every correctness bug above is invisible to the pipeline.

- **P-01.29 — DEBT · Forge config bypasses validated env.** `packages/config/src/forge.ts`
  reads bare `process.env`, so misconfiguration is not caught at boot; `.env.example` documents
  zero forge keys; forge services have no CPU/memory limits on the shared VM while running the
  Anthropic-spending worker.

- **P-01.30 — RISK · Governance drift.** ADR-0046/0047 are cited suite-wide as "Locking" but
  remain Proposed; the interception posture they lock (MAIN-world raw-API interception)
  contradicts both the earlier ADR-0043 #4 and the founder's own research brief ("You
  explicitly chose **not** to scrape — good"), and the corpus's own verdict on it is
  **ESCALATE** pending counsel. Two migrations share journal index 0053; a schema comment
  points at a non-existent "migration 0054" (the real file is 0070).

### Systemic technical debt (P2)

- **P-01.31 — DEBT · Fourteen concerns are implemented twice** across Forge and the main app,
  with drift already observable at the seams: two blind-index implementations (P-01.6), two
  Fellegi-Sunter ER engines, 3+ dedup key schemes, two survivorship policies, two source
  registries, two ingestion-envelope contracts, two capture rate-limiters, two S3 clients, two
  content-hash conventions, two BullMQ worker-primitive sets, two `match_links` table families,
  two "verification" subsystems, two maker-checker approval systems, and two PII-encryption
  schemes. The full inventory is in `16-technology-recommendations.md` §duplication. Each pair
  is maintained independently; the identity-critical pairs (blind index, content hash, ER) are
  the priority.

---

## Research findings

The audit is corroborated by how mature data vendors describe the same subsystems, which is
detailed per-topic in the target-state documents. The load-bearing external references:

- **Apollo.io's own engineering account** attributes ~90% of its duplicate accounts to
  ingestion that lacked a resolution gate, and describes union-find over billions of records
  with Redis locks to serialize merges — the exact discipline Forge's severed resolve stage is
  missing ([Apollo tech blog](https://www.apollo.io/tech-blog/detecting-data-duplication-at-scale)).
- **The transactional-outbox pattern** is the standard fix for P-01.7's enqueue-before-commit
  race ([AWS prescriptive guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)).
- **EDPB Guidelines 03/2026 on web scraping** (adopted 2026-07-07) and the LinkedIn v.
  Proxycurl outcome (Proxycurl shut down July 2025) directly bear on P-01.30's interception
  posture — the visible-DOM capture the extension does today is the survivable one; MAIN-world
  interception inherits Proxycurl's risk profile.

---

## Enterprise best practices (the bar Forge is measured against)

A ZoomInfo/Apollo/Clearbit-class data platform treats the ingestion pipeline as its crown
jewel: every stage is idempotent and observable; the resolution gate is never optional
(un-deduplicated data is worthless); provenance is tracked per field for both quality and
compliance; the golden record is a pure, replayable function of its inputs; deletion reaches
every store; and the whole path is integration-tested because a silent break corrupts the
product's core asset. Forge has the *shape* of this — the medallion layers, the ER scorer, the
four-eyes gate, the audit chain — but none of it is yet wired into a correct, tested,
observable whole. That gap is the work.

---

## Success metrics (to declare F1 done)

- An end-to-end integration test lands a synthetic capture and asserts a `verified_records`
  row and a `master_*` row appear, in CI, against real Postgres.
- Zero client-trusted values on the promotion and capture write paths (hash recomputed,
  sizes measured, maker derived from pipeline state, confidence from the pipeline).
- One blind-index implementation and one content-hash convention across the monorepo, with a
  migration proving Forge↔master identity matches.
- Every stage handler idempotent under redelivery (proven by a failure-injection test).
- The sync and maintenance schedulers exist and the outbox provably drains.
- `/metrics` exposes queue depth, age-of-oldest, DLQ size, and per-stage latency; a 500 in
  forge-api produces a structured, PII-free error log.

---

## Effort & priority

This is an assessment document, not an implementation. The remediation it defines is
phase **F1** of `17-phased-implementation-roadmap.md` (~6–8 engineer-weeks for a 2–3-person
pod). It is **P0** because the items above are correctness and security defects in a system
handling PII, and because they are an order of magnitude cheaper to fix now — while capture and
sync are dark and volume is zero — than after the pipeline carries real data.

## Future enhancements

Everything past correctness — the enterprise data platform, entity-resolution engine, identity
graph, governance, scale-out, and cost work — is the subject of documents 02–16 and is
sequenced in F2–F4. This document deliberately scopes to *what is true today and what is broken*
so the target-state documents can build on a shared, accurate baseline.
