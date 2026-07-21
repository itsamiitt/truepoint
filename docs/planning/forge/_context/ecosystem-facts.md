# TruePoint Forge — Ecosystem Facts Sheet (Stage 0 grounding freeze)

> **Purpose.** This is the single source of verified truth about the *existing* TruePoint codebase that
> every Forge planning doc cites. Do **not** re-derive these claims per doc — cite this sheet by anchor.
> Every claim below was verified against the live tree on 2026-07-05. If a doc needs a fact not here,
> the author must verify it against the repo and add it here with a `file:line` anchor.

Repo: `C:\Users\aamya\Downloads\truepoint` · Bun 1.3.14 + Turbo + Biome monorepo · Postgres + Drizzle ·
BullMQ + Redis · Next.js 15 (auth/web/admin) · Hono (api) · MV3 extension (Vite + CRXJS).
Brand = **TruePoint**; npm scope = **`@leadwolf/*`** (deliberately different — never "fix" one to match).

---

## A. The ingestion stub (the gap Forge fills)

- **`apps/api/src/features/ingest/routes.ts`** — `POST /api/v1/ingest`. Middleware chain
  `authn → tenancy → requireRole("owner","admin","member")` (lines 19-21). Validates `ingestionEnvelope`
  (29-32), enforces the trust boundary `envelope.scope.tenantId === session tenantId` else `403 scope_mismatch`
  (36-38), looks up the connector (39-42), rate-limits `chrome_extension` by record volume via
  `checkCaptureRate` (46-48), re-pins scope to the token (50-53), runs `connector.validateEnvelope` +
  `toRawObservations` (54-55), then **returns `202 {accepted, source, records}` and stores NOTHING**
  (56-58). Header comment: *"The async processing pipeline (evidence → resolve → enrich → land) is wired
  per connector in later slices; v1 validates + accepts."*
- **`packages/types/src/ingestion.ts`** — the unified `ingestionEnvelope` Zod (42-53):
  `{source: connectorId, scope:{tenantId, workspaceId?}, idempotencyKey, collectedAt, consent?, records}`.
  `records: rawObservation[]` where `rawObservation = z.record(z.string(), z.unknown())` (36) — a bag of
  fields, **no verbatim raw-payload / endpoint / schema_version field**. `connectorId` closed enum (9-20)
  = admin_upload · chrome_extension · enrichment · crm · web_form · email_signature · partner · marketplace ·
  rep_submission · api. `consentContext` (26-31) = `{basis, sourceUrl?, capturedByUserId?, capturedAt?}`.
  → **Forge "envelope v2" is a genuine superset**: it adds `raw_payload` (verbatim), `endpoint`,
  `schema_version`, size caps, gzip, chunking. It is a new contract owned by Forge, not a TruePoint edit.
- **`packages/core/src/ingestion/registerBuiltins.ts`** (11-21) — `registerBuiltinConnectors()` idempotently
  registers `adminUploadConnector`; registers `chromeExtensionConnector` **only if `env.CHROME_EXTENSION_ENABLED`**
  (17-19). While off, `POST /ingest` returns `400 "no connector"` for chrome_extension → nothing captured.
- **`packages/core/src/ingestion/registry.ts`** + `connectors/{adminUpload,chromeExtension}.ts` — the connector
  interface (`validateEnvelope`, `toRawObservations`). **This is the pattern Forge's inbound sync reuses**:
  TruePoint gains a new `forge_sync` connector bound to a system principal.
- **`packages/auth/src/rateLimit.ts`** — `checkCaptureRate(key, count)`: 2,000 records/min/caller, fails
  **open** on Redis outage (a scraping-abuse throttle, not a security control).

## B. The sync target — Layer-0 master graph (schema-only, no pipeline)

- **`packages/db/src/schema/masterGraph.ts`** — seven system-owned tables (header 1-16): `master_companies`,
  `master_persons`, `master_employment` (SCD2 stint edge, `-infinity` unknown-start sentinel, one primary/person),
  `master_emails`, `master_phones`, `source_records`, `match_links`.
  - **System-owned, NOT RLS-scoped** (6-9): no tenant_id/workspace_id; isolation is structural (no grant to
    `leadwolf_app`), never an RLS predicate. Do not add tenancy factories.
  - **PII scheme** (11-12, `master_emails` 227-253, `master_phones` 258-278): channel PII only, as `bytea`
    AES-GCM ciphertext (`email_enc`/`phone_enc`, nullable — a match-against mint stores the index with no
    revealable value) + **HMAC blind index** (`email_blind_index`/`phone_blind_index`), **GLOBALLY UNIQUE** →
    the dedup + DSAR/suppression key. **Forge's sync must honor this scheme** (encrypt + blind-index before upsert).
  - **`source_records`** (288-310) — immutable per-source evidence log. `content_hash bytea NOT NULL`
    **UNIQUE (`uniq_source_records_content_hash`, 303) → idempotent ingest**; `raw_data jsonb` verbatim;
    `match_keys jsonb`; `resolved_person_id`/`resolved_company_id` set by ER; `ingested_at` is the deferred
    monthly-partition key (285-287).
  - **`match_links`** (317-348) — ER output; `cluster_id` IS the golden entity id (no separate cluster table);
    `is_duplicate_of` survivor link on merge; `review_status` enum `auto|pending|confirmed|rejected` (341-344,
    default `auto`); `match_method` `deterministic|splink|manual`; `match_probability` Fellegi-Sunter.
    → **Forge sets `review_status='confirmed'`** on sync (resolution already happened upstream).
- **`docs/planning/decisions/ADR-0021`** — Layer-0 master graph + Layer-1 per-workspace overlay design (referenced,
  the golden universe is system-owned; overlay `contacts`/`accounts` are RLS-FORCED).

## C. Reuse-and-extend inventory (shipped in TruePoint — do NOT duplicate; Forge mirrors the pattern)

- **Staff RBAC:** `packages/types/src/staffCapability.ts` — `data_ops` staff role + `data:*` capabilities
  (`data:read|manage|review|export`); `super_admin` implies all. Enforced by `apps/api/src/middleware/
  {requireStaffRole,requireCapability}.ts`.
- **Maker-checker approvals:** `approval_requests` table (`packages/db/src/schema/platformOps.ts`) +
  executors in `apps/api/src/features/admin/dataRoutes.ts` (each route `requireCapability("data:*")`, every
  mutation on audited `withPlatformTx`; e.g. `dedup_merge` Grain-A overlay merge).
- **Import pipeline:** `import_jobs`/`import_job_chunks`/`import_job_rows` (`schema/importJobs.ts`) with
  `column_mapping`, `conflict_policy`, `staging_table`, `byte_offset` resume, `reject_histogram`,
  `av_scan_status`, `idempotency_key`; COPY → UNLOGGED staging in `packages/core/src/import/bulkStage.ts`
  (uses `ownerClient` — COPY forbidden on RLS tables); `runImport.ts`/`parseFile.ts`/`columnMap.ts`/
  `validateRow.ts`/`prepareContact.ts`/`normalize.ts`/`encryptPii.ts`/`blindIndex.ts`/`contentHash.ts`.
  Mapping templates: `import_mapping_templates`. Doc spec: `docs/planning/30-bulk-import-export-pipeline.md`
  (Salesforce Bulk-API-2.0 state machine; `rows_in = succeeded + rejected + deduped + unprocessed`), ADR-0036.
- **Enrichment:** `packages/core/src/enrichment/` — `enrichContact.ts` (cache → daily-budget breaker →
  waterfall → overlay upsert + provenance), `waterfall.ts` (`runWaterfall` trust÷cost order, circuit breakers;
  `runWaterfallBulk` cheap-parallel-then-expensive), providers in `packages/integrations/src/enrichment/
  providers.ts` (Apollo/ZoomInfo/Clearbit). Credit metering: `provider_calls.cost_micros`, `credit_ledger`.
- **Entity resolution:** `packages/core/src/er/fellegiSunter.ts` (pure Fellegi-Sunter scorer,
  auto_match/pending_review/no_match), `er/compareRecords.ts`, `er/stringSimilarity.ts`; `erRepository.ts`;
  shadow queue `apps/workers/src/queues/erSweep.ts` (INERT behind `ER_SHADOW_ENABLED`, proposes `match_links`
  pending, never auto-merges). Soft overlay dedup: `packages/core/src/prospect/dedup.ts` (writes
  `duplicate_of_contact_id`, `pickCanonical` precedence). → **Forge relocates/rebuilds this as its own ER
  engine; TruePoint's `er/` stays inert for ingestion (ADR-0047).**
- **Verification:** `packages/core/src/data-health/` — `emailVerifier.ts` (pass-through/static/hybrid ports +
  `reacherVerifier.ts`), `phoneVerifier.ts`/`twilioPhoneVerifier.ts`, `reverifyContacts.ts`; ledger =
  `verification_jobs` (`schema/verificationJobs.ts`); quality trend = `data_quality_snapshots`
  (`schema/dataQualitySnapshots.ts`); custom checks = `validation_rules` (`schema/validationRules.ts`).
- **Worker platform:** `apps/workers/src/register.ts` (one shared `IORedis`, `Queue`s exported, `startWorkers()`),
  `retryPolicies.ts` (per-queue exponential + jitter, asserted by `ALL_RETRY_POLICIES` test), `deadLetter.ts`
  (PII-free DLQ), `leaderLock.ts` (`withLeaderLock`, Redis SET PX NX + owner-checked Lua release),
  `outboxRelay.ts` (drains `worker_outbox` via `FOR UPDATE SKIP LOCKED`, ADR-0027 transactional outbox),
  `realtimeRelay.ts`, `tuning.ts`, `withDeadline.ts`, `metrics.ts` (`/metrics` Prometheus), `health.ts`.
  Queue names in `packages/types/src/workerQueues.ts` (~25 queues, many flag-dark). Repeatable jobs use a
  **stable jobId** for dedup.
- **AI seam:** `packages/integrations/src/anthropic/` — `nlSearchAdapter.ts` (Messages API `/v1/messages`,
  `output_config.format` structured JSON, `thinking: adaptive`, one repair pass, prompt-injection defense),
  `replyClassifierAdapter.ts`. Provider-agnostic port: `packages/core/src/ai/aiPort.ts` +
  `compileSearchQuery.ts` (wraps `promptGuard.ts` + `budgetGuard.ts`). Metering: `ai_requests`
  (`schema/aiRequests.ts`). ADR-0023 (Anthropic is the AI provider). Config: `ANTHROPIC_API_KEY`,
  `AI_NL_SEARCH_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_VERSION`.
- **Audit:** tenant `audit_log` (append-only, closed enum, `packages/types/src/billing.ts` `auditAction`;
  writer `packages/core/src/compliance/writeAudit.ts` in the mutation tx). Platform `platform_audit_log`
  (immutable, written by `withPlatformTx`/`recordPlatformEvent` in `packages/db/src/client.ts:121-178`;
  vocabulary `packages/types/src/platformAudit.ts`, ADR-0032). Product timeline `activities`
  (`schema/activity.ts`).
- **Admin data-ops UI:** `apps/admin` is **Next.js 15 App Router + React 19** (NOT vanilla React — memory
  correction). `apps/admin/src/features/data-ops/` (approvals/dedup/enrichment/quality/validation/verification
  pages, hooks `useDataOpsOverview`/`useDedupReview`/…, `api.ts` → `/api/v1/admin/data/*`). Health/queue probes:
  `apps/api/src/features/admin/{queueProbes,systemHealthProbes}.ts`. UI kit: `@leadwolf/ui`
  (`packages/ui/src/index.ts`) — `StateSwitch`/`LoadingState`/`EmptyState`/`ErrorState`/`Skeleton`, `DataTable`,
  `StatTile`, `StatusBadge`, `Card`, `Pagination`, `Tabs`/`SegmentedControl`, `Dialog`/`Drawer`, `Combobox`,
  `Toast`; tokens `var(--tp-*)`; network seam `fetchWithAuth`.

## D. Tenancy / DB access model (Forge mirrors, simplifies to staff-scope)

- `packages/db/src/client.ts` — tx scopes: `withTenantTx` (RLS, `SET LOCAL ROLE leadwolf_app` + GUCs
  `app.current_tenant_id`/`app.current_workspace_id`, RDS-Proxy/PgBouncer-safe), `withPrivilegedTx`
  (leadwolf_admin BYPASSRLS, DSAR), `withErTx` (leadwolf_er, Layer-0), `withPlatformTx` (owner, cross-tenant,
  writes `platform_audit_log` in-tx), `withPlatformReadTx` (owner, unaudited public config). Fail-closed GUC
  idiom `NULLIF(current_setting(…, true), '')::uuid`. RLS policies in hand-authored `packages/db/src/rls/*.sql`.
- **Migrations are hand-authored** (`packages/db/src/migrations/0000…0052`, journal `meta/_journal.json`).
  `drizzle-kit generate` is **UNSAFE here** (stale snapshots re-add existing tables). Forge follows the same
  hand-authored discipline. (Coordinator host has no docker → new-table features are CI-verified.)

## E. The Chrome extension today (and its pivot)

- **`apps/extension`** — `@leadwolf/extension`, MV3, Vite + CRXJS + React 19. Content script matches
  `https://*.linkedin.com/*` only. **Captures visible-DOM profile-header fields only** (fullName, jobTitle,
  location, profileUrl, publicId) — **NO XHR/API interception** (a deliberate ADR-0043 guardrail). Queue =
  IndexedDB (`captureQueue.ts`), idempotency = SHA-256(sourceUrl + fields), alarm-driven drain → `POST
  /api/v1/ingest` with Bearer + Idempotency-Key.
- **Auth = companion-window (ADR-0045):** `login()` opens `app.truepoint.in/auth/extension?state=<nonce>`;
  the web page mints an extension token via `POST /auth/extension/mint` (aud=`chrome-extension://<id>`,
  scope `["extension"]`, separate session family, no platform-admin bit) and `chrome.runtime.sendMessage`s
  the handoff (verified `sender.origin` + `state`). Refresh in `chrome.storage.session`. Gate =
  `EXTENSION_ORIGINS` allow-list (`packages/config/src/env.ts`, each `^chrome-extension://[a-p]{32}$`),
  folded into `appOrigins()`/`isAllowedOrigin()`.
- **ADR-0043 decision #4 (`ADR-0043:43-46`) explicitly REJECTS MAIN-world interception**; alternatives
  (`85-86`) reject the "faithful Apollo clone (MAIN-world interception of LinkedIn private APIs)". Teardown of
  Apollo's technique documented in `docs/planning/chrome-extension/01-apollo-teardown.md` (now the *template*).
  Config flags (all off by default): `CHROME_EXTENSION_ENABLED`, `INGESTION_EVIDENCE_ENABLED`, `EXTENSION_ORIGINS`.
  → **ADR-0046 amends this**: the extension gains a MAIN-world raw-capture mode posting **envelope v2 to
  Forge**, never to TruePoint. Raw payloads never reach the production CRM (compliance firewall).

## F. Prior planning art the Forge suite must cross-link (not restate)

- `docs/planning/prospect-database-platform/` (00-12) — unified ingestion, processing pipeline, internal
  knowledge DB (versioning/lineage/provenance/freshness), `06-Chrome-Extension-Capture.md` (product/compliance
  spec), DB-operations module (review queue/merge/split), probabilistic ER build.
- `docs/planning/database-management-research/` (01-16) — control-panel two-surface model (staff `withPlatformTx`
  vs customer `withTenantTx`), upload pipeline, validation framework, dedup+linking review queue, `09-Review-
  and-Approval-System.md` (maker/checker), monitoring, RBAC, security, perf, roadmap, gap register G01-G32.
- `docs/planning/data-management/` (00-16, DM1-DM9 decisions), `docs/planning/chrome-extension/` (00-12),
  `docs/planning/30-bulk-import-export-pipeline.md`, `docs/planning/28-enterprise-readiness-audit.md`
  (gap-ID vocabulary), `docs/planning/audits/platform-admin/` (audit-suite doc structure template).
- **ADRs:** highest existing = **ADR-0045** (verified). Next free = **ADR-0046, ADR-0047** (0033 skipped,
  0036 duplicated). ADR format: metadata header (Status/Date/Related/Detail) + `## Context` · `## Decision`
  (numbered bold) · `## Rationale` · `## Alternatives considered` (verdict table) · `## Consequences`
  (Positive/Costs/Net-new) · `## Revisit if`.

## G. House documentation conventions (every Forge doc obeys)

- Numbered `NN-kebab-title.md` + a `00-README.md` index with a **status-badge legend**.
- **Blockquote preamble** stating the doc's canonical contract + the locking ADR.
- **`file:line`-grounded** current-state claims (cite THIS sheet).
- **"Owner of the deep detail" cross-links** instead of restating another doc's schema/ADR.
- **Gap-ID registers** (e.g. `G-FORGE-NN`) mapped where relevant to `28-enterprise-readiness-audit.md`.
- **Mermaid** diagrams for lifecycles/architecture; **tables** for status/accounting.
- Explicit **`## Open questions`** section at the end of every doc.
- Conformance to the six `truepoint-*` skills; **security has final say**; platform owns tenancy/API/scale.
