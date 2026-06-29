# 01 — Current-State Analysis

> **Series:** [Database Management — Control Panel & Upload Workflows](./README.md) · **Type:** Analysis
> (code-grounded) · **Status:** Authoritative as of `feat/data-mgmt-01-research-brief` (2026-06-29).
> **Next:** [`02-Enterprise-Research`](./02-Enterprise-Research.md) → [`03-Gap-Analysis`](./03-Gap-Analysis.md).

Status badges: ✅ Shipped · 🌒 Dark (built, flag-off) · 💤 Inert (built, shadow/no-op) · 🟡 Partial ·
🔲 Planned · ❌ Missing. See the [legend](./README.md#status-legend-used-throughout).

---

## 1. Objective

Establish, with `file:line` precision, **what TruePoint can actually do with its data today** — across
ingestion, validation, deduplication, enrichment, verification, search, quality, retention, compliance,
monitoring, audit, and access control — and **how much of it is reachable from an operator's screen versus
buried in code that runs dark or inert behind flags**.

This document is the factual baseline for the whole series. The gap analysis (`03`) and roadmap (`14`)
both index back to the status table here. Where a capability exists but is *not* operable from a UI, that
is the single most important fact for a "control panel" plan, and it is called out explicitly.

The headline finding: **TruePoint has a remarkably complete data *platform* and an almost entirely absent
data *control surface*.** Most of the hard machinery (a two-layer entity-resolved data model, a COPY-staging
bulk pipeline, an enrichment waterfall, a verification subsystem, a shadow-mode retention engine, immutable
audit) is already built — but it is either dark behind flags, inert in shadow mode, or only observable
through three narrow read-only admin screens. There is **no place an operator can validate, dedup/merge,
enrich, approve, or remediate data**.

---

## 2. Method & scope

Grounded in a full read of `apps/admin`, `apps/api`, `apps/workers`, `packages/db`, `packages/core`,
`packages/types`, and the `docs/planning/*` corpus on the current branch. Citations are `path:line` at the
time of writing; the branch's migrations are numbered **`0029–0034`** (renumbered from `0021–0026` when the
feature branch merged `main` — see [§9](#9-the-existing-planning-corpus-orientation-only)). Both **surfaces**
(internal staff console / customer self-service — see [README](./README.md#the-two-surface-model)) are in
scope.

---

## 3. The two-surface reality (where an operator stands today)

### 3.1 Internal staff console — `apps/admin` ✅ (thin shell, narrow data coverage)

`apps/admin` (`@leadwolf/admin`, Next 15 App Router, port 3003) is the internal "Platform admin" console.
It is deliberately **thin**: it holds no DB access and almost no logic — every cross-tenant read/write goes
through `apps/api`'s `/api/v1/admin/*` surface, which is the real authority. Its navigation is a single
source of truth, `apps/admin/src/components/shell/navConfig.ts:32`, whose 14 destinations are: Tenants,
Users, Billing, Plans, Pricing, Providers, Feature flags, Content, Retention, Staff, Compliance, Audit log,
**Bulk imports**, System health.

**There is no "Data management" destination.** The data-relevant screens that exist are narrow and mostly
read-only:

| Admin screen | File | What it does | Read/Write |
|---|---|---|---|
| Bulk imports monitor | `apps/admin/src/features/imports/*` | Cross-tenant feed of recent import jobs — tenant, file, status, AV-scan status, row tallies, failure reason. **Metadata only, never row contents.** | Read-only |
| Retention | `apps/admin/src/features/retention/*` | Tabs: Policies (per-class TTL + mode) and Runs (shadow-sweep evidence). | Read + policy write (super-admin, audited) |
| Compliance | `apps/admin/src/features/compliance/*` | DSAR queue, global suppression/blocklist, compliance-authored retention list. | Read + write (`compliance:*`) |
| Providers | `apps/admin/src/features/provider-configs/*` | Enrichment-provider control: enable/disable, masked key, rate limit, monthly budget + MTD spend, coarse health. | Read + write (`providers:manage`) |
| System health | `apps/admin/src/features/system-health/*` | Service up/down + **live BullMQ queue depth / DLQ / worker counts** + import-job status tally. | Read-only |
| Audit log | `apps/admin/src/features/audit-log/*` | Cross-tenant platform audit viewer, keyset + filters + CSV export. | Read-only |

The feature-folder pattern every new area must follow: `src/features/<area>/` with `index.ts` (barrel),
`api.ts` (the **only** network seam — typed `fetchWithAuth` → `/api/v1/admin/*`), `types.ts` (presentation
mirrors of `@leadwolf/types` shapes), `hooks/use*.ts` (**hand-rolled `useState`/`useEffect`, no TanStack**),
`components/*Page.tsx` (UI from `@leadwolf/ui`: `StateSwitch`, `DataTable`, `Dialog`, `Tabs`, `useToast`;
tokens `var(--tp-*)`). Canonical templates: `features/imports/*` (read-only), `features/retention/*`
(read+write+tabs), `features/tenants/components/TenantActions.tsx` (mutation+dialog+toast+JIT-elevation).

### 3.2 Customer self-service — `apps/web` ✅ (one live surface: Data Health)

`apps/web` has **no admin sections**. Its one data-management-adjacent surface is the **Data Health
dashboard** (`apps/web/src/features/data-health/*`) — shipped and **live** (not dark): per-field fill,
freshness trend, verification breakdown, reverification/retention activity, and a "Reverify now" action.
It reads `GET /home/data-quality`, `/history`, `/reverification-runs`, and `POST /reverify` from
`apps/api/src/features/home/routes.ts`. The customer's own **import wizard** lives at
`apps/web/src/features/import/*` (`ImportWizard`, `BulkImportProgress`) — the customer-facing entry to the
import pipeline below.

> **Implication for the control panel.** The "Database Management team control panel" is essentially
> **greenfield as a *surface*** even though the *subsystems* it would govern mostly exist. Surface 1 needs a
> new `apps/admin` "Data management" area; Surface 2 extends the existing `apps/web` Data Health surface.

---

## 4. The two-layer data model (what we are managing)

TruePoint's dataset is **two layers**, and a control panel must respect the boundary:

- **Layer-1 "overlay" — per-workspace, RLS-scoped.** What a customer owns and sees: `contacts`,
  `accounts`, `source_imports`, `lists`, `list_members`, `activities`. Every row carries `tenant_id` +
  `workspace_id`; isolation is enforced by Postgres RLS via `withTenantTx`
  (`packages/db/src/client.ts:74`).
- **Layer-0 "master graph" — system-owned, NOT RLS-scoped.** The golden/canonical universe:
  `master_companies`, `master_persons`, `master_employment`, `master_emails`, `master_phones`,
  `source_records`, `match_links` (`packages/db/src/schema/masterGraph.ts`). Isolation is **structural**
  (by DB role / access path via `withErTx` `client.ts:56`), not by predicate. An overlay row bridges up via
  `contacts.master_person_id` / `accounts.master_company_id`.

Key columns a control panel leans on (`packages/db/src/schema/contacts.ts`): ownership `tenant_id`,
`workspace_id`, `owner_user_id`, `revealed_by_user_id`; identity/dedup `account_id`, `master_person_id`,
`email_blind_index` (HMAC, per-workspace unique), `linkedin_public_id`, `duplicate_of_contact_id` (the
canonical survivor set by the dedup worker); PII `email_enc`/`phone_enc` (AES-GCM), `phone_line_type`;
quality `email_status`/`phone_status` (`unverified|valid|risky|invalid|catch_all|unknown`),
`last_verified_at` (freshness clock), `priority_score`, `field_provenance` (jsonb per-field source/confidence
winner-map); lifecycle `deleted_at` (DSAR tombstone). `accounts` mirrors this with firmographics +
`icp_fit_score`. The canonical **company↔person** edge is at Layer-0: `master_employment` (SCD2, `is_current`/
`is_primary`, `confidence`, `started_on`/`ended_on`).

> **No generic record version-history / temporal table exists.** The closest primitives are the append-only
> `audit_log`, the `field_provenance` jsonb (per-field source, not value history), `source_imports`/
> `source_records` (immutable ingest evidence), and `master_employment` SCD2 validity. A "version history /
> rollback" control-panel feature builds on these, not on a versions table. (Gap — see `03`.)

---

## 5. Subsystem-by-subsystem current state

Each subsystem below names its **status**, **gate**, **key paths**, and **what's operable from a screen**.

### 5.1 Ingestion & uploads

- **Standard import** ✅ — multipart upload + column mapping + preview. `POST /api/v1/imports/`,
  `/imports/preview`, `GET /imports/:jobId`, mapping templates (`apps/api/src/features/import/routes.ts`);
  `imports` BullMQ queue (`apps/workers/src/queues/imports.ts`, `enqueueImport`); core spine
  `packages/core/src/import/runImport.ts`. On completion, `apps/workers/src/register.ts` fans out
  `enqueueDedup` + `enqueueFirmographics` + `enqueueMasterBackfill`.
- **Bulk import (COPY-staging)** 🌒 **Dark** — fully built, double-gated **off**: env
  `BULK_IMPORT_ENABLED` (default false, `packages/config/src/env.ts:174`) **and** per-tenant
  `bulk_import_enabled` flag (default false). Pipeline: `apps/api/src/features/import/bulkRoutes.ts`,
  `apps/workers/src/queues/bulkImports.ts` (only constructed when env on), core
  `packages/core/src/import/{streamParse,bulkStage,bulkProcessChunk,runBulkImport}.ts`, tables
  `import_jobs`/`import_job_chunks`/`import_job_rows` (`packages/db/src/schema/importJobs.ts`,
  `migrations/0032_bulk_import_jobs.sql`). **Two blockers to enabling:** the `COPY FROM STDIN` fast-load path
  (`copyRows`) is **unverified** (needs a Bun+Postgres spike), and there is **no production object store** —
  only a dev disk `FileStore` (`BULK_IMPORT_STORAGE_DIR`, `env.ts:181`). Design of record:
  `docs/planning/data-management/15-bulk-import-design.md`.
- **Operable from a screen?** Customers: yes (`apps/web` `ImportWizard`). Staff: **monitor only** — the
  admin imports screen shows tallies, never lets an operator *drive* an import, retry a chunk, or inspect a
  rejected row. (Gap.)

`import_jobs` already models a rich state machine — `status`
(`queued|validating|staged|running|paused|completed|partial|failed|cancelled`), `av_scan_status`,
`idempotency_key` (ws-unique), `column_mapping`, `conflict_policy` (`overwrite|skip|keep_both`),
`target_list_id`, and counters (created/matched/duplicate/skipped/rejected/deduped/unprocessed). The model
supports pause/retry/cancel; **no API or UI exposes those transitions to an operator yet.**

### 5.2 Data validation ❌ **Missing as a framework**

There is **no validation rules engine and no validation surface.** Validation today is implicit and
scattered: Zod parsing at the API edge (`@leadwolf/types`), per-row normalization/prepare in
`packages/core/src/import/prepareContact.ts`, and `import_job_rows` reject reasons produced during import.
There is no operator-authorable rule set, no pre-commit validation report, no reject-triage queue, and no
quality-gate concept. (This is one of the largest true gaps — see `06`.)

### 5.3 Deduplication & record linking 🟡 **Partial (deterministic shipped; ER review deferred)**

- **Within-workspace dedup** ✅ — `dedup` queue → `packages/core/src/prospect/dedup.ts` flags
  `contacts.duplicate_of_contact_id` (idempotent, RLS-scoped). Merge is **automatic survivorship**, not a
  human action.
- **Cross-source entity resolution (Layer-0)** 🟡 — deterministic match ladder shipped
  (`packages/core/src/enrichment/matchKeys.ts`, `bulk/overlayMatcher.ts`); the `match_links` table models
  the ER output (`cluster_id`, `match_probability`, `match_method` deterministic/splink/manual,
  `is_duplicate_of` survivor link, **`review_status` auto/pending/confirmed/rejected**). The
  **probabilistic tail (Splink) and the clerical-review queue are deferred** — `match_probability`/
  `review_status` columns exist but are mostly unused, and `enrichment/bulk/masterGraphMatcher.ts` is a
  **stub**. `master-backfill` re-resolves NULL overlay bridges (`withErTx`).
- **Operable from a screen?** **No merge/split/review UI exists** anywhere. (Major gap — see `07`.)

### 5.4 Enrichment ✅ (engine shipped) / 🟡 (learning stubs)

Engine shipped: provider waterfall with per-process circuit breakers
(`packages/core/src/enrichment/{enrichContact,waterfall,policy,requestHash}.ts`), bulk matchers
(`enrichment/bulk/{overlayMatcher,estimate}.ts`), `enrichment` queue
(`apps/workers/src/queues/enrichment.ts`, providers injected from `@leadwolf/integrations`), control tables
`enrichment_jobs`/`_chunks`/`_rows` (`packages/db/src/schema/enrichmentJobs.ts`, with `cost_micros`,
`charged`, `match_confidence`). Status surface: `GET /api/v1/enrichment/jobs`, `/jobs/:jobId`. Stubs: the
breaker is per-process (Redis-shared breaker is a scale follow-up) and `expectedHitRate` learning is a stub.
- **Operable from a screen?** Only **provider budgets/health** (admin `provider-configs`). **No
  enrichment-run console** (per-run cost, hit-rate, provider attribution, re-run). (Gap — see `08`.)

### 5.5 Verification 🌒 **Built, config-gated (pass-through until creds set)**

Email/phone verifiers exist (`packages/core/src/data-health/{emailVerifier,reacherVerifier,emailPrescreen,
phoneVerifier,twilioPhoneVerifier,validatePhone}.ts`); `emailVerifier.ts` ships a `hybridVerifier`
(Reacher → commercial escalation on catch_all/unknown). **Default is `passThroughVerifier` — it grades
nothing** until `REACHER_*` (email) / `TWILIO_*` (phone) creds are present (all optional,
`packages/config/src/env.ts:110`/`:117`). A commercial email-secondary vendor is **not yet chosen**. The
freshness re-verification loop `reverifyContacts.ts` re-grades revealed + past-SLA contacts, gated by the
per-tenant flag `data_health.reverification` (fail-closed off), recording a `verification_jobs` ledger
(`migrations/0030_verification_jobs.sql`); `reverification`/`reverification-sweep` queues.

### 5.6 Search ✅ (Postgres-backed) / 🔲 (engine adapters deferred)

The list/search surface is `POST /api/v1/search/contacts` + `/count`/`/facets`/`/suggest`
(`apps/api/src/features/search/routes.ts`) and `POST /api/v1/account-search/*` — there is **no generic
`GET /contacts` list**; search *is* the list. Backed by Postgres (`packages/db/src/repositories/
searchRepository.ts`, ILIKE + keyset, inside `withTenantTx` so RLS is the isolation). The `SearchPort` seam
(`packages/search/src/`) ships only the in-memory dev adapter; OpenSearch (global) + Typesense (overlay)
adapters are **deferred behind the interface**. Query expansion helpers in `packages/core/src/search/*`.

### 5.7 Data quality / health ✅ (customer dashboard) / ❌ (no fleet view)

Per-workspace quality scoring shipped: `packages/core/src/data-health/{dataQualityScore,dataQualitySummary,
dataQualitySnapshot}.ts`; daily snapshots in `data_quality_snapshots`
(`migrations/0031_data_quality_snapshots.sql`) via the `data-quality-snapshot-sweep` queue. Surfaced to
**customers** through `apps/web` Data Health ([§3.2](#32-customer-self-service--appsweb--one-live-surface-data-health)).
There is **no cross-tenant / fleet quality view for staff.** (Gap.)

### 5.8 Retention & lifecycle 💤 **Built v1, INERT (shadow mode, deletes nothing)**

A per-data-class retention engine is built and "runs," but in **shadow mode** — it counts would-deletes and
removes nothing. Double-gated: per-tenant `retention_engine_enabled` flag (default false) **and** per-class
`mode` (`disabled`/`shadow`/`enforce`); all 12 seeded policies start `shadow`. Core
`packages/core/src/retention/runRetentionSweep.ts`; tables `retention_class_policies` (global) /
`retention_runs` (per-tenant) (`packages/db/src/schema/retention.ts`, `migrations/0033_retention_engine.sql`);
`data-retention-sweep` queue (scheduled daily). Only **low-risk classes are wired** (email_event,
provider_calls, *_job_rows, snapshots, verification_jobs, activities); contacts/consent/source_imports/
contact_reveals are deferred. **DSAR erasure is separate and shipped**
(`packages/core/src/compliance/deleteFanout.ts`). Operable from a screen: the admin Retention tabs (policy
editor — flipping a class to `enforce` is super-admin + audited `retention_policy.set`; runs evidence).
Design of record: `docs/planning/data-management/16-retention-engine-design.md`.

### 5.9 Compliance ✅ (DSAR, suppression, consent shipped)

`/api/v1/compliance` + `/compliance/dsar`; admin `compliance` screen (DSAR queue, global suppression/
blocklist, compliance retention list). Suppression gates reveal globally (`master_persons.is_suppressed`,
`packages/core/src/.../assertNotSuppressed.ts`). DSAR fan-out deletes across layers
(`compliance/deleteFanout.ts`); `dsar` queue. Residency/lawful-basis modules (India DPDP, GDPR Art.14
source-notice, TCPA/DNC line-type) are **designed but partly unbuilt** per
`docs/planning/data-management/05-compliance.md`.

### 5.10 Monitoring & observability 🟡 **Partial (one health screen, no pipeline depth)**

The admin **System health** screen shows service up/down (api/db/workers/redis/search), **live BullMQ queue
depth / DLQ / connected-worker counts**, and an import-job status tally. Queues are registered in
`apps/workers/src/register.ts` (one shared IORedis; producers exported; `startWorkers()` boots consumers;
scheduled sweeps leader-locked via `leaderLock.ts`). Each data queue has a `.dlq` partner. **What's
missing:** per-pipeline dashboards, run-history drill-down, SLOs/alerting, lineage, and cost trends. (Gap —
see `10`.)

### 5.11 Audit & version history ✅ (audit strong) / ❌ (no value-level versioning)

- **Tenant audit-of-record** ✅ — `audit_log` (`packages/db/src/schema/billing.ts:169`), append-only
  (UPDATE/DELETE blocked by trigger in `rls/billing.sql`), large closed `action` enum (contact/account/list/
  reveal/export/dsar/auth events), written via `packages/core/src/compliance/writeAudit.ts`.
- **Platform (staff) audit** ✅ — `platform_audit_log`, written **in the same transaction** as the
  privileged action by `withPlatformTx` (`client.ts:121`). Staff-ops tables `impersonation_sessions`,
  `jit_elevations`, `support_notes`, `account_holds`.
- **Version history / rollback** ❌ — none (see [§4](#4-the-two-layer-data-model-what-we-are-managing)).

### 5.12 Access control — two distinct RBAC models

- **Staff RBAC** ✅ (`packages/types/src/staffCapability.ts:13`) — roles `super_admin`, `support`,
  `billing_ops`, `compliance_officer`, `read_only`; a **closed 16-capability enum** (`tenants:*`, `users:*`,
  `billing:read`, `elevation:request`, `audit:read`, `compliance:*`, `impersonate:start`, `staff:manage`,
  `providers:manage`, `pricing:manage`, `content:manage`). Server gates: `platformAdmin` (signed `pa`
  claim) → `requireStaffRole` (resolves the **active** role per-request from `platform_staff`, so
  revocation is immediate) → `requireCapability`. **There is no `data:*` capability** — a Database
  Management role/capability set must be added (`03`/`11`). High-privilege paths: JIT elevation
  (`/admin/elevations`), break-glass impersonation (`/admin/impersonation`).
- **Customer RBAC** ✅ — `org_role` + `requireOrgRole` middleware, owner-scope (`owner_user_id`,
  `visibleContactIds`); a unified app-layer `scopeFor` + teams layer is **deferred** (a product/security
  policy call).

---

## 6. Control-plane inventory (tables & queues a panel would drive)

**Control/ledger tables:** `import_jobs`/`import_job_chunks`/`import_job_rows`,
`enrichment_jobs`/`_chunks`/`_rows`, `verification_jobs`, `data_quality_snapshots`,
`retention_class_policies`/`retention_runs`, `match_links` (ER output + review state), `source_imports`/
`source_records` (lineage), `audit_log` + `platform_audit_log`, `feature_flags`.

**BullMQ queues** (`apps/workers/src/register.ts`, each with a `.dlq`): `imports`, `bulk-imports` (dark),
`enrichment`, `dedup`, `firmographics`, `master-backfill` (+ sweep), `reverification` (+ sweep),
`data-quality-snapshot-sweep`, `data-retention-sweep`, `scoring`, `dsar`, plus email/outreach queues. The
API enqueues via exported producers (`enqueueImport`, `enqueueEnrichment`, `enqueueDedup`, …).

**API conventions any new endpoint inherits:** RFC 9457 problem envelope
(`apps/api/src/middleware/error.ts`, typed errors in `packages/types/src/errors.ts`), `Idempotency-Key`
replay on money endpoints (`middleware/idempotency.ts`), keyset (never offset) pagination
(`packages/types/src/search.ts`, `cursor`/`limit`→`nextCursor`), scope **always from the verified token**,
never the body.

---

## 7. Feature-flag inventory (the dark/inert switches)

`feature_flags` table; resolution order **per-tenant override → global_enabled → default**, fail-closed
(`isFlagEnabledForTenant` in `@leadwolf/core`); admin editor `apps/admin/src/features/feature-flags/*`;
seeded in `migrations/0034_seed_rollout_flags.sql`. Data-management flags (all default **off**):

| Flag / env | Layer | Default | Gates |
|---|---|---|---|
| `BULK_IMPORT_ENABLED` | env (`env.ts:174`) | false | Global kill-switch for the bulk COPY pipeline + worker construction. |
| `bulk_import_enabled` | DB flag | false | Per-tenant gate for `POST /imports/bulk` (only effective if the env is also on). |
| `retention_engine_enabled` | DB flag | false | Per-tenant master gate for the retention sweep (a delete *also* needs a class in `enforce`). |
| `data_health.reverification` | DB flag | false | Per-tenant gate for the reverification loop + on-demand reverify. |
| `REACHER_*` / `TWILIO_*` | env (`:110`/`:117`) | unset | Verifier stays pass-through (grades nothing) until set. |
| `BULK_IMPORT_STORAGE_DIR` / `_THRESHOLD_ROWS` | env (`:181`/`:184`) | dev disk / 5000 | Storage dir (no prod object store) / async threshold. |

---

## 8. Current challenges (synthesis)

1. **A platform without a cockpit.** The machinery exists; the operator's surface does not. Staff get three
   read-only screens (imports monitor, system health, audit) plus two narrow write screens (retention
   policy, compliance) — and **no way to validate, dedup/merge, enrich, approve, export, or remediate a
   record**.
2. **Dark/inert capability is invisible value *and* risk.** Bulk import (🌒), retention (💤), and the
   verifier (🌒) are built but produce no effect; nobody can see, exercise, or safely graduate them from a
   UI. Enabling them needs out-of-band steps (COPY spike, prod object store, verifier vendor + creds, legal
   TTL sign-off) that no screen tracks.
3. **No human-in-the-loop anywhere.** Dedup merges by automatic survivorship; there is no clerical-review
   queue for the `review_status='pending'` rows the schema already anticipates, and **no approval/maker-
   checker gate** on destructive or high-blast-radius operations (bulk delete, merge, `enforce` flip,
   bulk export).
4. **No validation framework.** Quality is enforced implicitly at parse/import time; there is no
   operator-authorable rule set, pre-commit validation report, or reject-triage workflow.
5. **Observability stops at queue depth.** No per-pipeline run history, SLOs, alerting, lineage, or cost
   trend — so an operator can see *that* a queue is deep but not *why a job failed* or *what it cost*.
6. **No record version history / rollback.** Append-only audit + `field_provenance` exist, but there is no
   value-level history or undo — a hard requirement for safe bulk operations.
7. **The access model has no data role.** Staff RBAC has no `data:*` capability, so even a well-built panel
   has nothing to gate against without new capabilities and role bundles.

---

## 9. The existing planning corpus (orientation only)

This series is **standalone**, but `01`/`03` reconcile against what the prior corpus actually shipped, so
the team isn't told to "build" what already exists:

- `docs/planning/data-management/00–16` — prior spec + the **implementation log** (`14`) is the best
  "built vs planned" record; `15`/`16` are the bulk-import and retention design-of-record. Note its
  migration references `0021–0026` map on disk to **`0029–0034`**.
- `docs/planning/crm-sync/00-enterprise-implementation-plan.md` — enterprise bidirectional CRM sync
  (greenfield 🔲).
- `docs/planning/list-plan/00–09` — list upload / import / governance (overlaps "upload workflows").
- Top-level numbered (`21` sourcing, `22` quality/freshness, `26` integrations, `30` bulk import/export,
  `31` bulk enrichment) + ADRs (`0015` dedup, `0021` master graph, `0024` scale, `0025` freshness,
  `0036–0039` bulk).

---

## 10. Status summary (the one table to remember)

| Subsystem | Status | Operable from a screen? | Primary gate |
|---|---|---|---|
| Standard import | ✅ Shipped | Customer wizard; staff monitor-only | — |
| Bulk import (COPY) | 🌒 Dark | Customer wizard; staff monitor-only | `BULK_IMPORT_ENABLED` + `bulk_import_enabled` + COPY spike + object store |
| Data validation | ❌ Missing | No | — |
| Dedup (within-ws) | ✅ Shipped | No (auto-survivorship) | — |
| Entity resolution / merge review | 🟡 Partial | No | Splink + review queue deferred |
| Enrichment engine | ✅ Shipped | Provider budgets only | — |
| Verification | 🌒 Dark | Customer reverify button | `REACHER_*`/`TWILIO_*` + vendor choice |
| Search | ✅ Shipped | Customer search | Engine adapters deferred |
| Data quality / health | ✅ Shipped (customer) | Customer dashboard; **no fleet view** | — |
| Retention engine | 💤 Inert (shadow) | Admin policy + runs | `retention_engine_enabled` + per-class `enforce` + legal TTL sign-off |
| Compliance (DSAR/suppression) | ✅ Shipped | Admin compliance | Residency modules partly unbuilt |
| Monitoring | 🟡 Partial | Admin system-health | No pipeline depth / SLOs |
| Audit | ✅ Shipped | Admin audit viewer | — |
| Version history / rollback | ❌ Missing | No | — |
| Staff RBAC | ✅ Shipped | Admin staff | **No `data:*` capability** |
| Approval / maker-checker | ❌ Missing | No | — |

---

## 11. Success criteria for this analysis (acceptance)

- [x] Every subsystem has a status badge, gate, and `file:line` anchor.
- [x] Both surfaces (staff console / customer self-service) are distinguished.
- [x] Dark/inert features are flagged with their *exact enable-gates*, not just "TODO."
- [x] The status table in [§10](#10-status-summary-the-one-table-to-remember) is the index `03` and `14`
      reference.
- [x] Claims are reconciled against the shipped corpus, so no gap is mis-stated as greenfield.

**Sources:** all citations are `path:line` on `feat/data-mgmt-01-research-brief`. The load-bearing ones
(`client.ts:74/121/56`, `staffCapability.ts:13`, `navConfig.ts:32`, `env.ts:174`) were verified firsthand;
the remainder are from a full read of the trees named in [§2](#2-method--scope).

→ Continue to [`02-Enterprise-Research`](./02-Enterprise-Research.md) for what enterprise platforms do, or
[`03-Gap-Analysis`](./03-Gap-Analysis.md) for the prioritized gap register built from this baseline.
