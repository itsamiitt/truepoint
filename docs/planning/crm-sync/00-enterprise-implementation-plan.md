# CRM Bidirectional Sync — Enterprise Implementation Plan

> **Status:** Architecture plan (pre-build). Lead-architect synthesis of the Understand
> (infra / data / auth / domain) and Design (engine / connectors-oauth / data-model /
> conflict-dedup / security-erasure / scale-reliability / observability / rollout) passes.
> **Product brand:** TruePoint. **Code scope:** `@leadwolf/*` (both correct, by design).
> **Owners to wire in:** platform (queues, RLS, API), data (model, provenance), security
> (final say on tokens/PII/erasure), design (the two consoles), operations (runbooks/FinOps).
> Every load-bearing claim cites a real `file:line` to reuse. Net-new code is called out as such.

---

## 1. Summary, goals, non-goals, why now

### 1.1 Summary

Build a **bidirectional CRM sync engine** (Salesforce + HubSpot first) that keeps a customer's
TruePoint workspace and their CRM in agreement: TruePoint enriches and verifies; the CRM stays the
customer's system of record. The engine is **workspace-scoped under RLS**, runs entirely on the
**existing BullMQ worker/queue scaffolding** (`apps/workers/src/register.ts`), stores OAuth tokens
with the **`mailbox_integration` encrypted-credential discipline** (`packages/db/src/schema/email.ts:93-125`),
resolves conflicts on the **existing `field_provenance` substrate** (`packages/core/src/prospect/fieldProvenance.ts`)
— adding **no parallel provenance or identity mechanism** — and extends the **existing DSAR
fan-out** (`packages/core/src/compliance/deleteFanout.ts`) so erasure propagates *outward* to the
CRM. It ships **triple-gated and dark** (per-tenant flag + global env kill-switch + per-connection
`shadow→enforce`), exactly the posture the bulk-import and retention engines already use.

### 1.2 Goals

1. **Connect** a workspace to Salesforce and/or HubSpot via server-side OAuth (auth-code + PKCE),
   tokens encrypted at rest, never logged, never read into a DTO.
2. **Backfill** existing CRM records into TruePoint (and optionally push existing TruePoint records
   out) as a bounded, resumable, idempotent bulk job that never starves real-time work.
3. **Incremental two-way sync**: CRM→TruePoint (enrich-in) and TruePoint→CRM (write-back), using
   **webhooks/CDC for latency and a scheduled reconcile poll for correctness** (hybrid).
4. **Match, don't duplicate** — on both sides (TruePoint dedup keys; CRM upsert-by-external-key).
5. **Conflict resolution** by per-field **direction + authority**, honoring human-pinned fields,
   with genuine conflicts routed to a review queue (never silent clobber).
6. **Loop prevention** so a two-way sync never oscillates (origin-tag → provenance-`src` → content-hash → watermark).
7. **Erasure propagation**: a DSAR delete erases/suppresses the subject in the linked CRM and a
   surviving CRM linkage **blocks DSAR `completed`**; suppression blocks any re-creation.
8. **Observability + ops**: customer + staff sync-health surfaces, alerting, a DLQ + replay tool,
   and four runbooks — all on the durable-DB-ledger + JSON-line-log model the repo already uses.

### 1.3 Non-goals (v1)

- **No third CRM at GA.** Pipedrive/Close/etc. are the fast-follow (and the `Merge.dev` decision, §11).
- **No custom-object / deal-pipeline sync at GA.** Contacts + Accounts (SFDC Lead/Contact/Account,
  HubSpot contacts/companies) only. Deals/tickets are a later phase (the `crm_object_type` enum
  reserves the values).
- **No activity/engagement-log sync at GA** (calls/emails → CRM tasks). It is the highest-value
  fast-follow (Outreach's differentiator) but is additive and out of the v1 critical path.
- **No new metrics/OTel/paging backend.** Observability rides the DB ledger + structured logs +
  a leader-locked alert tick (a real tracer/pager is a separate platform decision).
- **No arbitrary customer-authored field transforms.** Only a closed, code-side registry of vetted
  pure transforms (security: no eval surface).

### 1.4 Why now (enterprise value)

CRM sync is the single most-requested enterprise integration and the table-stakes parity feature
against Apollo, ZoomInfo, Clay, and Outreach — all of whom lead with "native two-way Salesforce +
HubSpot sync." It is the **delivery mechanism that makes every other TruePoint data product
monetizable inside the customer's existing workflow**: enrichment, verified email/phone, and intent
are worth far more written back into the system of record than trapped in a separate tool. TruePoint
has two structural advantages to lean on that competitors lack at the per-workspace level: the
**golden master graph + `match_links`** (a stronger matching substrate than a per-workspace sync
usually has — `packages/db/src/schema/masterGraph.ts`) and a **no-lock-in, suppression-respecting**
compliance posture (`docs/planning/26-integrations-data-delivery.md:§1`). It is also a planned
milestone (M10, `docs/planning/26-integrations-data-delivery.md:20`; `docs/planning/data-management/07-sync.md`),
and the substrate to build it on (queues, RLS, encrypted-token rows, provenance, DSAR fan-out,
webhook primitives) is **already shipped** — the gap is the connector layer and the sync loops,
not the platform.

---

## 2. Reconciled current state — what to reuse, and the genuine gap

CRM sync is **largely net-new wiring over existing primitives**. There is **no CRM/OAuth/external-id
code in the repo today** (grep for `oauth|access_token|refresh_token|external_id|crm` over app/pkg
source returns nothing) — but almost every primitive a sync engine needs already ships.

### 2.1 Reuse directly (cited)

| Concern | Reuse | Evidence |
|---|---|---|
| Queue/worker/DLQ/`instrument` scaffolding | one shared blocking Redis conn; producer/consumer/DLQ; `instrument()` never logs payloads | `apps/workers/src/register.ts:81,261-273,282-288`; header names "CRM sync" as next (`register.ts:2-3`) |
| Leader-locked scheduled sweep | `withLeaderLock` + enumerate-due + bounded fan-out + injected `enqueue` | `apps/workers/src/leaderLock.ts:17`; `apps/workers/src/queues/reverificationSweep.ts:22,32-60`; per-tenant variant `dataRetentionSweep.ts` |
| Repeatable schedules (stable `jobId` = dedupe) | minute tick + daily sweep | `register.ts:164-169` (60s), `register.ts:205-211` (24h) |
| Discriminated drive→chunk bulk job | `z.discriminatedUnion("kind", …)`, payload = scope+jobId only, never rows | `packages/types/src/bulkImport.ts:63-74`; `packages/core/src/import/bulkProcessChunk.ts` |
| Queue contract pattern (apps never import apps) | name + Zod payload + ack/DLQ DTO in `@leadwolf/types` | `packages/types/src/reverification.ts:13-32`, `bulkImport.ts:21-110` |
| Tenancy / RLS | `withTenantTx` (`SET LOCAL ROLE leadwolf_app` + GUCs), `withPrivilegedTx`, `withErTx`, `withPlatformTx` | `packages/db/src/client.ts:40-61,74-94,121-137` |
| RLS policy shape (fail-closed) | `workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid`, `ENABLE`+`FORCE` | `packages/db/src/rls/contacts.sql:17-48` |
| Append-only table = no UPDATE/DELETE policy under FORCE RLS | `retention_runs` wall | `packages/db/src/rls/retention.sql:18-21,42-47` |
| Encrypted third-party OAuth token row | `mailbox_integration` (`oauth_token_enc bytea`, `safeColumns` omits it, single `markConnected` writer, `markError`) | `packages/db/src/schema/email.ts:93-125`; `packages/db/src/repositories/mailboxRepository.ts:20-41,82-105`; `packages/core/src/email/connectMailbox.ts:30-60` |
| Versioned secret-store envelope (KMS-rotation seam) | `version(1)|iv(12)|authTag(16)|ciphertext`, dedicated key env | `packages/core/src/email/secretStore.ts:13,16-19,22-41` |
| Provider port + injectable transport | `EnrichmentProvider`/`vendorProvider(spec, fetchJson)`; 429→`rate_limited` | `packages/integrations/src/enrichment/httpProvider.ts:6,9-12,35-63`; adapters `providers.ts:44-104` |
| Inbound HMAC webhook receiver | raw body, fail-closed verify, unknown→200, idempotent on deterministic event id, fast 200 | `apps/api/src/features/email/webhookRoutes.ts:40-75,89`; signature math `packages/core/src/billing/stripeWebhook.ts:28-46` |
| Outbound dispatch + SSRF + signing | `redirect:"manual"`, re-validate URL at fire time, sign, never throw, log every attempt | `packages/core/src/webhooks/{dispatch,ssrfGuard,sign,webhooks}.ts` |
| Dedup / match ladder | `findByDedupKeys` email→linkedin→salesnav; account `domain`; co-op-safe mint | `packages/db/src/repositories/contactRepository.ts:330-456`; `masterGraphRepository.resolveForImport` `:100-163` |
| Field-level provenance + pin gate | `planFieldWrite` (skip pinned), `planUserEdit` (pin), descriptor `{src,mth,conf,obs,ver,pin}` | `packages/core/src/prospect/fieldProvenance.ts:40-80`; `packages/types/src/fieldProvenance.ts:19-59` |
| Raw lineage + idempotent ingest | `source_imports` (`source_name` enum already has `'salesforce'`,`'hubspot'`; `content_hash` UNIQUE) | `packages/db/src/schema/contacts.ts:256,261-263,273`; `sourceImportRepository.ts:49-95` |
| DSAR fan-out (inward) | find-by-blind-index → tombstone → purge dependents (incl. `list_members`) → global suppression → verification-gated `completed` | `packages/core/src/compliance/deleteFanout.ts:19-74`; `dsarRepository.ts:70-177`; `apps/workers/src/queues/dsar.ts:15-20` |
| Suppression gate | `assertNotSuppressed`/`findMatch` (global+tenant+workspace by blind index/domain/contactId) | `packages/core/src/compliance/assertNotSuppressed.ts:12-17`; `suppressionRepository.ts:50-74` |
| Redis rate-limiter primitive | `RateLimiterRedis` lazy singletons (`enableOfflineQueue:false`), **fails open** | `packages/auth/src/rateLimit.ts:13-15,22-44,54` |
| Budget reserve/refund primitive | increment-then-check + refund-on-failure (injectable store) | `packages/core/src/ai/budgetGuard.ts:11-18,43-68` |
| Metered-cost ledger + config precedent | `provider_calls` (status/cost, never payload) + `provider_configs` (rate/budget caps) | `packages/db/src/schema/intel.ts:88-127`; `providerConfigRepository.ts:67-79` |
| Feature-flag gate (fail-closed) | `isFlagEnabledForTenant`; per-tenant override→global→default→OFF | `packages/core/src/featureFlags/evaluateFlag.ts:25-41`, `flagsForTenant.ts:56-62`; tables `schema/featureFlags.ts:15-44` |
| Double-gate + shadow→enforce | `BULK_IMPORT_ENABLED` env kill-switch; retention per-class `mode` default `'shadow'` | `packages/config/src/env.ts:166-169`; `packages/db/src/migrations/0025_retention_engine.sql:4-7`; `packages/core/src/retention/runRetentionSweep.ts:11-17,66-117` |
| Health probe (queue depth/workers) | `getJobCounts`+`getWorkers`, 1.5s timeout, honest `reachable:false` | `apps/api/src/features/import/bulkQueue.ts:53-89`; `apps/api/src/features/admin/systemHealthProbes.ts:43-83` |
| Customer + staff health surfaces | Data Health page; System health page; Imports monitor | `apps/web/src/features/data-health/...`; `apps/admin/src/features/system-health/...`; `apps/admin/src/features/imports/...` |
| Replay tool precedent | `replayDelivery` (re-sign, never reuse) + `POST …/replay` | `packages/core/src/webhooks/webhooks.ts:95`; `apps/api/src/features/webhooks/routes.ts:58-74` |

### 2.2 The genuine gap (must build)

1. **Third-party OAuth client.** No authorize-redirect / PKCE / code→token exchange / refresh
   exists anywhere — the mailbox connect explicitly deferred it ("the full OAuth redirect dance is
   the P1 adapter's job; at P0 we accept the token bundle", `connectMailbox.ts:5-6`).
2. **`CrmConnector` port + Salesforce/HubSpot adapters** (HTTP, pagination, bulk batching, rate-limit
   parsing, webhook-signature verify) — the `vendorProvider` shape generalized.
3. **The event-emitter fan-out that enqueues outbound pushes.** `dispatchToSubscription` is called
   *only* by self-test + replay today; `dispatch.ts:3` literally calls itself "the seam a real event
   emitter would call." TP-side change → enqueue push is net-new.
4. **Proactive per-connection rate/credit budget.** Only reactive-429 + an unmetered `costMicros`
   exist (`httpProvider.ts:59`); there is no budget cap, no ledger, no token bucket.
5. **Durable sync tables** (connection, external-id link, field mapping, watermark/cursor, inbound
   event log, run ledger, conflict queue, DLQ, OAuth handshake) + RLS + migration.
6. **Bidirectional conflict policy** wiring `field_provenance.{src,conf,pin}` + per-field
   direction/authority into a CRM-vs-TruePoint resolver (two new pure planners).
7. **Outbound erasure step** on the DSAR path + the suppression gate on the inbound create path.
8. **Four reliability inversions of existing defaults** (the only load-bearing scale changes —
   see §8): budget store must be **Redis-backed not process-local**; the outbound rate guard must
   **fail closed not open**; partial-failure must be **per-record not per-chunk**; workers need
   **explicit `concurrency` + a `limiter` + a built fair-share in-flight cap**.
9. **Real KMS** envelope-wrap of the data key under a CMK — the secret stores derive `sha256(env)`
   today (`secretStore.ts:16-19`), dev-grade. This is the **security-owned hard prerequisite**
   before any production CRM token is stored (§7.2, §11).

---

## 3. Architecture — connector abstraction + sync engine

### 3.1 Layering (the repo's hard rule, obeyed)

Apps never import apps; `core` is BullMQ/Redis/IO-free and declares ports; the composition root
(`apps/workers`) injects adapters. CRM sync follows the **bulk-import / reverification / master-backfill
triad** (a thin worker delegate → a pure core runner → an injected adapter), not a new shape.

| Concern | Package | Precedent |
|---|---|---|
| `CrmConnector` **port**, transform (CRM↔TP fields), the two conflict planners, the sync runners (`runCrmBackfillDrive/Page`, `runCrmDelta`, `applyInboundEvent`, `runCrmPush`, `runCrmErase`, `refreshConnection`, `connectCrm`), `CrmSecretStore` | `packages/core/src/crm/` | `runBulkImport`, `runReverification`, `planFieldWrite`, `email/secretStore.ts`, `connectMailbox.ts` |
| Connector **adapters** (`salesforce.ts`, `hubspot.ts`, `defaultCrmConnectors()`) — HTTP, pagination, batch, rate-parse, HMAC verify; injectable `CrmFetch` | `packages/integrations/src/crm/` (exported via `index.ts`) | `vendorProvider` / `providers.ts:44-104`; `defaultProviders()` |
| Queue names + Zod payloads + status/DLQ DTOs + flag key + provenance-`src` consts + enum mirrors | `packages/types/src/crm.ts` | `reverification.ts`, `bulkImport.ts` |
| Tables, RLS, repositories, migration | `packages/db/src/{schema/crm.ts, rls/crm.sql, migrations/0027*, repositories/crm*Repository.ts}` | `schema/email.ts`, `rls/contacts.sql`, `migrations/0024_bulk_import_jobs.sql` |
| Public inbound webhook route, OAuth connect/callback, api-side producers + health probe | `apps/api/src/features/crm/` | `email/webhookRoutes.ts`, `import/bulkQueue.ts` |
| Queue registration + consumer boot + adapter injection + DLQ wiring + alert tick | `apps/workers/src/queues/crm*.ts` + `register.ts` | `register.ts:262,282-314,474-503` |
| Customer "Sync" health slice + staff CRM-sync monitor | `apps/web/src/features/crm-sync/`, `apps/admin/src/features/crm-sync/` | `data-health/`, `imports/` |

**Transform discipline (load-bearing):** the heavy CRM↔TP field mapping and the conflict planners are
**pure functions in `core`**; the **adapter** does only HTTP + pagination + status mapping; **`apps/api`
does only signature-verify + minimal-parse + enqueue** (never the transform — webhook payloads are
lossy id/delta hints, so the worker re-fetches the canonical record); **`apps/workers` does only
composition + delegation**. This mirrors `webhookRoutes.ts:58` (api parses just enough to route) and
`bulkProcessChunk` (worker delegates the pipeline to core).

### 3.2 Queue topology

Partition key is the **connection** (`connection_id`), not the workspace — the rate cap, OAuth token,
daily budget, and watermark are all per-connection (a workspace may hold a Salesforce *and* a HubSpot
connection with independent caps). Every job payload carries `{ scope:{tenantId,workspaceId},
connectionId, … }` so the worker re-enters `withTenantTx(scope, …)` (the `reverification.ts:22` shape).

| Queue | Role | Cadence / trigger | Cloned from |
|---|---|---|---|
| `crm-sync-sweep` | leader-locked scheduler → fans out pull/reconcile jobs | repeatable 60s (delta) + 24h (reconcile) | `reverificationSweep.ts` + `scheduleSequenceTick`/`scheduleReverificationSweep` |
| `crm-sync-backfill` | initial bulk load, discriminated `drive`→`page` | one-shot per connect | `bulkImport.ts:65-74` + `bulkProcessChunk.ts` |
| `crm-sync-pull` | incremental CRM→TP delta by watermark | from sweep | `reverification.ts` |
| `crm-sync-inbound` | webhook/CDC hint → re-fetch → apply | from inbound route | `reverification.ts` |
| `crm-sync-push` | TP→CRM outbound upsert (metered, rate-budgeted) | from the new event-emitter fan-out | `outreach`/`reverification` enqueue |
| `crm-sync-dlq` | PII-free dead-letter (all queues; `queue` discriminator field) | on retry-exhaustion | `IMPORTS_DLQ` / `deadLetterFailedImport` (`imports.ts:75-95`) |

A 60s **alert-eval tick** (`crm-sync-alert-tick`) also runs under the leader lock (§9.5).

### 3.3 Data + control flow (diagram-in-text)

```
                         ┌──────────────────────── CONNECT (one-time, interactive) ──────────────────────┐
  Admin (app.) ──OAuth──▶│ POST /crm/connections → crm_oauth_states(state,PKCE) → 302 provider authorize │
                         │ GET  /crm/oauth/callback?code&state → exchangeCode → SSRF-validate instanceUrl │
                         │ → CrmSecretStore.encrypt(bundle) → crmConnectionRepository.markConnected       │
                         │ → seed crm_field_mappings (code defaults) → writeAudit(crm.connect)            │
                         └──────────────────────────────────────────────────────────────────────────────┘

  ── INBOUND (CRM → TruePoint): latency layer + correctness layer ───────────────────────────────────────
   CRM webhook/CDC ──HMAC raw body──▶ POST /crm/webhooks/:provider (PUBLIC, before authed router)
        │  verifyWebhook(raw,hdrs,secret) fail-closed → drop our-own-origin echoes → unknown→200
        │  idempotent insert crm_inbound_events (UNIQUE connection_id,provider_event_id) → enqueue
        ▼            jobId = crm-inbound:{connId}:{eventId}  (queue-level dedupe)
   [crm-sync-inbound worker] ──▶ runCrmDelta/applyInboundEvent in core, under withTenantTx:
        connector.fetchOne(externalId)         (re-fetch canonical — webhook is a lossy hint)
        → transform → resolve identity (link fast-path → findByDedupKeys → resolveForImport/withErTx)
        → SUPPRESSION GATE on incoming blind index (refuse re-create of erased subject)
        → planCrmInboundMerge (pin-gate + direction + authority + conf + LWW)  ── conflict → crm_sync_conflicts
        → persist writableFields + field_provenance + append source_imports(content_hash)
        → upsert crm_record_links(last_synced_hash, last_inbound_modstamp) → writeAudit(crm.sync)
        → advance crm_sync_state.watermark (inbound)  → crm_sync_runs counts

   [crm-sync-sweep] every 60s (leader lock) enumerates connections where status='connected'
        AND next_poll_at<=now (cap MAX_CONNECTIONS_PER_SWEEP) → enqueue crm-sync-pull
        jobId = crm-pull:{connId}:{object}  → pullDelta(since = watermark − overlap) → same apply path.
        every 24h → reconcile poll (full SystemModstamp / hs_lastmodifieddate scan) = correctness backstop.

  ── OUTBOUND (TruePoint → CRM): write-back ─────────────────────────────────────────────────────────────
   TP record change ──▶ NEW event-emitter fan-out (the dispatch.ts:3 seam) → enqueue crm-sync-push
        jobId = crm-push:{connId}:{tpEntityId}:{changeSeq}, payload = {tpEntityId, contentHash, idemKey}
   [crm-sync-push worker] under withTenantTx:
        read TP record → SUPPRESSION GATE (assertNotSuppressed) before any push
        → planCrmOutboundPush (direction≠in, authority≠crm, src≠this-CRM echo-guard, conf≥thr)
        → content-hash short-circuit (skip if unchanged) → reserve per-connection budget (fail-closed)
        → connector.upsert(externalKey = TP UUID, batch ≤200 SFDC / ≤100 HubSpot)  [shadow: record diff, no HTTP]
        → record crm_record_links(last_synced_hash,last_outbound_at) → advance outbound watermark
        → writeAudit(crm.sync)  → crm_sync_runs counts;  429 → re-enqueue {delay} (NOT an attempt)

  ── BACKFILL (one-shot) ────────────────────────────────────────────────────────────────────────────────
   connect → crm-sync-backfill drive → create crm_sync_runs row → fan out first page (low priority)
   page → connector.pullPage(cursor) → apply path → persist next_cursor → if more, enqueue next page
   last page → set crm_sync_state.watermark = page high-watermark; backfill_status=completed → sweep takes over.

  ── ERASURE (DSAR, outward) ────────────────────────────────────────────────────────────────────────────
   dsar worker → deleteFanout (inward: tombstone + global suppression) → NEW: for each erased copy with a
        crm_record_links row, enqueue per-(workspace,connection) crm-erase job (withTenantTx):
        connector.eraseOrSuppress(externalId) [HubSpot gdpr-delete / SFDC hardDelete|anonymize+DNC]
        → delete crm_record_links row → writeAudit(crm.erase) → proof into dsar_requests.scope_report
   crm_record_links is in scanResiduals (blocks `completed`) but NOT in purgeDependents → re-run deleteFanout
        sees zero residuals → DSAR flips to completed.  Global suppression row = permanent re-creation wall.

  ── GATES (wrap everything) ────────────────────────────────────────────────────────────────────────────
   L1 env CRM_SYNC_ENABLED  →  L2 per-tenant flag crm_sync_enabled  →  L3 connection sync_mode shadow/enforce
       →  L4 per-field crm_field_mappings.direction
```

---

## 4. Data model

Nine new tables, all **Layer-1 overlay** (two-tier `tenant_id`+`workspace_id`, both `NOT NULL`, FK
`onDelete: cascade`), all `ENABLE`+`FORCE ROW LEVEL SECURITY` with the fail-closed workspace-GUC
policy (`rls/contacts.sql:17-44`), every read/write under `withTenantTx`. None is named `master_*`
(the catch-all `REVOKE` at `applyMigrations.ts:99-110` would strip the app grant). Migration is
hand-authored **`0027_crm_sync.sql`** (next number; latest is `0026`) in the `0024` style
(`CREATE TABLE IF NOT EXISTS`, varchar+CHECK enums, `--> statement-breakpoint`), plus
**`0028_seed_crm_flags.sql`** (flag seed) and a new **`rls/crm.sql`** (auto-applied alphabetically,
`applyMigrations.ts:173-178`).

### 4.0 Naming reconciliation (resolving the design-dimension tension)

The dimensions used slightly different table names; this plan standardizes them. The data-model
dimension correctly argued the external-id map and the watermark are **different cardinalities**
(one row per CRM record vs one row per stream) and must be two tables — adopted.

| Concept | Canonical name (this plan) | Dimension aliases reconciled |
|---|---|---|
| connection + encrypted token | `crm_connections` | `integrations` (07-sync) |
| external-id ↔ entity 1:1 map | `crm_record_links` | `crm_object_links`, `sync_state` |
| per-(conn,object,dir) watermark/cursor | `crm_sync_state` | `crm_sync_cursors` |
| per-field direction/authority/transform | `crm_field_mappings` | `sync_field_policy`, `crm_field_policy` |
| raw inbound event firehose (idempotency) | `crm_inbound_events` | `crm_sync_events` (conflict dim) |
| per-batch run ledger (metrics) | `crm_sync_runs` | — |
| human conflict review queue | `crm_sync_conflicts` | `sync_conflicts` |
| PII-free poison-job DLQ | `crm_sync_dead_letter` | `crm_sync_errors` |
| short-lived OAuth/PKCE handshake | `crm_oauth_states` | — |

### 4.1 `crm_connections` — connection + encrypted token (clone of `mailbox_integration`)

```sql
CREATE TABLE IF NOT EXISTS "crm_connections" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "owner_user_id" uuid,                          -- connecting admin (SOFT attribution, NOT an access wall)
  "provider" varchar(20) NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "sync_mode" varchar(20) DEFAULT 'shadow' NOT NULL,   -- L3 dark-launch gate
  "environment" varchar(20) DEFAULT 'production' NOT NULL,
  "external_account_id" varchar(255),            -- SFDC org id / HubSpot hub id (non-secret)
  "instance_url" varchar(500),                   -- SFDC instance host (MUST persist; API base); null for HubSpot
  "oauth_token_enc" bytea,                       -- CrmSecretStore versioned-envelope ciphertext (whole bundle)
  "token_expires_at" timestamptz,               -- NON-secret refresh-scheduler hint (decrypt-free)
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,   -- granted scopes (non-secret) for capability checks
  "next_poll_at" timestamptz,                    -- sweep eligibility cursor
  "last_error" varchar(500),
  "last_refresh_at" timestamptz,
  "connected_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "crm_connections_provider_enum" CHECK ("provider" IN ('salesforce','hubspot','pipedrive')),
  CONSTRAINT "crm_connections_status_enum"    CHECK ("status" IN ('pending','connected','error','paused','disconnected')),
  CONSTRAINT "crm_connections_mode_enum"      CHECK ("sync_mode" IN ('disabled','shadow','enforce')),
  CONSTRAINT "crm_connections_env_enum"       CHECK ("environment" IN ('production','sandbox'))
);
CREATE UNIQUE INDEX "uniq_crm_connections_ws_provider_account"
  ON "crm_connections" ("workspace_id","provider","external_account_id") WHERE "external_account_id" IS NOT NULL;
CREATE INDEX "idx_crm_connections_sweep" ON "crm_connections" ("status","next_poll_at"); -- sweep enumerates due
```

**RLS posture:** workspace-scoped FORCE RLS for *visibility* (workspace-wide). `owner_user_id` is a
soft attribution column, **not** a per-row wall (identical to `contacts.owner_user_id`,
`contacts.ts:113-117`). Privileged mutations (connect/disconnect, flip `sync_mode` to `enforce`,
set budget) are **admin-gated in the app layer + audited**, not by a row-owner predicate. The
encrypted token is protected at the **repository** layer via a `safeColumns` projection that omits
`oauth_token_enc` (`mailboxRepository.ts:20-41`), never by RLS. `sync_mode` default `'shadow'`
mirrors `retention_policies.mode` (`0025_retention_engine.sql:7`) — nothing leaves the tenant until
an operator flips a connection to `enforce`.

### 4.2 `crm_record_links` — external-id ↔ contact/account 1:1 map (the durable idempotency anchor)

The analog of the overlay→master bridge (`contacts.master_person_id`, `contacts.ts:112`) and the
external-id precedent `sales_nav_links` (`salesnav.ts:21-58`). This is the **real write-idempotency
guard** the convenience idempotency middleware is explicitly *not*.

```sql
CREATE TABLE IF NOT EXISTS "crm_record_links" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,                  -- denormalized for direct RLS on this highest-volume table
  "connection_id" uuid NOT NULL,                 -- FK crm_connections ON DELETE cascade
  "tp_entity_type" varchar(10) NOT NULL,         -- 'contact' | 'account'
  "contact_id" uuid,                             -- FK contacts ON DELETE cascade (set iff tp_entity_type='contact')
  "account_id" uuid,                             -- FK accounts ON DELETE cascade (set iff tp_entity_type='account')
  "crm_object_type" varchar(40) NOT NULL,        -- 'Lead'|'Contact'|'Account' | 'contacts'|'companies'
  "crm_record_id" varchar(255) NOT NULL,         -- the CRM Record ID (hs_object_id / SFDC 18-char)
  "external_key" varchar(255),                   -- the upsert key WE set on the CRM (= TruePoint UUID)
  "last_synced_hash" bytea,                       -- sha256(mapped field-set) → content-hash no-op / echo guard
  "last_inbound_modstamp" timestamptz,
  "last_inbound_at" timestamptz,
  "last_outbound_at" timestamptz,
  "link_status" varchar(20) DEFAULT 'linked' NOT NULL,  -- linked | ambiguous(review) | broken
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "crm_record_links_type_enum"   CHECK ("tp_entity_type" IN ('contact','account')),
  CONSTRAINT "crm_record_links_status_enum" CHECK ("link_status" IN ('linked','ambiguous','broken')),
  CONSTRAINT "crm_record_links_exactly_one" CHECK (num_nonnulls("contact_id","account_id") = 1)
);
-- The two 1:1 idempotency walls (the actual durable guard, not the middleware):
CREATE UNIQUE INDEX "uniq_crm_record_links_crm"     ON "crm_record_links" ("connection_id","crm_object_type","crm_record_id");
CREATE UNIQUE INDEX "uniq_crm_record_links_contact" ON "crm_record_links" ("connection_id","contact_id") WHERE "contact_id" IS NOT NULL;
CREATE UNIQUE INDEX "uniq_crm_record_links_account" ON "crm_record_links" ("connection_id","account_id") WHERE "account_id" IS NOT NULL;
CREATE INDEX "idx_crm_record_links_recon" ON "crm_record_links" ("connection_id","last_inbound_modstamp"); -- reconcile scan
```

**SFDC Lead→Contact conversion** (the one genuinely tricky correctness case) is handled by
**re-pointing this same row** (UPDATE `crm_object_type` `'Lead'→'Contact'`, `crm_record_id`→
`ConvertedContactId`): the `tp_entity` uniqueness survives, the `crm_record` uniqueness takes the
new value — no new row, no broken link. `link_status='ambiguous'` is the "multiple candidates →
route to review, don't auto-merge" posture from `match_links.review_status` (`masterGraph.ts:341-344`).

**Erasure caveat (load-bearing — §7.6):** the DSAR tombstone is a *soft* delete (`contacts.deleted_at`
set + PII nulled, `contacts.ts:165`), so `contact_id`'s `ON DELETE cascade` **never fires** for a
tombstoned contact. `crm_record_links` is therefore added to the DSAR **residual/verification** scan
(blocks `completed`) but **not** to `purgeDependents` — the outbound erase job needs the
`external_key`/`crm_record_id` and deletes the row itself after the CRM erase confirms.

### 4.3 `crm_field_mappings` — per-field direction / authority / transform

`sync_field_policy` (`07-sync.md:85`) made concrete. Per-connection (SFDC and HubSpot map differently
in one workspace).

| Column | Type | Notes |
|---|---|---|
| `id, tenant_id, workspace_id` | | |
| `connection_id` | uuid NOT NULL FK cascade | |
| `object_type` | varchar(10) CHECK `('contact','account')` | |
| `tp_field` | varchar(100) NOT NULL | a column path (`'jobTitle'`) or a `custom_fields` key (`'cf:renewal_date'`, `contacts.ts:166-168`) |
| `crm_field` | varchar(255) NOT NULL | CRM API field name (`'Title'`/`'My_Field__c'`; `'jobtitle'`) |
| `direction` | varchar(12) DEFAULT `'inbound'` CHECK `('inbound','outbound','bidirectional','disabled')` | conservative default = enrich-in (07-sync:70-71) |
| `authority` | varchar(12) DEFAULT `'crm'` CHECK `('crm','truepoint')` | source-of-truth per field |
| `conf_threshold` | numeric(4,3) | enrichment overwrites an *unpinned* field only when `incoming.conf > threshold` (07-sync:50) |
| `transform` | varchar(40) DEFAULT `'passthrough'` | **key into a closed code-side registry** (`'phone_e164'`,`'lowercase'`,`'seniority_map'`,`'date_iso'`,`'picklist_map'`,`'passthrough'`) — never executable code |
| `transform_config` | jsonb DEFAULT `'{}'` | params for the named transform (e.g. picklist→enum map) |
| `is_required, is_dedup_key, enabled` | boolean | |
| `created_at, updated_at` | timestamptz | |

Unique `(connection_id, object_type, tp_field, crm_field)`. A **starter mapping set is seeded in code
at connect time** (not in the migration): enrichment-owned scalars (`CONTACT_PROVENANCE_FIELDS` =
firstName, lastName, jobTitle, seniorityLevel, department, locationCountry/City, `fieldProvenance.ts:51-59`;
account `industry`/`employeeCount`/`technologies`) default `authority='truepoint'`; CRM-process
fields (owner, lifecycle, stage) default `authority='crm', direction='inbound'`. App-layer
validation rejects an ambiguous many-CRM-fields→one-`tp_field` inbound mapping.

### 4.4 `crm_sync_state` — incremental watermark (the `prov_hwm` analog)

One singleton row per `(connection, object, direction)` — the monotonic watermark + CDC replay
resume + backfill cursor. Models `master_companies.prov_hwm` ("monotonic re-projection guard",
`masterGraph.ts:81`).

Columns: `id, tenant_id, workspace_id, connection_id` (FK cascade); `object_type` CHECK
`('contact','account')`; `direction` CHECK `('inbound','outbound')`; `watermark` timestamptz (max
applied `SystemModstamp`/`hs_lastmodifieddate`); `replay_id` varchar(255) (SFDC CDC resume; null for
HubSpot/poll); `backfill_status` varchar(20) DEFAULT `'pending'` CHECK `('pending','running','completed')`;
`backfill_cursor` varchar(512) (resumable page token / Bulk-API job id); `last_run_id` uuid FK
`crm_sync_runs` SET NULL; `created_at, updated_at`. **Unique `(connection_id, object_type, direction)`.**
**Inbound and outbound keep separate watermarks** (loop prevention — §6.4).

### 4.5 `crm_inbound_events` — raw inbound firehose (idempotency wall), APPEND-ONLY

Append-only (SELECT + INSERT policy only under FORCE RLS — the `retention_runs` wall,
`rls/retention.sql:18-21`). **Unique `(connection_id, provider_event_id)`**, ingested via
`onConflictDoNothing` (the `sourceImportRepository.appendBatch`/`idempotencyRepository` store
pattern). This is the redelivered-webhook dedupe at the DB layer. Columns: `id, …scope…,
connection_id, provider, object_type, crm_object_type, crm_record_id, provider_event_id varchar(255),
event_type varchar(60), source_tag varchar(120)` (origin filter), `received_at, processed_at,
process_status varchar(20)`. The CDC/webhook id is `{crmRecordId}:{replayId|modstamp}`. Payloads are
deltas → **always re-fetch** the canonical record before applying.

### 4.6 `crm_sync_runs` — per-batch run ledger (the durable metric store)

The observability metric store, modeled on `retention_runs` (`retention.ts:43-67`). Columns:
`id, …scope…, connection_id, provider, object_type, direction, trigger` CHECK
`('backfill','scheduled','webhook','manual','replay','dsar')`; `mode` CHECK `('shadow','enforce')`
(snapshot of `connection.sync_mode` at run time, so a shadow "counted-but-didn't-write" run is
auditable — `retention_runs.mode`); `status` DEFAULT `'running'` CHECK
`('running','completed','partial','failed','cancelled')`; counts `records_seen/created/updated/matched/
skipped/conflicted/failed` integer DEFAULT 0; `api_calls` integer DEFAULT 0 (FinOps signal);
`rate_limited_ct` integer, `rate_limit_remaining` integer; `watermark_before/after` timestamptz;
`window_start/end` timestamptz; `sync_run_id` uuid (the correlation / poor-man's-trace id);
`failed_reason` text (PII-free); `started_at, finished_at, created_at`. Indexes
`(workspace_id, created_at desc)` and `(connection_id, started_at desc)`. **RLS:** SELECT + INSERT +
UPDATE (progress rows mutate `running→completed`), like `import_jobs`.

### 4.7 `crm_sync_conflicts` — human review queue (PII-masked)

A *successful* sync needing arbitration (distinct from an *error*). Columns: `id, …scope…,
connection_id, record_link_id` FK SET NULL, `object_type, field varchar(100), status` CHECK
`('open','resolved','ignored')`, `tp_value, crm_value, resolved_by, resolved_at, created_at`.
**Security constraint the design docs flagged:** for non-PII scalars (the `CONTACT_PROVENANCE_FIELDS`
set) store `tp_value`/`crm_value` in clear; for **PII fields (email/phone)** store only a **masked
diff** (last-4 / a `differs` boolean) and reference the contact — the real value stays in `email_enc`.
A review queue must not become a new cleartext-PII store.

### 4.8 `crm_sync_dead_letter` — PII-free poison-job DLQ

Written only after BullMQ retries exhaust (`deadLetterFailedImport`, `imports.ts:75-95`). Columns:
`id, …scope…, connection_id, run_id` FK SET NULL, `queue varchar(40), direction, object_type,
crm_object_type, crm_record_id varchar(255)` (opaque, aids replay), `tp_entity_id uuid` (id only),
`error_class` CHECK `('rate_limited','auth','validation','conflict_unresolved','transform','not_found',
'provider_5xx','ssrf_blocked','suppressed','unknown')`, `error_detail varchar(1000)` (PII-free
reason — provider code/snippet, **never** field values or token), `attempts integer, status` CHECK
`('open','retrying','resolved','ignored')`, `first_seen_at, last_seen_at, created_at`. **RLS:**
SELECT + INSERT only.

### 4.9 `crm_oauth_states` — short-lived PKCE/state handshake

The CSRF/PKCE row (analog of the single-use auth code, `auth/flow.ts:285-294`). Columns: `id,
tenant_id, workspace_id, owner_user_id, provider, state varchar(255) UNIQUE, code_verifier_enc bytea`
(via `CrmSecretStore`), `redirect_uri, environment, scopes jsonb, expires_at timestamptz` (~10 min,
the `AUTH_CODE_TTL_SECONDS` posture `env.ts:56`), `consumed_at, created_at`. Workspace-scoped FORCE RLS.

### 4.10 Provenance + lineage (a CRM is just another `src` — no parallel mechanism)

The DM1/DM6/DM9 invariant (`07-sync.md:50-54,121-122`): CRM data reuses the **existing**
`field_provenance` substrate, never a parallel one.

- **Source label:** `src: "crm:salesforce"` / `"crm:hubspot"` — a **platform-level** label, never a
  workspace/connection id (`fieldProvenance.ts:20`, C2). Set `mth:"crm_sync"`, `conf` from the
  mapping's authority/threshold, `obs` = the CRM record's `LastModifiedDate` (valid-time).
- **Pin gate for free:** inbound writes call `planFieldWrite`/`planCrmInboundMerge` (§6) inside
  `withTenantTx`; a pinned descriptor (`pin:true`, a human correction) is **skipped, never
  overwritten** (`fieldProvenance.ts:49-52`) — F2 satisfied by reuse.
- **Raw lineage + idempotent skip:** each inbound created/updated record also appends a
  `source_imports` row (`source_name='salesforce'`/`'hubspot'` — already in the enum, **no migration
  needed**, `contacts.ts:273`; `raw_data` verbatim payload; `content_hash` sha256). The existing
  `uniq_source_imports_ws_content` makes an identical re-sync a no-op. `source_imports` = raw evidence
  (append-per-event); `crm_record_links` = stable external-id bridge (one-per-record) — complementary.
- **Layer-0 stays opt-in:** by default CRM data lands in the Layer-1 overlay only; whether it
  contributes to the Layer-0 master graph is the existing CONTRIBUTE-TO opt-in (OFF by default).

### 4.11 Enum + audit additions (closed CHECK enums, mirrored in `@leadwolf/types`)

These **must land in `0027` before any code writes them** (a closed CHECK rejects unknown values):

- `audit_log.action` (`schema/billing.ts:187-209` + the `@leadwolf/types` mirror, the source of
  truth `billing.ts:186`): add `'crm.connect'`, `'crm.disconnect'`, `'crm.sync'`,
  `'crm.mapping.update'`, `'crm.erase'`. Every sync write audits via `writeAudit` in the same tx —
  **IDs + provider only, never the pushed PII or the token**.
- `platformAuditAction` (`platformAudit.ts:7-29`): add `'crm_integration.enable'`,
  `'crm_budget.set'` (staff-side enablement via `withPlatformTx`, super_admin-gated).
- No change to `source_imports.source_name` (`'salesforce'`/`'hubspot'` already present).

---

## 5. Connectors + OAuth (Salesforce + HubSpot)

### 5.1 The `CrmConnector` interface (the port)

Declared in `packages/core/src/crm/port.ts` (core owns the port, like `EnrichmentProvider`),
implemented in `packages/integrations/src/crm/{salesforce,hubspot}.ts`, exported through
`packages/integrations/src/index.ts`. Transport is injectable (`CrmFetch`, the `FetchJson` analog
`httpProvider.ts:9-12`) so contract tests run on recorded fixtures with **zero live spend**.

```ts
export type CrmProvider = "salesforce" | "hubspot";
export type CrmObjectType = "contact" | "account" | "lead" | "deal";

// Decrypted, SERVER-ONLY bundle — lives encrypted in crm_connections.oauth_token_enc.
export interface CrmTokenBundle {
  accessToken: string; refreshToken?: string;     // refreshToken absent for SFDC JWT-bearer / HubSpot private app
  expiresAt: number;                               // epoch ms; 0 = non-expiring static token
  scopes: string[]; instanceUrl?: string;          // SFDC org host (API base)
  apiBaseUrl?: string; externalAccountId?: string; // HubSpot base / org id (non-secret)
  environment: "production" | "sandbox";
}

export type CrmFetch = (req: { method: "GET"|"POST"|"PATCH"|"DELETE"; url: string;
  headers: Record<string,string>; body?: unknown }) => Promise<{ status: number; headers: Record<string,string>; json: unknown }>;

// Richer than httpProvider's 429/≥400 split (httpProvider.ts:50-52): refresh-retry, daily-cap,
// and do-not-retry classes drive different control flow.
export type CrmOutcome<T> =
  | { kind: "ok"; value: T; limits: CrmLimitSignal }
  | { kind: "rate_limited"; retryAfterMs: number; daily: boolean }  // 429 / REQUEST_LIMIT_EXCEEDED
  | { kind: "auth_expired" }   // 401 / INVALID_SESSION_ID → exactly ONE refresh+retry
  | { kind: "auth_revoked" }   // invalid_grant on refresh → connection.status='error'
  | { kind: "not_found" } | { kind: "validation"; detail: unknown }   // 400/422 — DO NOT retry
  | { kind: "conflict"; detail: unknown }   // 409 / DUPLICATE_VALUE
  | { kind: "transient"; status: number }   // 5xx / network — retry w/ backoff
  | { kind: "permanent"; status: number; detail: unknown };
export interface CrmLimitSignal { retryAfterMs?: number; dailyRemaining?: number; dailyMax?: number; }

export interface CrmConnector {
  readonly provider: CrmProvider;
  readonly configured: boolean;   // false when client id/secret env absent — never throws (providers.ts:4 posture)
  // OAuth (server-side only)
  buildAuthorizeUrl(a: { state: string; codeChallenge: string; redirectUri: string; scopes: string[]; env: "production"|"sandbox" }): string;
  exchangeCode(a: { code: string; codeVerifier: string; redirectUri: string; env: "production"|"sandbox" }, fetch?: CrmFetch): Promise<CrmTokenBundle>;
  refresh(bundle: CrmTokenBundle, fetch?: CrmFetch): Promise<CrmTokenBundle>;  // throws on invalid_grant
  testConnection(bundle: CrmTokenBundle, fetch?: CrmFetch): Promise<CrmOutcome<{ account: string; environment: "production"|"sandbox"; daily?: { used: number; max: number } }>>;
  // Data plane
  pullPage(a: { bundle; object; cursor?: string; pageSize: number }, fetch?: CrmFetch): Promise<CrmOutcome<{ records: unknown[]; nextCursor?: string; highWatermark?: string }>>;
  pullDelta(a: { bundle; object; sinceWatermark: string; pageSize: number }, fetch?: CrmFetch): Promise<CrmOutcome<{ records: unknown[]; highWatermark: string }>>;
  fetchOne(a: { bundle; object; externalId: string }, fetch?: CrmFetch): Promise<CrmOutcome<{ record: unknown | null }>>;
  upsert(a: { bundle; object; externalIdField: string; records: unknown[] }, fetch?: CrmFetch): Promise<CrmOutcome<{ perRecord: Array<{ externalId: string; outcome: "created"|"updated"|"rejected"; detail?: unknown }> }>>;
  eraseOrSuppress(a: { bundle; object; externalId: string; mode: "delete"|"gdpr_delete"|"anonymize" }, fetch?: CrmFetch): Promise<CrmOutcome<void>>;
  // Inbound trust boundary
  verifyWebhook(raw: string, headers: Record<string,string>, secret: string): boolean;
  parseWebhookEnvelope(raw: string): Array<{ object: CrmObjectType; externalId: string; eventId: string; sourceTag: string }>;
  parseLimits(status: number, headers: Record<string,string>, body: unknown): CrmLimitSignal;
}
export function defaultCrmConnectors(): Record<CrmProvider, CrmConnector>; // mirrors defaultProviders() (providers.ts:102)
```

**Per-provider concretions:** SFDC `Authorization: Bearer`, base = `instanceUrl + /services/data/v61.0/`,
sandbox login host `test.salesforce.com` vs prod `login.salesforce.com`, upsert via
`PATCH /sobjects/{Obj}/{ExtIdField}/{value}`, batch via sObject Collections (≤200) / Bulk API 2.0 for
backfill, `getUpdated()`/`getDeleted()` + CDC for change capture. HubSpot `Authorization: Bearer`,
base `api.hubapi.com`, batch upsert `POST /crm/v3/objects/{type}/batch/upsert` with `idProperty`
(≤100), Imports API for backfill, `parseLimits` reads `X-HubSpot-RateLimit-Daily-Remaining`/`Retry-After`.

### 5.2 OAuth connect flow (auth-code + state + PKCE)

All server-side; tenancy from the **verified session JWT, never callback params**.

- **Start** `POST /api/v1/crm/connections` (authed, gated): `withTenantTx` → generate `state` + PKCE
  `code_verifier`/`code_challenge` → insert `crm_oauth_states` (verifier encrypted) → return
  `connector.buildAuthorizeUrl({ state, codeChallenge, redirectUri: env.CRM_OAUTH_REDIRECT_URI, scopes, env })`.
- **Callback** `GET /api/v1/crm/oauth/callback?code&state` (authed router — the user returns to `app.`
  with their session): look up `crm_oauth_states` by `state` → reject if missing/expired/consumed or
  workspace ≠ session workspace → mark consumed (single-use) → `connector.exchangeCode(...)` →
  **SSRF-validate the SFDC-returned `instanceUrl`** (`assertSafeWebhookUrl`, `ssrfGuard.ts:105-145`,
  **plus** a `*.salesforce.com`/`*.force.com` allow-list) → encrypt bundle →
  `crmConnectionRepository.markConnected` (the only `*_enc` write path) → seed `crm_field_mappings`
  defaults → `writeAudit(crm.connect, {provider, externalAccountId})` (no token material). Orchestration
  in `packages/core/src/crm/connectCrm.ts` (clone of `connectMailbox.ts:30-60`).
- **Least-privilege scopes (security-required):** SFDC `api refresh_token offline_access` only
  (never `full`); object rights via a least-privilege **Permission Set** on a dedicated integration
  user. HubSpot `crm.objects.contacts.read/write` + `crm.objects.companies.read/write`
  (+ `crm.schemas.*.read` for mapping). **Validate the granted scope set equals the requested set on
  callback; reject broader.** Pin allowed scopes + redirect URIs in `env.ts`.

### 5.3 Token storage (KMS) + refresh

- **`CrmSecretStore`** (`packages/core/src/crm/crmSecretStore.ts`) — a dedicated clone of
  `email/secretStore.ts:13,22-41`: versioned envelope `version|iv|authTag|ciphertext`, key from a
  **new `CRM_SECRET_KEY`** (KMS-data-key target) with dev fallback to `BLIND_INDEX_KEY`. **Do not
  reuse the email or PII key** — each credential class is its own module/key by design
  (`secrets.ts:1-9`). Stores the **whole bundle** (access+refresh+expiry+scopes+instanceUrl).
- **Repository** (`crmConnectionRepository.ts`, clone of `mailboxRepository.ts`): `safeColumns` omits
  `oauth_token_enc` (`:20-41`); `markConnected` is the only `*_enc` writer (`:82-97`); `markError`
  records failure without touching the credential (`:100-105`); a separate `getDecryptedBundle(tx,id)`
  is the **only** read of `oauth_token_enc`, used exclusively by the worker that calls the CRM.
- **Refresh loop** (`refreshConnection.ts`): triggered when `token_expires_at` is within a skew window
  (~120s) **or** a call returns `auth_expired`. **Connection-level Redis mutex** (the `leaderLock.ts:17`
  `SET … PX NX` + Lua release) so N workers don't each refresh and race-invalidate the refresh token;
  re-read inside the lock (double-check) → `connector.refresh(bundle)` → `markConnected` rotated bundle
  → release (the rotate-don't-reuse posture, `auth/refresh.ts:71-91`). On `invalid_grant`:
  `markError` + `status='error'` + `writeAudit(crm.sync,{result:'revoked'})` + surface a reconnect CTA;
  never log token material. **Prefer SFDC JWT-bearer** for the unattended engine (cert-signed, no
  refresh-token rot); keep web-server auth-code for the interactive admin connect.

### 5.4 Rate-limit handling (three layers — see §8.2)

`testConnection` doubles as the daily-cap probe (SFDC `GET /limits`, HubSpot `GET /account-info/v3/details`).

---

## 6. Field mapping + conflict resolution + dedup + idempotency + loop prevention

Two **new pure planners** in `packages/core/src/crm/planCrmMerge.ts`, reusing `FieldProvenanceMap`/
`FieldProvenanceDescriptor` from `@leadwolf/types`, sitting **alongside** `planFieldWrite` (do not
modify it — enrichment depends on it). The substrate already encodes half the rule: `planFieldWrite`
skips a `pin===true` descriptor (`fieldProvenance.ts:48-52`); the CRM planners add direction,
authority, conf-threshold, LWW tiebreak, and conflict→review.

### 6.1 Inbound merge (CRM → TruePoint) — `planCrmInboundMerge`

For each mapped incoming field `f` (value `v_in`, conf `c_in`, modstamp `t_in`) vs current `v_cur`
with descriptor `d`, given `(dir, master, thr)` from `crm_field_mappings`:

```
1. if dir == 'outbound':                       -> SKIP   # outbound-only field never applied inbound
2. if normalize(v_in) == normalize(v_cur):     -> SKIP   # no-op / echo (loop guard, §6.4)
3. if d.pin == true:                           -> CONFLICT  # human-edited in TP: NEVER clobber
4. # unpinned:
   if master == 'crm':                         -> APPLY    # CRM is system of record for this field
   if master == 'truepoint':
        if v_cur is blank:                      -> APPLY    # fill a gap only
        else:                                   -> SKIP     # TP owns it; CRM may not overwrite
   # master unset -> LWW tiebreak (only among non-authoritative fields, 07-sync:42):
   if t_in > (d.obs ?? d.at ?? -inf):          -> APPLY  else -> SKIP
```

`APPLY` stamps `provenance[f] = {src:"crm:<provider>", mth:"crm", obs:t_in, conf:c_in, pin:false}`
and adds `f` to `writableFields`; the caller persists via `ContactWriteValues.fieldProvenance`
(`contactRepository.ts:66-68,540-570`) inside `withTenantTx`. `CONFLICT` writes a `crm_sync_conflicts`
row and **does not touch the live field** (staging-not-clobber, `07-sync:51-54`).

### 6.2 Outbound push (TruePoint → CRM) — `planCrmOutboundPush`

```
1. if dir == 'inbound':                        -> SKIP   # inbound-only: never push
2. if master == 'crm':                         -> SKIP   # CRM is master; we don't write it
3. if d.src startsWith "crm:<this provider>":  -> SKIP   # value CAME from this CRM: per-field echo guard
4. if (d.conf ?? 1) < thr:                     -> SKIP   # don't pollute the CRM with low-confidence enrichment
5. else:                                       -> PUSH
```

Step 3 is load-bearing: **the `field_provenance.src` label doubles as a loop guard** — a field whose
winning descriptor says `crm:salesforce` is never pushed back to Salesforce. Free, grounded in the
existing `src` convention (`fieldProvenance.ts:13-14`), works even when origin-tagging is unavailable.

### 6.3 Dedup / matching inbound CRM records (resolution ladder, in the inbound worker, `withTenantTx`)

1. **Link fast-path:** `crm_record_links` by `(connection_id, crm_object_type, crm_record_id)` — a hit
   is the bound entity, done (strongest steady-state idempotency).
2. **No link → deterministic match:** compute `email_blind_index = HMAC(normalize(email))` the same
   way the import path does (basis of `uniq_contacts_ws_email`, `contacts.ts:121,187-189`) →
   `contactRepository.findByDedupKeys(tx, workspaceId, {emailBlindIndex, linkedinPublicId, salesNavLeadId})`
   (`:330-376`, batch `:387-456`); accounts on `domain` (`uniq_accounts_ws_domain`, `:83-85`). **Never
   blind-create** (F1).
3. **Match → bind** a `crm_record_links` row (1:1).
4. **No match + policy permits create-in →** `masterGraphRepository.resolveForImport` under `withErTx`
   (`:100-163`, link-or-mint, never keyless, `ON CONFLICT DO NOTHING` + re-SELECT for concurrency) →
   bind the link. **But first run the suppression gate (§6.5).**
5. **Ambiguity** (email→A, linkedin→B; or two CRM records claim one TP contact) → `link_status=
   'ambiguous'` + route to review, **do not auto-merge** (`match_links.review_status` posture).

CRM-side dedup: upsert-by-external-key (SFDC External-Id field / HubSpot `truepoint_id`) = the TP UUID,
recorded in `crm_record_links.external_key` — create-or-update becomes one idempotent call.

### 6.4 Idempotency (layered, durable-first — DB uniques are the real guard, `idempotency.ts:1-3`)

| Layer | Mechanism |
|---|---|
| 1. Native upsert-by-external-key | SFDC `PATCH …/{ExtIdField}/{uuid}` / HubSpot `idProperty` batch upsert — survives our retries |
| 2. `crm_record_links` 1:1 uniques | `(connection_id, crm_object_type, crm_record_id)` AND `(connection_id, contact_id\|account_id)` |
| 3. Content-hash short-circuit | `last_synced_hash = sha256(canonical(mapped fields))`; unchanged → skip the API call (saves quota; echo safety net) — same as `source_imports.content_hash` (`contacts.ts:256`) |
| 4. Queue-level dedupe | deterministic `jobId` (`crm-inbound:{conn}:{eventId}`, `crm-pull:{conn}:{object}`, `crm-push:{conn}:{entity}:{seq}`) — the `register.ts:209,365` discipline |
| 5. Inbound event uniqueness | `crm_inbound_events (connection_id, provider_event_id)` UNIQUE, `onConflictDoNothing` |
| 6. Watermark post-commit + overlap re-scan | advance only after commit; overlap is a no-op via (3) |

### 6.5 Suppression gate (compliance-critical, before any inbound create or outbound push)

`07-sync.md:96,118-119` (F4): only owned/revealed, non-suppressed data may move. Before §6.3 step 4
mints anything **and** before any outbound push, run `assertNotSuppressed`/`findMatch`
(`assertNotSuppressed.ts:12-17`, `suppressionRepository.ts:50-74`) against `suppression_list`. Because
the DSAR tombstone **nulls the contact's own blind index** (`dsarRepository.ts:96`), the check must
match on the **incoming record's** blind index against the surviving **global** suppression row — that
global row is the permanent re-creation wall. A hit on inbound → refuse to create **and** enqueue an
outbound erase (the CRM still holds it).

### 6.6 Loop prevention (defense in depth — F3)

1. **Origin tag (primary):** push under a dedicated integration identity ("TruePoint Sync"); inbound
   CDC carries `ChangeEventHeader.changeOrigin`, HubSpot webhooks carry `sourceId`/`changeSource` —
   **drop events whose source is our integration** (the route filters at ingest; `activities.actor_user_id`
   null = "system (… sync)" already anticipates this, `activity.ts:32`).
2. **Provenance-`src` per-field guard (§6.2 step 3).**
3. **Content-hash short-circuit (§6.4 layer 3).**
4. **Separate inbound/outbound watermarks** (`crm_sync_state`): after an outbound write, advance the
   inbound watermark past the modstamp that write will produce so the reconcile poll doesn't re-ingest
   our own write; overlap the poll window a few minutes (idempotent upserts make overlap harmless).

**Failure-mode coverage:** F1 (duplicate in CRM) → §6.3+§6.4.1; F2 (overwrite human edit) → §6.1
step 3 → review; F3 (ping-pong) → §6.6; F4 (suppressed re-sync) → §6.5; F6 (parallel provenance) →
forbidden, we extend `field_provenance` only.

---

## 7. Security, multi-tenancy & erasure propagation

**Security has final say.** This dimension is conservative: every table fails closed, no token reaches
a DTO, and the DSAR path cannot report `completed` while a CRM linkage survives.

### 7.1 Multi-tenancy & RLS

All nine tables are Layer-1 overlay → `tenant_id`+`workspace_id` (NOT NULL, FK cascade) + `ENABLE`+
`FORCE ROW LEVEL SECURITY` + the workspace-GUC `USING`/`WITH CHECK` policy (`rls/contacts.sql:17-44`);
the `NULLIF(...,'')` makes an unset GUC read **nothing** (fail-closed). The write-wall is **FORCE RLS
+ the policy, NOT the grants** — `applyMigrations` blanket-grants `leadwolf_app` all DML
(`applyMigrations.ts:72`), so isolation comes only from the policy. `crm_sync_runs`, `crm_inbound_events`,
and `crm_sync_dead_letter` are **append-only** (SELECT + INSERT policy only, no UPDATE/DELETE — the
`retention_runs` wall, `rls/retention.sql:18-21`); `crm_sync_runs` additionally gets UPDATE for
in-place progress (status/counts). Tables are **not** named `master_*` and **not** added to the
Layer-0 `REVOKE` list — they correctly take the app grant and rely on FORCE RLS. The DSAR fan-out
reaches `crm_record_links` cross-workspace via `withPrivilegedTx` (BYPASSRLS `leadwolf_admin`,
`client.ts:40-45`); global suppression rows stay platform-managed (`suppressionRepository.list`
excludes `scope='global'`, `:106`).

### 7.2 Per-tenant OAuth-token isolation (KMS) — the hard enable-gate

The `mailbox_integration` discipline (§5.3): dedicated versioned `CrmSecretStore` + separate
`CRM_SECRET_KEY`; `safeColumns` never includes `oauth_token_enc`; single `markConnected` writer;
decrypt only server-side, never logged; refresh mutex. **Today there is no real KMS** — all secret
stores derive `sha256(env)` (`secretStore.ts:16-19`), dev-grade. The versioned-envelope byte is the
forward-compat seam; the actual **KMS CMK-wrap of the DEK is UNBUILT and is the security-owned
prerequisite** before any production CRM token is stored (§11 open decision #2).

### 7.3 Abuse / SSRF / residency

- **Inbound receiver fails closed:** public-before-authed mount (`app.ts:108-110`), read **raw** body,
  HMAC-verify before parse (`webhookRoutes.ts:41-42`), **300s timestamp tolerance + `timingSafeEqual`**
  replay protection (`stripeWebhook.ts:38,46`), unknown→200, idempotent ingest on provider event id,
  app-wide `rateLimit` (`app.ts:70`).
- **SSRF on every customer-influenced URL:** `assertSafeWebhookUrl` (`ssrfGuard.ts:105-145`) at create
  **and** at fire time, applied to the SFDC `instance_url` + a `*.salesforce.com`/`*.force.com`
  allow-list; `redirect:"manual"` on all outbound calls (`dispatch.ts:64`).
- **Residency:** tokens + sync data stay in the tenant's region (`CRM_SECRET_KEY` regional; `env.ts`
  the only secret reader). The compliance gate on what leaves is the **export anti-join** — only
  owned/revealed, non-suppressed fields may be pushed — so an EU subject's PII is never pushed to a
  US-region CRM unless field-policy/consent allows.

### 7.4 Audit

Tenant actions via `writeAudit` in the same tx (the `deleteFanout.ts:37-45` shape) — `crm.connect`/
`crm.disconnect`/`crm.sync`/`crm.mapping.update`/`crm.erase` (§4.11), IDs + provider only. Staff-side
enablement via `withPlatformTx` (`client.ts:121-137`, append-only trail, super_admin-gated) —
`crm_integration.enable`/`crm_budget.set`.

### 7.5 Least-privilege scopes & integration identity

Per §5.2: minimal scopes, granted-equals-requested validation, a dedicated integration identity on
both platforms (required for loop-prevention origin filtering and so the CRM audit shows who wrote).

### 7.6 Erasure propagation OUTWARD (the critical path) — **resolving the cross-dimension conflict**

> **Resolved design decision (security overrides data-model).** The data-model dimension proposed
> adding `crm_record_links` to **both** the DSAR `purgeDependents` and the verification set. The
> security dimension showed that is wrong: purging the link before the outbound erase destroys the
> `external_id` needed to delete the CRM record. **Per the CLAUDE.md precedence rule (security has
> final say on erasure), we adopt the security design:** add `crm_record_links` to `scanResiduals`
> (it **blocks `completed`**) but **NOT** to `purgeDependents`; the outbound erase job deletes the
> link itself after the CRM erase confirms.

Today `deleteFanout` is inward-only (`deleteFanout.ts:1-5`). The extension, reusing every seam:

**A. `crm_record_links` blocks DSAR `completed`.** Add it to `scanResiduals`' dependents count
(`dsarRepository.ts:138-145`) — the job cannot report `completed` while any CRM linkage for an erased
contact survives (exactly how `list_members` was added). The link holds only opaque ids (no subject
PII), so keeping it briefly is safe.

**B. Outbound CRM-erase fan-out (net-new).** After `deleteFanout` returns in the `dsar` worker
(`apps/workers/src/queues/dsar.ts:17-18`), for each erased copy with a `crm_record_links(connection,
crm_record_id)` row, enqueue a per-(workspace, connection) erase job that:
- runs under **`withTenantTx`** per workspace (the token is a per-workspace secret decrypted in the
  overlay scope; avoids relying on `leadwolf_admin` BYPASSRLS Neon may not grant);
- decrypts the token server-side and calls the provider erase: **HubSpot**
  `POST /crm/v3/objects/contacts/gdpr-delete` (permanently deletes + blocks re-add); **Salesforce**
  Bulk `hardDelete` where the perm exists, else **anonymize-the-mapped-fields + Do-Not-Contact** flag
  (no GDPR endpoint on SFDC — full purge is **not** API-guaranteeable — §11 open decision #3);
- is **idempotent** (treat 404/"already deleted" as success), 429-backoff + per-connection budget;
- on confirmed erase, **deletes the `crm_record_links` row** (clears the residual from A) and writes a
  `crm.erase` audit row;
- records per-target outcome (erased vs anonymized + the API response) into `dsar_requests.scope_report`
  as the erasure proof (external targets can't be table-scanned → "recorded proof of the API call +
  the residual-backup caveat");
- on completion, the `dsar` worker re-runs `deleteFanout` (idempotent + re-runnable) → zero
  `crm_record_links` residuals → the verification scan flips the DSAR to `completed`.

**C. Suppression = the permanent re-sync wall (§6.5):** the global suppression row is the only
surviving key after the tombstone nulls the local blind index; the inbound create/upsert path runs
`assertNotSuppressed` on the **incoming** record's blind index before any write → refuse + enqueue
outbound erase. Closes the F4 re-monetization loop.

**D. Inbound CRM-initiated erasure** (HubSpot `contact.privacyDeletion`) flows into the **internal
tombstone path scoped to that one workspace's copy** — it honors the delete inside TruePoint but is
**not** promoted to a platform-wide DSAR (a CRM delete is not a subject-rights request across tenants).

---

## 8. Scale, rate-limits & reliability

### 8.1 What actually breaks at 10x (and it isn't the CRM cap first)

Every `Worker` in `register.ts` is `new Worker(NAME, proc, { connection })` with **no `concurrency`
and no `limiter`** (`register.ts:319-322,382-385`) → concurrency = 1 per queue per process, a single
FIFO with **no fair-share** (one tenant's 500k backfill head-of-line-blocks every other tenant). The
binding scarce resource at 10x (~10,000 connections, ~11 poll-starts/s) is the **worker fleet +
Postgres pool** (each chunk holds two pool conns via the nested `withErTx`, `bulkProcessChunk.ts:36`),
**not** any single CRM's daily cap (per-org, a 500k backfill is a few % of the cap; the problem is
10,000 orgs backfilling at once).

**The four load-bearing inversions of existing defaults** (the only real scale changes):

| # | Default today | Inversion required | Why |
|---|---|---|---|
| a | `budgetGuard` store is process-local in-memory (`budgetGuard.ts:71-101`) | **Redis-backed** store behind the same interface (`:6-8`) | N pods each hold their own counter → N× the cap blown |
| b | `RateLimiterRedis` **fails open** (`rateLimit.ts:54`) | outbound daily-cap guard **fails CLOSED** | a Redis blip must not let the fleet blow a customer's *shared* HubSpot daily cap |
| c | `bulkProcessChunk` collapses failure to **chunk** granularity (`:29`) | **per-record** outcomes | one bad record must not fail/skip the other 99; there is no "fix later" sweep for a CRM write |
| d | workers `concurrency:1`, no `limiter`, no fairness | explicit **`concurrency`** (sized vs `pool.max`) + a **`limiter`** on push + a built **per-connection in-flight fair-share cap** (Lua compare-set, `leaderLock.ts:10-11`) | else the fleet can't reach throughput and a single tenant monopolizes slots |

### 8.2 Per-connection rate budget + backoff (three layers)

1. **Proactive burst bucket** — `RateLimiterRedis` (`rateLimit.ts:22-44` idiom) keyed
   `rl:crm:burst:{connectionId}`, tuned per provider (HubSpot ~19/s, SFDC concurrency guard). **Fails
   open** (brief over-send is recoverable via 429 handling).
2. **Daily-cap budget** — a `CrmBudgetStore` on the `budgetGuard` **reserve-then-spend** shape
   (increment-then-check `:43-55`, refund-on-failure `:57-68`), **Redis-backed**, keyed
   `crm:budget:{connectionId}:{utcDay}`, plus the provider-reported authoritative remaining
   (SFDC `GET /limits`, HubSpot `X-HubSpot-RateLimit-Daily-Remaining`). **Good-neighbor rule:** consume
   ≤ `CRM_DAILY_BUDGET_FRACTION` (default 0.5) of remaining (HubSpot's cap is shared with the
   customer's other apps). **Fails CLOSED** (defer/re-enqueue). Do **not** use `decideAutoEnrich`'s
   non-reserving pre-check (`policy.ts:52-56,84-90`) — slightly-over against a hard
   `REQUEST_LIMIT_EXCEEDED` is an outage.
3. **Reactive 429** — `parseLimits` reads `Retry-After`/`Sforce-Limit-Info` → re-enqueue the job with
   `{ delay }` (the `enqueueOutreach(data, delayMs)` idiom, `register.ts:158-160`). **A 429 is
   backpressure, not failure** — it must not consume a BullMQ `attempt` or hit the DLQ.

### 8.3 Batching, delta efficiency, backfill

- **Backfill** = discriminated `drive`→`page` (clone `bulkImport.ts:65-74` + `bulkProcessChunk`),
  low BullMQ `priority`, in-flight-bounded so it never starves real-time work; idempotent + resumable
  (commit merge + cursor + status in one `withTenantTx`; a `completed` page is skipped on retry).
  SFDC Bulk API 2.0 / HubSpot Imports for pull; **never row-at-a-time** for push.
- **Incremental** = per-`(connection,object,direction)` watermark + overlap re-scan; **content-hash
  short-circuit** collapses N field-changes in a window to ≤1 upsert (the single biggest API saver);
  webhooks/CDC carry most change for free, polling is the correctness backstop.

### 8.4 Retries, DLQ, partial-failure

- Retries at enqueue: pull/inbound/push `{ attempts:3, backoff: exponential 60_000 }`
  (`register.ts:199`); backfill `{ attempts:4, backoff: exponential 30_000 }` (`register.ts:256`).
  API-side producers set `removeOnComplete:{age:24*3600,count:1000}`, `removeOnFail:false`
  (`bulkQueue.ts:28-35`).
- **DLQ only after retries exhausted, PII-free** (`deadLetterFailedImport`, `imports.ts:75-95`); wired
  on `worker.on("failed")` (`register.ts:282-288`). A **permanent** error (validation, scope 403,
  transform reject) fails fast to DLQ via a non-retryable error subclass (don't waste the retry
  budget); a 429 is re-enqueued with delay and is not an attempt.
- **Partial failure is per-record:** SFDC sObject-Collections / HubSpot batch return a per-record
  success/error array → map each to a `crm_sync_runs` counter + (on reject) a `crm_sync_dead_letter`
  row; the job throws (→ retry) **only** when the whole call failed transiently (the `ImportFailedError`
  "0 landed" rule, `imports.ts:63-66`).

### 8.5 Backpressure

Bounded fan-out per sweep tick (`MAX_CONNECTIONS_PER_SWEEP`, the `reverificationSweep.ts:22` cap,
re-pick stragglers next tick); budget-exhausted → `connection.status='paused'` and **stop enqueuing**
(don't enqueue jobs that will all 429), resume at UTC-day reset or `Retry-After`; degrade to widened
poll interval near the cap; queue-health probe (`getJobCounts`+`getWorkers`, 1.5s timeout) for the
staff surface.

### 8.6 Metered cost (FinOps)

A `crm_api_calls` ledger could be added (clone of `provider_calls`, `intel.ts:88-114`) — **but the
`crm_sync_runs.api_calls` counter already captures per-run consumption** for the v1 FinOps surface;
recommend deferring the separate per-call ledger until per-call attribution is actually needed (avoid
a high-write hot table on day one). Per-connection caps live in a `provider_configs`-style config
(`intel.ts:120-127`), platform/owner-writable only. The `costMicros` field already flows through the
provider port (`httpProvider.ts:59`) — the CRM adapter stamps `costMicrosPerCall` per op and the
budget guard debits it.

---

## 9. Observability & ops

Posture: **honest signals, never fabricate green, never log PII/payloads** (`systemHealthProbes.ts:6-8`;
`instrument()` never logs payloads, `register.ts:263`). The **DB ledger is the metric store**; the
**JSON-line log is the alert**; a **leader-locked tick is the alert engine** (no metrics/OTel/paging
backend exists — that is a separate platform decision).

### 9.1 Metric store & traces

`crm_sync_runs` (§4.6) is the durable counter store, aggregated by repositories like
`recentReverificationRuns` / `recentHealthByProvider` (`providerConfigs.ts:56-60`). Health is a **pure
function** `deriveSyncHealth(counts, lastSuccessAt, now, status) → healthy|degraded|down|unknown`
(mirrors `deriveProviderHealth` `:35-42`; `unknown` when there's no activity — never a fake green).
**Trace = a `sync_run_id` correlation id** threaded through the job payload → every `instrument`/`log`
line → `crm_sync_runs.sync_run_id` → `crm_inbound_events`/`crm_sync_dead_letter`, so an operator can
grep one run end-to-end (a real tracer is out of scope).

### 9.2 Customer surface (`apps/web/src/features/crm-sync/`)

A near-clone of `DataHealthPage.tsx` (PageHeader + Tabs + SectionCard + State Kit, no new primitives),
one nav entry (`navConfig.ts:16-24`). Tabs: **Overview** (per-connection status tiles: state, last
successful sync per object/direction, records in/out 24h+lifetime, errors, **drift** = unsynced-hash
mismatch + open conflicts, rate-budget remaining; `status='error'` → red badge + Reconnect CTA);
**Sync activity** (`crm_sync_runs` as StatTiles + DataTable, the `ReverificationActivity.tsx` clone);
**Conflicts & errors** (`crm_sync_conflicts` + DLQ filtered, with a "Retry failed" action). API mirrors
`/home/data-quality*` exactly: `GET /api/v1/integrations/:connectionId/sync-health|sync-runs|sync-events`
(RLS-scoped, short private cache) + `POST …/sync/retry` (202, owner/admin + `rateLimit`, typed
`rate_limited`/`forbidden`).

### 9.3 Staff surface (`apps/admin`)

Extend System health: the inbound/outbound queues + a Sync-DLQ tile appear automatically once
registered in `probeQueues`' `SPECS` (`systemHealthProbes.ts:54-58`) via copies of
`reverificationQueueHealth` (`bulkQueue.ts:51-87`). New **CRM-sync monitor** (clone of
`ImportsMonitorPage.tsx`): cross-tenant DataTable of recent `crm_sync_runs` joined to tenant name with
`failed_reason` inline; `GET /admin/crm-sync-runs` as a bounded `withPlatformTx` read,
`requireStaffRole("super_admin","support","read_only")`. Per-connection passive health via
`recentSyncHealthByConnection` (the `recentHealthByProvider` clone, 24h window).

### 9.4 Alerting (net-new, leader-locked tick)

A repeatable `crm-sync-alert-tick` (60s, under `withLeaderLock`) evaluates per active connection:
**sync failure** (latest run `failed`, or ≥N consecutive, or `status='error'`) → `log.error
("crm_sync.alert.failure", …)`; **lag** (`now − last_success > threshold`) → `log.warn`;
**rate-exhaustion** (`rate_limited_ct/liveCalls ≥ 0.2` — the `deriveProviderHealth` degraded
threshold, `providerConfigs.ts:40` — or `rate_limit_remaining < budgetFraction`) → `log.warn`;
**DLQ non-empty** → `log.error` + the red attention tile. The structured log line is the alert (a
shipper/pager consumes `level:error`, `msg:crm_sync.alert.*`); the DB write is the UI signal. The eval
function is pure and unit-tested. `useSyncHealth` gets a 30–60s interval refresh (the `useSystemHealth`
reload is one-shot today).

### 9.5 DLQ + replay tool

Dead-letter via `deadLetterFailedImport` (PII-free, only after retries exhausted, `imports.ts:81-94`),
each entry also a `crm_sync_dead_letter` row. **Staff replay** `POST /admin/crm-sync/dlq/:id/replay`
(clone of `replayDelivery` + `webhooks/routes.ts:58-74`, `withPlatformTx`, audited) re-enqueues onto
the live queue — safe because the write path is upsert-by-external-key + content-hash idempotent (a
replay re-fetches and cannot duplicate). **Customer self-serve** = the "Retry failed" action (§9.2).

### 9.6 Runbooks (signal → diagnosis → existing control)

- **R1 CRM outage** (provider 5xx, multi-tenant): let backoff self-heal; if prolonged, pause globally
  via the `CRM_SYNC_ENABLED` env kill-switch; replay the DLQ on recovery; the reconcile poll re-derives
  state from the watermark (no data loss).
- **R2 Revoked token** (one tenant, 401/`INVALID_SESSION_ID`, `status='error'`): surface the Reconnect
  CTA; sync auto-resumes on reconnect; replay the DLQ; never blind-retry (can lock the account).
- **R3 Rate lockout** (`REQUEST_LIMIT_EXCEEDED`/429): engine respects `Retry-After` automatically; if
  still exhausted, widen the poll interval / drop to polling-only and pause that one tenant via the
  per-tenant flag (the `POST /admin/tenants/:id/auth-enforcement` break-glass shape, `admin/routes.ts:130-147`);
  the ≤50% default makes this rare.
- **R4 Bad mapping** (writes succeed but wrong; conflicts spike; runs `completed` so no failure alert —
  why drift + conflict counts are first-class on Overview): pause the connection, correct the mapping,
  replay the affected `sync_run_id` range; idempotent upsert + content-hash converge without duplicating;
  human-pinned fields are never clobbered.

---

## 10. Rollout & phasing

### 10.1 The gating model (four layers — reuse, don't invent)

| Layer | Mechanism | Default | Evidence |
|---|---|---|---|
| **L1 global env kill-switch** | `CRM_SYNC_ENABLED` (`z.string().optional().transform(v=>v==="true")`) — only `"true"` enables; off → routes/queues not even constructed | off | `env.ts:166-169` |
| **L2 per-tenant flag** | `crm_sync_enabled`, `isFlagEnabledForTenant` outermost gate; unknown = OFF | off | `evaluateFlag.ts:25-41`; seed `0026_seed_rollout_flags.sql` |
| **L3 per-connection mode** | `crm_connections.sync_mode` `shadow`(diff-only, zero outbound HTTP)→`enforce` | `shadow` | `0025_retention_engine.sql:4-7`; `runRetentionSweep.ts:111-116` |
| **L4 per-field direction** | `crm_field_mappings.direction` — a field with no mapping never moves | enrich-in | — |

This is the **strongest posture in the repo** (more than bulk-import or retention alone) because CRM
sync both writes PII to a third party **and** can re-create an erased subject.

### 10.2 Phases

- **Phase 0 — Inert scaffolding (100% DARK).** Land `0027_crm_sync.sql` (nine tables + RLS via
  `rls/crm.sql` + the closed-enum additions §4.11) and `0028_seed_crm_flags.sql`; the `CRM_SYNC_ENABLED`
  env + `CRM_SECRET_KEY` + flag key in `@leadwolf/types`. No routes mounted, no queues registered.
  **Enable-gate to advance:** schema/RLS isolation itest green; security sign-off on table/RLS shapes.
  (Enum additions must precede any code that writes them — a migration can't follow its dependent code.)
- **Phase 1 — MVP: one-way OUTBOUND push to HubSpot, shadow-first.** OAuth connect + `CrmSecretStore`
  + HubSpot adapter + `crm-sync-push` + leader-locked reconcile sweep producing the **would-push diff**
  + idempotent upsert-by-`truepoint_id` + per-connection rate budget + suppression gate. Mounted behind
  L1+L2 OFF; even a flipped-on pilot defaults `sync_mode='shadow'` (diffs logged, nothing pushed).
  **Enable-gate to `enforce`:** (1) **real KMS envelope-wrap** (the hard security blocker); (2) OAuth
  app review (HubSpot marketplace or private-app for single-tenant pilots); (3) metered-cost controls
  (Redis token bucket + good-neighbor fraction + `429`/`Retry-After`).
- **Phase 2 — Inbound capture + Salesforce.** Inbound HMAC webhook receiver + `crm-sync-inbound` +
  the reconcile poll on `SystemModstamp`/`hs_lastmodifieddate` (correctness layer) + the SFDC adapter
  (web-server connect, prefer JWT-bearer unattended). Inbound writes go through `field_provenance` so a
  pinned human edit is never clobbered. Still **no true bidirectional** — each field is in- or out-only
  (`bidirectional` rejected at validation). **Enable-gate:** SFDC security review (AppExchange if
  distributing) + inbound-signature itest + reconcile-vs-webhook idempotency proven.
- **Phase 3 — Bidirectional + conflict resolution.** Enable `direction='bidirectional'`; per-field
  authority; loop prevention (origin-tag + `last_synced_hash`); conflicts → `crm_sync_conflicts`.
  **Enable-gate:** the bidirectional sync-engine itest (loop-prevention + conflict + provenance) +
  a "who won and why" explainability surface.
- **Phase 4 — Erasure propagation + GA.** Extend the DSAR fan-out (§7.6); add `crm_record_links` to
  `scanResiduals` (not `purgeDependents`); confirm suppression blocks re-creation; consume
  `contact.privacyDeletion` inbound. **GA =** set the flag `global_enabled=true`, flip the connection
  default `shadow→enforce`, **keep `CRM_SYNC_ENABLED` as the permanent emergency global-off**.
  **Enable-gate:** erasure itest green + full security review of the GA surface + FinOps sign-off.

### 10.3 Migration ordering

Verified apply order (`applyMigrations.ts:163-181`): bootstrap roles → numbered drizzle migrations →
`rls/*.sql` sorted alphabetically (idempotent, re-run each migrate) → GRANTS block (idempotent).
Journal's last entry is `0026` → **`0027_crm_sync.sql`** (tables + enum extensions; enum values must
be here, before dependent code), **`0028_seed_crm_flags.sql`** (`INSERT … global_enabled=false,
"default"=false … ON CONFLICT (key) DO NOTHING`, the `0026` template), **`rls/crm.sql`**
(auto-applied, no journal entry). CRM tables take the blanket `leadwolf_app` grant and are **NOT** in
the Layer-0 `REVOKE` list. No back-fill needed (opt-in/empty at install; flag default-OFF).

### 10.4 Test strategy (model: `packages/db/test/retention.itest.ts`)

- **RLS itest (`crm.itest.ts`):** tenant A's CRM rows invisible to B under `withTenantTx`;
  `oauth_token_enc` never in a read projection; `crm_sync_runs`/`crm_inbound_events`/
  `crm_sync_dead_letter` append-only (UPDATE/DELETE → 0 rows).
- **Gate-state itest:** L1 OFF → routes/queues inert; L2 OFF → nothing read/recorded; L2 ON + L3
  `shadow` → a `crm_sync_runs` diff row, **zero outbound calls** (injectable `CrmFetch` asserted never
  invoked); L3 `enforce` → exactly-once idempotent upsert; tenant isolation of enforce.
- **Sync-engine itest (P3):** echo of our own write is a `last_synced_hash` no-op; conflict honors
  `field_provenance` pins; bidirectional LWW per field-authority; SFDC Lead→Contact re-points the link.
- **Erasure itest (P4):** a DSAR with a `crm_record_links` row cannot reach `completed` until the
  linkage is purged; a suppressed subject's inbound webhook does not re-create the record.
- **Connector contract tests:** per-CRM against **recorded sandbox fixtures** with injectable
  `CrmFetch` (zero live spend) — request shape (upsert-by-external-key, batch sizes), `429`/`Retry-After`
  → `rate_limited`, OAuth refresh-and-retry on 401. A thin **live-sandbox smoke** runs only in the
  enable-gate CI step per CRM.
- **CI note (from memory):** this sandbox has no `bun`/`docker`/`gh` → bun-test/biome/typecheck/itests
  are the user's CI step; the design above is the test contract to run there.

### 10.5 New constants

`packages/types/src/crm.ts` → `CRM_SYNC_FLAG_KEY = "crm_sync_enabled"`; the provider/status/sync_mode/
direction/authority/object_type/error_class Zod enums; the `'crm:salesforce'`/`'crm:hubspot'` `src`
consts. `packages/config/src/env.ts` → `CRM_SYNC_ENABLED`, `CRM_SECRET_KEY` (min 16, dev→`BLIND_INDEX_KEY`),
`SALESFORCE_CLIENT_ID/SECRET`, `HUBSPOT_CLIENT_ID/SECRET`, `CRM_OAUTH_REDIRECT_URI`,
`CRM_DAILY_BUDGET_FRACTION` (default 0.5) — all optional so boot/build never breaks (absent → connector
`configured=false`).

---

## 11. Risks + open decisions that need a human

**Recommendations are given; the decision is the human's.**

1. **Custom connectors vs `Merge.dev` unified API (business/cost + build-time).** *Recommend:* build
   **custom adapters for Salesforce + HubSpot** (the two that drive 80%+ of demand) — deepest control,
   no per-record middleman fee, and the golden-master-graph + provenance match substrate is the
   differentiator a unified API can't expose; consider **Merge.dev as the fast-follow for the long
   tail** (Pipedrive/Close/etc.). *Risk if wrong:* custom = more build + maintenance per CRM. (Flagged
   in `05-features-modules.md:306-313`, `09 §11 Q5`.)
2. **KMS is unbuilt — security/legal hard gate.** Token-at-rest is `sha256(env)` dev-grade today
   (`secretStore.ts:16-19`). *Recommend:* a real **CMK-wrapped DEK** (AWS/GCP KMS) behind the existing
   versioned envelope is a **prerequisite to flipping any connection to `enforce` in prod**. Storing
   live customer OAuth tokens without it is not acceptable for GA. **Needs security sign-off + funding.**
3. **Salesforce erasure cannot guarantee full purge via API — legal/DPO sign-off.** SFDC has no
   GDPR-delete endpoint; `hardDelete` is permission-gated and backups/Field-History may retain copies.
   *Recommend:* the **"erase where supported (HubSpot gdpr-delete / SFDC hardDelete), anonymize +
   Do-Not-Contact where not, and prove which happened in `dsar_requests.scope_report`"** posture —
   with an honest customer-facing disclosure of erased-vs-anonymized. **Needs DPO/legal sign-off** that
   this satisfies the erasure obligation.

**Secondary open questions (recommend, but confirm at build):**
- HubSpot inbound **public-app webhooks vs private-app poll** per customer install (changes whether
  `crm-sync-inbound` or `crm-sync-pull` is primary for that connection) — support both; pick per install.
- SFDC **JWT-bearer vs web-server refresh** for the unattended engine — recommend JWT-bearer
  unattended, web-server for interactive connect.
- **Range-partition** `crm_record_links`/`crm_sync_runs`/`crm_inbound_events` from day one? — *Recommend
  defer* (the deferred-partitioning note every high-volume table already carries, `email.ts:130-132`),
  revisit at the first connection > ~1M linked records.
- A separate `crm_api_calls` per-call ledger vs the `crm_sync_runs.api_calls` counter — *Recommend* the
  counter for v1; add the ledger only when per-call attribution is needed (§8.6).
- DSAR outbound-erase **blocking `completed` synchronously** (the §7.6 residual-gate) vs best-effort —
  *Recommend* synchronous-blocking (rejected the weaker option: it would let a CRM copy survive an
  erasure marked done).

**Cross-dimension contradictions resolved in this plan** (so the team has one source of truth): (a)
table names standardized (§4.0); (b) `crm_record_links` added to `scanResiduals` **not**
`purgeDependents` — security overrides data-model (§7.6); (c) `crm_sync_events` (conflict-dim) =
`crm_inbound_events` (idempotency firehose) vs `crm_sync_conflicts` (review) vs `crm_sync_dead_letter`
(errors) — three distinct tables (§4.0); (d) the daily-cap guard **fails closed** while the burst
limiter **fails open** — intentional inversion of the auth limiter's default (§8.2).

---

## 12. Phase-1 build checklist (the first shippable slice)

**Slice:** *Connect HubSpot via OAuth; one-way OUTBOUND push of contacts/accounts, shadow-first, dark
behind L1+L2, suppression-gated, idempotent, observable.* Nothing leaves a tenant until an operator
flips a connection to `enforce` on a flag-enabled tenant with KMS in place. Ships DARK.

**DB / types (Phase-0 prerequisite, lands first):**
- [ ] `packages/db/src/schema/crm.ts` — the nine tables (§4), local column idioms, register in `schema/index.ts`.
- [ ] `packages/db/src/migrations/0027_crm_sync.sql` — tables + `audit_log.action` (`crm.*`) +
      `platformAuditAction` (`crm_integration.enable`,`crm_budget.set`) CHECK extensions; `--> statement-breakpoint`; add `meta/_journal` entry.
- [ ] `packages/db/src/rls/crm.sql` — `ENABLE`+`FORCE` + workspace policy for all nine; append-only
      (SELECT+INSERT) for `crm_sync_runs`(+UPDATE)/`crm_inbound_events`/`crm_sync_dead_letter`; `set_updated_at` triggers; `GRANT … TO leadwolf_app`.
- [ ] `packages/db/src/migrations/0028_seed_crm_flags.sql` — seed `crm_sync_enabled` (`global_enabled=false,default=false`, `ON CONFLICT DO NOTHING`).
- [ ] `packages/types/src/crm.ts` — queue-name consts, `CRM_SYNC_FLAG_KEY`, Zod payload schemas
      (sweep/backfill drive+page/pull/inbound/push), DLQ DTO, status/health enums, enum mirrors, `src` consts; mirror the new `auditAction` values in `@leadwolf/types/billing.ts`.
- [ ] `packages/config/src/env.ts` — `CRM_SYNC_ENABLED`, `CRM_SECRET_KEY`, `HUBSPOT_CLIENT_ID/SECRET`,
      `CRM_OAUTH_REDIRECT_URI`, `CRM_DAILY_BUDGET_FRACTION` (all optional).

**Core (pure / IO-free + injected adapters):**
- [ ] `packages/core/src/crm/port.ts` — `CrmConnector` + `CrmTokenBundle` + `CrmOutcome` (§5.1).
- [ ] `packages/core/src/crm/crmSecretStore.ts` — versioned envelope, `CRM_SECRET_KEY` (§5.3).
- [ ] `packages/core/src/crm/connectCrm.ts` — connect orchestration (clone `connectMailbox.ts`).
- [ ] `packages/core/src/crm/refreshConnection.ts` — refresh + connection-level Redis mutex (§5.3).
- [ ] `packages/core/src/crm/planCrmMerge.ts` — `planCrmOutboundPush` (Phase 1) + `planCrmInboundMerge` (stub for Phase 2) (§6).
- [ ] `packages/core/src/crm/runCrmPush.ts` — read TP record → suppression gate → outbound plan →
      content-hash short-circuit → reserve budget (fail-closed) → connector.upsert (or shadow-diff) → link/watermark/audit/run-counts.

**Integrations (adapter):**
- [ ] `packages/integrations/src/crm/hubspot.ts` + `defaultConnectors.ts`, exported via `index.ts` —
      injectable `CrmFetch`, batch upsert ≤100 by `idProperty`, `parseLimits`, `verifyWebhook` (HubSpot v3 HMAC).

**DB repositories:**
- [ ] `crmConnectionRepository.ts` (`safeColumns` omits `oauth_token_enc`; `markConnected`/`markError`/`getDecryptedBundle`), `crmRecordLinkRepository.ts`, `crmFieldMappingRepository.ts`, `crmSyncStateRepository.ts`, `crmSyncRunRepository.ts`, `crmSyncDeadLetterRepository.ts` — all tx-aware, RLS-scoped, `onConflictDoNothing` on idempotent inserts.

**Budget / rate:**
- [ ] `CrmBudgetStore` (Redis-backed, fail-closed daily cap) + a `RateLimiterRedis` burst bucket keyed `connectionId` (§8.2).

**API (`apps/api/src/features/crm/`):**
- [ ] `routes.ts` — `POST /crm/connections` (start), `GET /crm/oauth/callback` (authed; `state`+PKCE
      validate, scope-equals-requested, SSRF-validate any returned host), `POST /crm/connections/:id/test`, `DELETE /crm/connections/:id`; all behind L1 env + L2 flag (`bulkRoutes.ts:45-58` LAYER-1 middleware shape).
- [ ] `crmPushQueue.ts` — lazy-singleton producer + `getJobCounts`/`getWorkers` health probe (`bulkQueue.ts:53`); register in `systemHealthProbes` `SPECS`.

**Workers (`apps/workers`):**
- [ ] register `crm-sync-push` (+ `crm-sync-sweep` reconcile producing the shadow diff) with explicit
      `concurrency` + a `limiter`; wire `deadLetterFailedImport`-style DLQ routing; extend `instrument()` fields with `connectionId/provider/object/direction/syncRunId/counts`; inject `defaultCrmConnectors()`; all behind the `CRM_SYNC_ENABLED` construction gate (`register.ts:422` pattern).

**Frontend (minimal, can trail the backend):**
- [ ] `apps/web/src/features/crm-sync/` — connect/disconnect + Overview tiles + Sync activity (DataHealthPage clone) + one nav entry; `useSyncHealth` with interval polling.

**Tests (the CI contract):**
- [ ] `crm.itest.ts` — RLS isolation + `oauth_token_enc` never projected + append-only walls + gate-state
      (L1/L2 OFF inert; L3 shadow → diff row, zero `CrmFetch` calls; enforce → exactly-once idempotent upsert; tenant isolation).
- [ ] HubSpot connector contract tests on recorded fixtures (request shape, `429`/`Retry-After`, refresh-on-401) — zero live spend.

**Phase-1 enable-gate (before any connection → `enforce` in prod):** real KMS envelope-wrap of the DEK
(open decision #2); HubSpot OAuth app review; Redis-backed fail-closed budget + good-neighbor fraction
proven; the `crm.itest.ts` + connector contract tests green in the user's CI.
