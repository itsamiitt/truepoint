# 03 — Data Ingestion Architecture

> **Priority:** P0 · **Effort:** 12–16 eng-weeks · **Phase:** F1–F2
> (phases are defined in 17-phased-implementation-roadmap.md)

## Executive summary

TruePoint has three ingestion families — browser-extension capture, CSV/XLSX bulk import, and
enrichment-provider results — and the Forge planning suite's core invariant is that all of them
land in Forge bronze so the compliance firewall, provenance, and replay guarantees hold
(fact-pack §2.6 invariant 1). Today **none of them does**. The extension capture path is severed
twice: the extension posts to the main app's `/api/v1/ingest`, which validates and stores
nothing, while the client deletes its durable queue entry on both the 202 and the 400 path —
captured observations are silently lost end to end (fact-pack §6.3). Forge's own capture edge
(`POST /v1/captures`) has zero producers and its companion `@leadwolf/forge-capture-sdk` is a
5-line version-constant stub (fact-pack §4.3). CSV import is the most mature ingestion machinery
in the repo (RFC-4180 + XLSX parsing, blind-index dedup, COPY staging per ADR-0036) but lives
entirely in the main app and never touches Forge; enrichment-provider ingestion likewise. The
capture edge that does exist trusts client-declared `contentHash` and `byteSize`, which opens
dedup poisoning, a cross-tenant existence oracle, and storage-routing abuse (fact-pack §4.1).
The headline recommendation: build **one** capture path (envelope v2 → forge-api) with
server-side hash recompute and measured sizes, split dedup into global content storage plus
per-tenant capture claims, ship a real capture SDK, retire the main `/ingest` connector per
OQ-5, and route CSV/bulk into Forge bronze by **reusing** the existing ADR-0036 import
machinery rather than rebuilding it. Interception (ADR-0046) stays dark; the visible-DOM
posture is the primary capture strategy (fact-pack S.2#8, §9.5).

## Current state

### The mandate versus the three-lane reality

The planning suite's compliance firewall assumes Forge is the single ingestion front door:
"raw/parsed never leave Forge; only verified_records sync" (fact-pack §2.6 invariant 1). That
invariant is only meaningful if ingestion actually enters Forge. As built, ingestion runs in
three lanes and none of them reaches the `forge` schema:

1. **Extension capture** → main app `/api/v1/ingest` → discarded (fact-pack §6.3).
2. **CSV/XLSX import** → `packages/core/src/import` → tenant overlay tables via the
   `import_jobs` COPY pipeline (ADR-0036; fact-pack §2.3) — never bronze.
3. **Enrichment providers** → the main-app waterfall with `provider_calls` metering
   (fact-pack §2.3) — results land in the overlay, never bronze.

Main apps (`apps/api`, `apps/workers`, `apps/web`, `apps/admin`) have zero Forge references
except the master-sync feature (fact-pack §6.2). `forge-core`'s own GA checklist lists
`darkConnectorRetired` as a GA blocker — the divergence is known and unresolved
(fact-pack §6.3).

### Lane 1 — extension capture: severed twice

The as-built flow (fact-pack §6.3, definitive): content script CAPTURE message → IndexedDB
queue → `ApiClient.ingest` posts a **v1** `ingestionEnvelope` with `source=chrome_extension` to
`api.truepoint.in/api/v1/ingest`.

**Severance 1 — the server stores nothing.** `apps/api/src/features/ingest/routes.ts:28-59`
validates the envelope, enforces `envelope.scope.tenantId === session tenantId` (403
`scope_mismatch`, routes.ts:36-38), throttles `chrome_extension` via `checkCaptureRate`
(routes.ts:46-48, fail-open per fact-pack §2.3), runs the connector's validation, and returns
`202 { accepted: true }` without persisting anything (routes.ts:56-58 — "the per-connector
async processing … is a later slice"). When `CHROME_EXTENSION_ENABLED` is false (the default),
the connector is not even registered and the endpoint 400s (fact-pack §6.3).

**Severance 2 — the client deletes the record either way.** The extension's `JobScheduler`
removes the queue item on success (`apps/extension/src/background/queue/scheduler.ts:22-23`)
and also removes it when the error classifies as `validation`
(scheduler.ts:35-38) — which is exactly what the 400 from the unregistered connector maps to.
Flag off: 400 → classified validation → queue entry deleted. Flag on: 202 → ack → queue entry
deleted, server discarded the payload. Either way the durable queue drains into nothing.

Meanwhile Forge's purpose-built capture edge has **no producer**: `POST /v1/captures`
(`apps/forge-api/src/features/captures/routes.ts:27`) is called by tests only
(fact-pack §6.2), and `packages/forge-capture-sdk/src/index.ts:5` is the entire SDK:
`export const FORGE_CAPTURE_SDK_VERSION = "0.0.0"` — the header promises an envelope-v2
builder, content hash, and size/PII guards "Ported in P3"; none exist, and nothing imports the
package (fact-pack §4.3).

### Lane 2 — CSV/bulk import: mature, main-app-only

`packages/core/src/import` is a ~50-file subsystem and the strongest ingestion engineering in
the repo:

- **Format handling:** a dependency-free RFC-4180 CSV reader (quoted fields, embedded
  commas/newlines, `""` escapes) with XLSX via a sibling SheetJS adapter into the same
  `{ headers, rows }` contract (`packages/core/src/import/parseFile.ts:1-16`,
  `parseXlsx.ts`), plus streaming parse (`streamParse.ts`) and admission guards
  (`admission.ts`).
- **Identity handling:** blind-index dedup (`packages/core/src/import/blindIndex.ts` — HMAC
  raw bytes under `BLIND_INDEX_KEY` with plus-tag stripping, fact-pack §6.6#1), content
  hashing (`contentHash.ts`), PII encryption (`encryptPii.ts`).
- **Scale handling:** the ADR-0036 `import_jobs` trio — COPY into UNLOGGED staging via
  `ownerClient`, `byte_offset` resume, Bulk-API-2.0-style accounting (fact-pack §2.3);
  `submitCopyImport.ts:1-18` creates the control row first (short tx) so an Idempotency-Key
  re-submit is detected before any bytes stream, stores the object, then enqueues the drive
  job; AV scan strictly precedes storage.
- **Row-error UX:** rejected-rows CSV export (`rejectedRowsCsv.ts`), progress accounting
  (`importProgress.ts`), per-tenant fairness (`importFairness.ts`).

None of this flows through Forge. Imports write the workspace overlay under `withTenantTx`;
`forge.raw_captures` receives nothing. Forge cannot replay, quarantine, or attach bronze
provenance to a single imported row.

### Lane 3 — enrichment providers: main-app-only

Provider results enter through the main-app enrichment waterfall (daily-budget breaker,
`provider_calls.cost_micros` request-hash cache — fact-pack §2.3) and land directly in overlay
tables. There is no bronze record of what a provider returned, so provider payloads are not
replayable and carry no Forge lineage (fact-pack §6.2).

### The Forge capture edge as-built

`POST /v1/captures` runs a server-authoritative gate chain
(`apps/forge-api/src/features/captures/routes.ts:27-71`): Bearer resolve → kill-switch +
per-tenant flag (`FORGE_CAPTURE_ENABLED`, `FORGE_CAPTURE_TENANTS`, both default off —
fact-pack §4.1) → Zod validate → tenant scope equality check, 403 on mismatch (routes.ts:44-46) → size caps →
endpoint allowlist → rate limit → `landEnvelope` → 202. Defects, each verified:

- **Client-declared integrity fields.** The 20MB envelope / 5MB record caps compare against
  `envelope.size` and `record.byteSize` from the client (routes.ts:49-54); nothing measures
  the actual bytes. `contentHash` is regex-validated only, never recomputed
  (fact-pack §4.1). Consequences: a false `byteSize: 2` on a multi-MB payload passes the 413
  check, under-counts the byte rate limit, and defeats the >8KB object-store routing in
  `routePayload` (`packages/forge-core/src/ingest.ts:90-100`), landing multi-MB blobs inline
  in Postgres; a forged hash lands junk under a legitimate payload's identity, after which
  every genuine capture of that content — from any tenant — reports `duplicate` forever
  (dedup poisoning), and duplicate counts double as a cross-tenant existence oracle.
- **Any-user token accepted.** `resolveCaller` returns `{ callerId: claims.sub, tenantId:
  claims.tid }` for any valid platform access token — no scope, role, or audience restriction
  beyond the shared `appOrigins()` list (`apps/forge-api/src/middleware/auth.ts:55-60`,
  19-20). A customer web-session token can post captures.
- **Fail-open, per-user, non-atomic rate limiter.** Redis fixed window keyed by `callerId`
  (user, not tenant), 2,000 records + 64MB/min, INCR/EXPIRE non-atomic, allows on Redis error
  (fact-pack §4.1).
- **Transaction-shape bug.** The whole envelope lands inside one `withForgeTx`
  (`apps/forge-api/src/server.ts:54-57`); `routePayload` performs the S3 PUT inside that open
  transaction (ingest.ts:94-99 via landEnvelope), and the BullMQ enqueue happens
  mid-transaction (ingest.ts:131). A parse job can run before commit; the processor treats
  the missing row as done, and jobId-dedup plus no `removeOnComplete` blocks re-enqueue —
  a permanently unparsed capture. A rolled-back envelope leaves orphan jobs
  (fact-pack §3.3; pipeline-side view in 08-pipeline-architecture.md, P-08.9).
- **Idempotency theater.** The envelope's `idempotencyKey` is validated then discarded;
  `batchId` is a throwaway `crypto.randomUUID()` persisted nowhere (ingest.ts:107,
  server.ts:50); there is no `Idempotency-Key` header anywhere; `forge.capture_batches` —
  which has exactly the right columns including a unique `idempotency_key` index
  (`packages/db/src/migrations/0070_forge_schema.sql:32-45`) — is never written or read
  (fact-pack §3.2). `rejected` is hardcoded 0 (ingest.ts:137).
- **gzip accepted, never decompressed.** `is_gzipped` is stored (0070:21) but no decompression
  happens in the forge ingest path; gzip=true captures mis-parse downstream (fact-pack §3.3).
- **Ad-hoc errors.** Every failure is `{ error: "snake_case" }` (routes.ts:29-65) — not the
  platform's mandated RFC 9457 envelope (fact-pack §4.1).
- **Consent dies at bronze.** `consent_snapshot` is captured on the row (0070:17) and never
  propagated past bronze (fact-pack §3.2).

Global dedup itself is structurally cross-tenant: `content_hash` is globally UNIQUE
(0070:28), so the first tenant to land a payload owns the row and later tenants' identical
captures are attributed to the first tenant (`target_tenant_id` on the one row —
fact-pack §4.1, §6.7).

### Planned intent (labeled as intent, not reality)

The planning suite (docs/planning/forge/07, cited by the code headers at
`apps/forge-api/src/features/captures/routes.ts:1-4` and
`packages/forge-core/src/ingest.ts:1-4`) intends: envelope v2 with gzip/chunk/size caps,
object-store offload >~2KB, a capture-sdk that is the single envelope builder shared by the
extension and validation (OQ-6), `capture_batches` idempotency, capture dark behind
kill-switches until P9 legal sign-off (OQ-2), and OQ-5 explicitly tracking retirement of the
dark main-app connector (fact-pack §1, §2.2 L3/L11). The build implements the gate chain
shape but not the integrity substance, and OQ-5 is unresolved.

### Operator surface

The console has no Imports surface and no capture-payload inspection; `GET /bff/captures`
does not exist server-side, so the Captures page always errors (fact-pack §5.3#1, §5.5).
Zero of the ten planned operator surfaces support ingestion operations.

## Problems identified

Ordered by severity. BUG = wrong today; GAP = missing capability; DEBT = works but will not
scale/maintain; RISK = exposure. The canonical build-defect inventory lives in doc 01; the
items below are the ingestion-domain view.

1. **P-03.1 — BUG.** The extension capture pipeline is severed twice: the main `/ingest`
   endpoint stores nothing (`apps/api/src/features/ingest/routes.ts:56-58`) and the extension
   deletes its durable queue entry on both the 202 and the 400/validation path
   (`apps/extension/src/background/queue/scheduler.ts:22-23,35-38`). Captured observations are
   silently lost end to end; at enterprise scale this is unrecoverable data loss of the
   product's primary proprietary feed (fact-pack §6.3).
2. **P-03.2 — RISK.** `contentHash` is client-declared and never recomputed server-side
   (fact-pack §4.1). Dedup poisoning (junk landed under a real payload's hash suppresses all
   future genuine captures globally), a cross-tenant existence oracle via duplicate acks, and
   corrupted bronze integrity — the identity key of the entire medallion chain is attacker
   input (`apps/forge-api/src/features/captures/routes.ts:37-41`; `ingest.ts:117`).
3. **P-03.3 — RISK.** `envelope.size`/`record.byteSize` are client-declared and drive the 413
   caps, the byte rate limit, and inline-vs-object-store routing (routes.ts:49-54;
   ingest.ts:94). A false declaration bloats Postgres with multi-MB inline rows and starves
   the limiter (fact-pack §4.1).
4. **P-03.4 — GAP.** The "no ingestion bypasses Forge" mandate is void: CSV import and
   enrichment-provider results never touch bronze (fact-pack §2.3, §6.2). Forge cannot be the
   system of record for provenance, replay, suppression-at-ingest, or DSAR coverage of those
   sources — the compliance firewall (fact-pack §2.6#1) protects an empty room.
5. **P-03.5 — BUG.** S3 PUT inside the open Postgres transaction and BullMQ enqueue
   mid-transaction (`server.ts:54-57`; `ingest.ts:131`) create parse-before-commit races,
   permanently unparsed captures, and orphan jobs on rollback (fact-pack §3.3; see
   08-pipeline-architecture.md P-08.9 for the consumer side).
6. **P-03.6 — BUG.** Global `content_hash` dedup with single-row tenant attribution
   (0070:28) assigns later tenants' identical captures to the first tenant — wrong metering,
   wrong provenance, wrong DSAR scope (fact-pack §4.1, §6.7).
7. **P-03.7 — RISK.** Any valid platform user token is accepted at the capture edge —
   `resolveCaller` checks `sub`+`tid` only (`apps/forge-api/src/middleware/auth.ts:55-60`).
   The write path into the global data plane is open to every customer session token once
   flags flip.
8. **P-03.8 — GAP.** No idempotency anywhere on the edge: no `Idempotency-Key` header, the
   envelope `idempotencyKey` is discarded, `batchId` is a throwaway UUID, `capture_batches`
   is dead schema (ingest.ts:107,137; 0070:32-45; fact-pack §4.1). Retried envelopes cannot
   be deduplicated as batches and acks are not replayable — a violation of the platform API
   contract (template FIXED decision #5).
9. **P-03.9 — BUG.** gzip envelopes are accepted and flagged but never decompressed (no decompression
   in the forge ingest path); gzip=true payloads mis-parse downstream (fact-pack §3.3).
10. **P-03.10 — RISK.** The capture rate limiter is fail-open, keyed per user rather than per
    tenant, and non-atomic (INCR/EXPIRE) (fact-pack §4.1). Under Redis degradation the edge
    is unthrottled exactly when it is least observable.
11. **P-03.11 — DEBT.** `@leadwolf/forge-capture-sdk` is a 5-line stub with zero consumers
    (`packages/forge-capture-sdk/src/index.ts:5`; fact-pack §4.3). Nothing can produce a
    capture except hand-rolled HTTP — every future producer will reinvent envelope building,
    hashing, and guards, guaranteeing divergence (OQ-6).
12. **P-03.12 — DEBT.** The edge speaks an ad-hoc `{error}` envelope, not RFC 9457
    (routes.ts:29-65; fact-pack §4.1) — clients cannot share the platform's error handling.
13. **P-03.13 — GAP.** `consent_snapshot` lands at bronze and is never propagated (0070:17;
    fact-pack §3.2) — the lawful-basis trail required by the compliance spine (doc 12) breaks
    at the first hop.
14. **P-03.14 — GAP.** No operator surface for ingestion: no Imports page, no capture
    inspection, and `GET /bff/captures` does not exist server-side so the existing Captures
    page always errors (fact-pack §5.3#1, §5.5).
15. **P-03.15 — DEBT.** Two ingestion envelopes (v1 `ingestion.ts` vs v2 `forge.ts` in one
    types package), two capture endpoints with near-identical gate chains, and three
    content-hash conventions (sorted-stringify sha256 bytes, hex text, extension unsorted
    `JSON.stringify`) (fact-pack §6.6#6,#9). The blind-index seam break (fact-pack §6.1) is
    the precedent for what duplicated conventions do at seams.

## Research findings

- **Bulk upload/staging.** The tus resumable-upload protocol (IETF draft) or S3 multipart is
  the standard for large file intake; stream-parse, never buffer; COPY into staging is
  10–100× faster than row INSERTs (~730K rows/s server-side measured; PG17 adds `ON_ERROR
  ignore`); staging → set-based SQL validation → MERGE; bad rows to a reviewable errors
  table with downloadable error CSV (fact-pack §10.7). tus: https://tus.io/protocols/resumable-upload ·
  COPY: https://www.postgresql.org/docs/current/sql-copy.html
- **Anti-pattern confirmed:** one queue job per CSV row; chunk 1–10K rows/job with per-row
  status in Postgres, not the queue (fact-pack §10.7).
- **Idempotency keys.** Persist the key, replay the stored response — the Stripe pattern
  (https://stripe.com/blog/idempotency; https://brandur.org/idempotency-keys); per-stage keys
  as unique constraints (fact-pack §10.6).
- **Transactional outbox** decouples "committed" from "enqueued"
  (https://microservices.io/patterns/data/transactional-outbox.html; fact-pack §10.4).
- **Object storage for raw payloads.** Append-only, content-addressed, hash-keyed immutable
  batches; adopt immediately — raw payloads do not belong in Postgres (TOAST bloat, backup
  blowup). Cloudflare R2 at $15/TB-month with zero egress makes replay/backfill free
  (https://developers.cloudflare.com/r2/pricing/; fact-pack §7.5).
- **Metadata-driven source registry.** A sources control table (endpoint, auth ref, rate
  limits, field mappings, normalize version) driving generic workers is the 2025 pattern with
  measured ROI (~35% lower schema-evolution cost, ScienceDirect MIND 2025 — URL not
  verified; fact-pack §7.7): "the single highest-leverage internal-platform investment for a
  company whose moat is number-of-sources × freshness."
- **CRM/import dedup reality.** Apollo reports CRM ingestion caused ~90% of duplicate
  accounts — ingest-time identity discipline is where dedup is won
  (https://www.apollo.io/tech-blog/detecting-data-duplication-at-scale; fact-pack §8.5).
- **Compliance on capture posture.** EDPB Guidelines 03/2026 (adopted 2026-07-07):
  publishing online ≠ consent; legitimate interest is realistic only with a cumulative test,
  and robots.txt/login walls feed "reasonable expectations". LinkedIn v. Proxycurl (Jan
  2025) ended with Proxycurl shutting down (July 2025) — ToS/contract claims, not CFAA, are
  the kill vector. The survivable posture is an extension that captures only what the
  logged-in user sees, user-initiated, no fake accounts, no bulk crawling (fact-pack §9.5;
  case URLs not verified — claims per fact-pack). US: CA Delete Act DROP polling every 45
  days becomes mandatory from 2026-08-01 — days away at audit date — which makes
  suppression-at-ingest a launch requirement, not a later phase (fact-pack §9.5).
- **Scale envelope for comparison.** ZoomInfo operates 4 ingestion classes at ~28M
  domains/day; Apollo's accuracy rests on a 2M+ contributor network (vendor claims,
  flagged — fact-pack §2.5). Plan NFRs: 2.5M raw/day baseline → 25M/day stress, ingest ack
  <300ms p95, 2,000 rec/min/caller throttle (fact-pack §2.5).

## Enterprise best practices

What a ZoomInfo/Apollo/LinkedIn-class platform does for ingestion:

1. **One ingestion spine, many connectors.** Every source — extension, CSV, provider,
   webhook, CRM — lands through a single envelope contract into an immutable bronze log;
   connectors are configuration, not bespoke pipelines.
2. **Server-authoritative envelope.** The server computes content hashes and sizes from the
   bytes it received; client declarations are advisory hints for UX only.
3. **Dedup ≠ attribution.** Physical storage is content-addressed and global; *claims*
   (which tenant/user captured what, when, under what consent) are per-tenant rows. Acks
   never reveal other tenants' state.
4. **Idempotent edges.** Batch-level idempotency keys with replayable acks; per-record
   results including real reject reasons.
5. **Suppression checked at ingest** (and again at egress) — hashed tombstones prevent
   re-ingestion of deleted subjects (fact-pack §9.5).
6. **Provenance from the first byte.** source, endpoint, schema version, capture context,
   consent snapshot, lawful basis — attached at bronze and propagated, because Art. 14(2)(f)
   requires specific source disclosure (fact-pack §9.5).
7. **Bulk import as a product surface.** Resumable uploads, COPY staging, per-row error
   reporting with downloadable reject CSVs, progress, and per-tenant fairness — TruePoint
   already built this once (ADR-0036); the bar is reusing it, not rebuilding it.

## Recommended architecture

### One capture path

```text
                                   ┌────────────────────────────────────────────────┐
  chrome extension                 │                 forge-api                      │
  ┌───────────────┐   envelope v2  │  POST /api/v1/captures                        │
  │ content script│──► IndexedDB ──┼──► authn (capture-scoped token)               │
  │   (visible    │    queue       │    kill-switch + tenant flag (DARK, OQ-2)     │
  │    DOM only)  │    │           │    body-size middleware (measured)            │
  └───────────────┘    │           │    Zod validate → scope re-pin                │
        ▲              │           │    server hash recompute + measured sizes     │
        │        @leadwolf/forge-  │    suppression check (blind index)            │
        │        capture-sdk       │    rate limit (atomic, tenant+caller)         │
        │        (builder+hash+    │    S3 PUT (content-addressed, PRE-tx)         │
        │         guards+retry)    │    tx: raw_captures + capture_claims          │
        │                          │        + capture_batches + pipeline outbox    │
        │                          │    post-commit: enqueue forge-parse           │
        │                          │    202 RFC-9457-clean ack w/ per-record       │
        │                          │        results (tenant-scoped duplicates)     │
        │                          └────────────────────────────────────────────────┘
        │
  CSV/XLSX import ──► ADR-0036 machinery (packages/core/src/import: admission → AV →
  (apps/web + api)    COPY staging → validate) ──► bronze-writer connector emits
                      envelope-v2 batches → same landEnvelope path (source='csv_import')
  provider results ──► enrichment waterfall ──► bronze-writer (source='provider:<name>')
  future connectors ─► metadata-driven source registry rows → generic connector worker
```

The main `/api/v1/ingest` route is retired per OQ-5 (fact-pack §2.2 L11) after the extension
migrates. One envelope (v2), one endpoint, one SDK — closing P-03.15.

### Server-authoritative envelope v2.1

- **Hash:** the server recomputes `content_hash = sha256(payload bytes)` (hex) over the
  verbatim `rawPayload` exactly as received, after transport decompression. The client's
  declared hash becomes advisory: a mismatch is recorded as a per-record reject
  (`hash_mismatch`) — never trusted, never silently corrected. Convention unified with the
  main app's content hash in one shared module (blind index + content hash converge first,
  fact-pack S.2#2; today's three conventions are fact-pack §6.6#9).
- **Sizes:** `byteSize = Buffer.byteLength(rawPayload)` measured server-side; the envelope
  cap is enforced by a body-size middleware before JSON parsing (today there is none —
  Bun's 128MB default is the only limit, fact-pack §4.1). Declared sizes are dropped from
  the contract.
- **Compression:** delete `envelope.gzip`; compression moves to transport
  (`Content-Encoding: gzip`, terminated by Caddy/Bun before the handler). This closes
  P-03.9 without writing decompression code into the ingest path. Chunk descriptors stay
  reserved but unimplemented until a >5MB use case exists.
- **Auth:** the capture edge requires a token whose audience/scope marks it as a capture
  principal (the ADR-0045 extension-scoped token, or a future service token with
  `scope=capture`) — a plain web-session token is rejected. Enforcement detail belongs to
  doc 12; the contract change is recorded here.
- **Errors:** RFC 9457 (`application/problem+json`) with the platform's shared problem
  types (https://www.rfc-editor.org/rfc/rfc9457), replacing the ad-hoc envelope.
- **Idempotency:** `Idempotency-Key` header (platform contract) mapped to
  `capture_batches.idempotency_key` (unique index already exists, 0070:45). A replayed key
  returns the stored ack from the batch row (accepted/duplicate/rejected counts +
  reject_histogram — columns already exist, 0070:36-41).

### Dedup redesign: global content storage + per-tenant capture claims

Keep the global content-addressed store — it is correct for storage and replay (one physical
payload per hash; FIXED decision #1 allows global Forge data in the isolated schema). Fix
attribution and the oracle by making *claims* first-class:

```sql
CREATE TABLE forge.capture_claims (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash        text NOT NULL,          -- joins forge.raw_captures(content_hash)
  tenant_id           uuid NOT NULL,
  workspace_id        uuid,
  captured_by_user_id uuid,
  batch_id            uuid REFERENCES forge.capture_batches (id),
  consent_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  claim_count         integer NOT NULL DEFAULT 1,
  first_claimed_at    timestamptz NOT NULL DEFAULT now(),
  last_claimed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_capture_claims_tenant_hash UNIQUE (tenant_id, content_hash)
);
CREATE INDEX idx_capture_claims_hash ON forge.capture_claims (content_hash);
CREATE INDEX idx_capture_claims_tenant_time ON forge.capture_claims (tenant_id, first_claimed_at);
```

Semantics per record inside the land transaction:

1. `INSERT INTO raw_captures … ON CONFLICT (content_hash) DO NOTHING` — unchanged, global.
2. `INSERT INTO capture_claims … ON CONFLICT (tenant_id, content_hash) DO UPDATE SET
   claim_count = claim_count + 1, last_claimed_at = now()`.
3. The ack reports `accepted` when **this tenant's claim is new** — regardless of whether
   the physical payload already existed globally — and `duplicate` only when this tenant has
   claimed this hash before. Cross-tenant probing now returns `accepted`, closing the
   existence oracle (P-03.2's oracle half and P-03.6 both fixed).
4. Attribution reads (metering, cost, DSAR scope, provenance) join `capture_claims`, not
   `raw_captures.target_tenant_id`. The bronze row's `target_tenant_id` degrades to
   "first-landing tenant" bookkeeping; `consent_snapshot` moves to the claim, where it is
   per-tenant-context and can propagate (start of the P-03.13 fix; the propagation model is
   doc 12's).
5. Parse is enqueued only on first global land (payload-level work is global); the claim
   insert is what tenant-scoped consumers key on.

DSAR erasure by blind index now sweeps `raw_captures` + `capture_claims` together
(coordinated with 05-entity-resolution.md and the DSAR executor workstream).

### Bulk/CSV into Forge bronze — reuse ADR-0036, do not rebuild

The ecosystem mandate is explicit: reuse the import trio, never duplicate (fact-pack §2.3).
The design: keep the entire existing intake front — admission, AV scan, `import_jobs` control
row, COPY-to-staging, set-based validation, rejected-rows CSV — and add a **bronze-writer
step** at the point where validated rows are today merged into the overlay. The bronze writer
batches validated rows into envelope-v2 records (`source='csv_import'`,
`endpoint='import:<import_job_id>'`, one record per row or per chunk with row offsets) and
calls the same in-process `landEnvelope` path forge-api uses (direct library call under
`withForgeTx` from the import worker — no HTTP hop needed inside the monorepo). Overlay
writes then reference the bronze claim for provenance. Provider results get the identical
treatment: the waterfall's response handler emits `source='provider:<name>'` envelopes before
merging fields. This closes P-03.4 with roughly 2–3 weeks of seam work instead of a rebuild,
and makes `import_jobs` the shared bulk front door the plan's Imports console surface expects
(fact-pack §2.1 console surfaces).

### Future connectors — the metadata-driven source registry

Adopt the sources control table now (fact-pack §7.7), replacing neither the connector
registry nor the parser registry but keying both:

```sql
CREATE TABLE forge.sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name       text NOT NULL UNIQUE,        -- 'chrome_extension' | 'csv_import' | 'provider:clearbit' | …
  kind              text NOT NULL,               -- 'capture' | 'bulk' | 'provider' | 'webhook' | 'crm'
  endpoint_pattern  text,
  auth_ref          text,                        -- KMS/secret reference, never a secret
  rate_limit_rpm    integer,
  schema_version    text NOT NULL,
  normalize_version text NOT NULL,
  lawful_basis      text,                        -- per-source basis for the compliance spine (doc 12)
  enabled           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

New webhook/CRM sources onboard as rows plus a parser version, not as new pipelines. This is
the F2/F3 growth path for "number-of-sources × freshness" and dovetails with the parser
registry persistence work in 08-pipeline-architecture.md (P-08.1).

### Compliance gate on interception

ADR-0046 (MAIN-world interception, envelope v2's original feed) **stays dark**. The corpus's
own ESCALATE verdict, EDPB 03/2026, and the Proxycurl outcome all point the same way: the
visible-DOM, user-initiated capture posture is the survivable primary strategy
(fact-pack S.2#8, §9.5) — which is also what the extension already does today (visible-DOM
capture, no XHR interception, ADR-0043 #4; fact-pack §2.3). This document therefore designs
the one capture path around the **existing visible-DOM extraction**, with interception
remaining a dark, counsel-gated option whose ingest contract is already compatible (same
envelope). Suppression checks run at ingest from day one (fact-pack §9.5). Full legal
treatment: doc 12.

## Implementation details

Dependency-ordered. F1 items are the correctness gate (fact-pack S.1); F2 items complete the
spine.

**F1 — capture edge correctness (weeks 0–8):**

1. Shared content-hash module in `packages/core` (or a new `packages/hash`) used by main
   import, forge-core, and the SDK; forge adopts it (P-03.15; converge order per S.2#2).
2. forge-api: body-size middleware; server-side hash recompute + measured sizes; RFC 9457
   error envelope across all routes; per-record results with real `rejected` counts
   (P-03.2, P-03.3, P-03.12). Files: `apps/forge-api/src/features/captures/routes.ts`,
   new `apps/forge-api/src/middleware/{bodyLimit,problem}.ts`.
3. Land-path restructure (with 08-pipeline-architecture.md): S3 PUT pre-transaction
   (content-addressed keys make orphaned blobs harmless; maintenance sweep GCs them); the
   transaction writes `raw_captures` + `capture_claims` + `capture_batches` + the pipeline
   outbox row; enqueue moves post-commit via the outbox relay (P-03.5, P-03.8). Files:
   `packages/forge-core/src/ingest.ts`, `apps/forge-api/src/server.ts`,
   `packages/db/src/repositories/forge/*`.
4. New migration (next free index; note the 0053 double-numbering quirk, fact-pack §6.4):
   `capture_claims` + `sources` DDL above; `capture_batches` gains nothing (columns
   suffice); backfill one claim per existing `raw_captures` row from
   `(target_tenant_id, content_hash)`.
5. Auth tightening: capture-scoped principal (extension-audience or `scope=capture`)
   (P-03.7, with doc 12); atomic Lua token-bucket rate limiter keyed tenant + caller, with
   bounded degradation on Redis outage — fall back to a per-instance in-process limiter at
   the same nominal rate instead of unlimited fail-open (P-03.10).
6. Real `@leadwolf/forge-capture-sdk` (P-03.11): envelope builder, shared hash, size guards
   and chunking-by-splitting-batches, suppression-aware redaction hooks, retry/offline queue
   semantics matching the extension scheduler (backoff classes; never delete on validation
   without surfacing — fixes the client half of P-03.1 in the SDK where it belongs). Thin:
   imports `@leadwolf/types` only (the dependency-cruiser rule already named in the stub
   header, `packages/forge-capture-sdk/src/index.ts:1-4`).
7. Extension: `ApiClient.ingest` switches to the SDK + `POST /api/v1/captures` on forge-api
   behind a remote-config flag; queue entries are deleted only on per-record terminal
   results, retried on transient/auth (P-03.1). Capture remains dark except
   staging/synthetic tenants (S.1 F1).
8. gzip: delete `envelope.gzip` from the v2 contract; enable `Content-Encoding` handling at
   Caddy/Bun (P-03.9).
9. Forge itests in CI (S.1): land idempotency, claim semantics, batch replay, oracle-closure
   (cross-tenant probe returns `accepted`), hash-mismatch rejects.

**F2 — the ingestion spine (months 2–5):**

10. Bronze-writer step inside the ADR-0036 import worker + provider waterfall (P-03.4);
    overlay rows reference claims for provenance. Raw payload archive moves to R2 as
    content-addressed immutable batches (bronze leaves Postgres text columns —
    fact-pack S.1 F2, §7.5).
11. `forge.sources` registry wired as the connector/parser key; main `/ingest` route
    deprecation: 30-day dual-accept window with `Deprecation` headers, then removal (OQ-5).
12. Console Imports + Captures surfaces (P-03.14): implement `GET /bff/captures`
    (keyset-paginated bronze/claims listing, payload metadata not payload bodies), an
    Imports page over `import_jobs`, per-batch reject histograms, and claim-level
    attribution views. Console contract fixes are doc 13's; the BFF endpoints land with
    this workstream.

**API changes:**

| Method + path | Change | Request | Response |
|---|---|---|---|
| POST /api/v1/captures (forge-api) | Harden (exists) | Envelope v2.1: drop `gzip`, declared sizes advisory→removed; `Idempotency-Key` header required | 202 `{batchId, accepted, duplicate, rejected, results[{contentHash, status, reason?}]}`; errors RFC 9457 |
| POST /api/v1/ingest (main api) | Deprecate → remove (OQ-5) | — | 410 after window |
| GET /bff/captures (forge-api) | **New** | cursor + filters (source, tenant, time) | keyset page of bronze rows + claim counts |
| GET /bff/imports (forge-api) | **New** | cursor | `import_jobs` view (status, counts, reject CSV link) |
| GET /bff/batches/:id (forge-api) | **New** | — | batch ack replay + reject_histogram |

**Database changes:** `forge.capture_claims`, `forge.sources` (DDL above);
`capture_batches` becomes written (no schema change); `raw_captures.consent_snapshot`
retained for the physical row, claims carry per-tenant consent; migration backfills claims
from existing rows. All hand-authored (drizzle-kit generate is unsafe in this repo,
fact-pack §2.3).

**UI/UX:** Imports and Captures operator surfaces per above; four states and `@leadwolf/ui`
compliance per the design system (details owned by doc 13).

## Migration strategy

1. **No data backfill exists for lost captures** — nothing was ever stored (P-03.1). State
   this plainly in the rollout notes; the extension's IndexedDB queues on user machines are
   the only possible recovery source and are already drained.
2. **Dual-run window:** main `/ingest` keeps accepting (stub, now logging a deprecation
   metric) while extension versions migrate to the forge path behind remote config; both
   paths dark in production, exercised in staging/synthetic tenants only (S.1 F1 gate).
3. **Claims backfill:** single migration inserts one claim per existing `raw_captures` row;
   attribution reads flip to claims behind a repo-level switch; `target_tenant_id` reads
   removed once the console and metering are on claims.
4. **Ack-shape change** is versioned via the SDK (clients pin SDK versions; forge-api
   accepts v2 and v2.1 envelopes for one release window).
5. **Cutover:** flip `FORGE_CAPTURE_ENABLED` + per-tenant flags per the staged-rollout list;
   OQ-5 retirement only after 30 days of zero main-`/ingest` traffic from current extension
   versions.
6. **Rollback:** the extension flag reverts to the main path (which still 202s harmlessly);
   forge-side schema additions are additive and require no down-migration to disable.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Legal review rejects even visible-DOM capture posture for some jurisdictions | Medium | High — capture stays dark, feed delayed | Compliance workstream is P0-parallel (S.2#8); CSV/provider bronze lanes deliver value independently |
| Claims table write amplification at 25M/day stress | Low | Medium | One upsert per record; partition by month in F3 (pg_partman, S.1 F3); batch claim upserts per envelope |
| ADR-0036 reuse couples import release cadence to Forge | Medium | Medium | Bronze-writer is an additive step behind a flag; import path unchanged when flag off |
| Server-side hashing adds CPU at the edge | Low | Low | sha256 at 5MB cap is sub-ms on Bun; body-size middleware bounds the worst case |
| Retiring main /ingest breaks old extension versions | Medium | Low | Deprecation window keyed on store-version telemetry; stub keeps 202ing until traffic is zero |
| Two content-hash conventions linger during convergence | Medium | Medium | Shared module lands first (S.2#2); CI grep-gate forbids new local hash implementations |

## Success metrics

- **Zero silent loss:** every 202-acked record has a bronze row + claim within 60s,
  verified by a continuous reconciliation probe (target: 100.00%, alert at any miss).
- **Ack latency:** p95 < 300ms at 2,000 rec/min/caller sustained (plan NFR, fact-pack §2.5).
- **Oracle closed:** cross-tenant duplicate probe test returns `accepted` (CI-gated).
- **Integrity:** 100% of stored `content_hash` values recomputed server-side; declared-hash
  mismatch rate surfaced as a metric (expected ~0; alert >0.1%).
- **Spine coverage:** by end of F2, 100% of new capture, CSV, and provider ingestion lands
  bronze with claims; main `/ingest` at 0 rps and removed.
- **Bulk import:** 1M-row CSV staged and validated ≤ 10 min end-to-end (COPY envelope per
  fact-pack §10.7 supports far more); per-row reject CSV available on 100% of failed rows.
- **Errors:** 100% of forge-api error responses are RFC 9457.

## Effort & priority

P0 is forced by the priority scale's definition: silent loss of the primary proprietary feed
(P-03.1) plus attacker-controlled dedup identity (P-03.2) are correctness/security exposures
and hard blockers for any real ingestion volume. The 12–16 eng-week estimate for a
2–3-engineer pod: edge hardening + land restructure + claims (~4–5 wks), SDK + extension
rewire + OQ-5 retirement (~3–4 wks), ADR-0036 bronze-writer + provider lane (~3–4 wks),
registry + console surfaces (~2–3 wks). F1 carries the correctness half; F2 the spine.
Capture stays dark throughout F1 per the roadmap gate (S.1), so this work does not wait on
legal to begin — only to ship to production tenants.

## Future enhancements

- Webhook and CRM connectors as `forge.sources` rows (F3), including per-source lawful-basis
  gates from the compliance spine (doc 12).
- Chunked/multipart capture for >5MB payloads (reserved in the envelope, unimplemented).
- CDC fan-out of bronze land events when ≥2 consumers exist (Sequin/pgstream, fact-pack
  §7.6; F3 trigger).
- Contributory-network ingestion (doc 20 E7 in the planning suite — "the industry's true
  primary moat", fact-pack §2.1) once the claims model provides clean per-tenant
  contribution accounting.
- DuckLake over the R2 archive when raw exceeds 1–5TB (fact-pack §7.2, F4).
