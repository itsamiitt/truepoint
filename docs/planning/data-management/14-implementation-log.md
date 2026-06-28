# 14 — Implementation Log (data-management build)

> **Companion to the planning series (`00`–`13`).** Those docs are the *plan*; this is *what got
> built* on branch `feat/data-mgmt-01-research-brief`, so the branch is reviewable + validatable in
> one place. **Status: shipped + self-reviewed; NOT yet CI-validated** in the build sandbox (no
> `bun`/`drizzle-kit`/Docker here — see §6 for the gates the reviewer must run before merge).

## 1. What shipped, by backlog item (`13 §6`)

| # | Item | State | Key commits |
|---|---|---|---|
| 1 | **Verifier subsystem** | ✅ email + phone + carrier line-type | `b2c04a1` · `cec26bb`/`d9ee5da` · `24f11c0` · `1154c1c` |
| 3 | **Freshness re-verification** | ✅ loop + sweep + per-tenant flag + audit ledger | `6148980` · `d6b9e1d` · `698496e` · `c741146` |
| 5 | **Quality metric dashboard** | ✅ per-contact badge + live aggregate + trend + reads + **dedicated Data Health page** | `b538114` · `e76231b` · `a5dd9c4` · `b874d48` · **`07048d0`** (the standalone `/data-health` page) |
| 2 | **Bulk COPY-staging import** | ✅ **fully built, DARK behind `BULK_IMPORT_ENABLED`** | `a7cc2d3` (control plane + mig 0024) · `e559f3d` (core primitives) · `2aff801` (`prepareContact` extract) · `bd27f2d` (pipeline + barrel-collision fix) · `721cfd8` (API + worker wiring) · `f9cff13` (pipeline itest = COPY spike + parity) |
| 6 | **Per-data-class retention** | ✅ **v1 built, INERT + double-gated** | `11d3a1f` (design + contract) · `12f45ff` (control plane + mig 0025) · `0df2c07` (shadow sweep) · `6a8ebe1` (enforce deleters) · `335f6ce` (itest) |

The planning docs `00`–`13` are the reconciled spec series this build implements; #2's on-branch
design record is `15-bulk-import-design.md`, #6's is `16-retention-engine-design.md`.

## 2. Migrations (hand-authored — see §6)

No `drizzle-kit` in the sandbox, so these mirror existing migrations + the snapshot format and were
`node`-validated (journal/snapshot chain + table count). The runtime migrator reads only
`meta/_journal.json` + the `.sql`; `meta/NNNN_snapshot.json` is `drizzle-kit`-only (drift check, §6).

| Migration | Change |
|---|---|
| `0021_phone_line_type` | `contacts ADD COLUMN phone_line_type` (TCPA mobile/landline signal). |
| `0022_verification_jobs` | New `verification_jobs` (re-verification audit ledger) + FKs + index + RLS. |
| `0023_data_quality_snapshots` | New `data_quality_snapshots` (Data Health trend store) + FKs + index + RLS. |
| `0024_bulk_import_jobs` | New `import_jobs` / `import_job_chunks` / `import_job_rows` (bulk-import control plane) + 7 FKs + 5 indexes + RLS. |
| `0025_retention_engine` | New `retention_policies` (global) + `retention_runs` (per-tenant) + FK + index + RLS + the 12 seeded default policies (all `shadow`). |

## 3. New tables + RLS

- **Workspace-scoped, FORCE-RLS (NULLIF isolation), mirror `enrichment_jobs`:** `verification_jobs`,
  `data_quality_snapshots`, `import_jobs`, `import_job_rows` (chunks scoped through the parent job).
- **`retention_policies`** — GLOBAL, platform-managed: app SELECT-only, NO write policy (the write
  wall is FORCE-RLS + policy-ABSENCE, not the grant — `applyMigrations`' blanket grant runs after RLS;
  the exact `feature_flags` mechanism).
- **`retention_runs`** — per-tenant, APPEND-ONLY: tenant-scoped SELECT + INSERT, NO update/delete policy.
- **Per-job UNLOGGED COPY-staging table** (`stg_import_<uuid>`) — NON-RLS by design (COPY can't run on
  an RLS table); isolated by ACCESS PATH (owner connection + explicit `workspace_id` predicate, confined
  to `importStagingRepository`); created/dropped at runtime, holds only encrypted PII + transient `raw_data`.
- **Isolation itests:** `verificationJobs.itest.ts`, `dataQualitySnapshots.itest.ts`, `importJobs.itest.ts`,
  `retention.itest.ts` (+ the pipeline itest below).

## 4. New API endpoints

| Endpoint | Returns / behavior |
|---|---|
| `GET /home/data-quality` · `/history` · `/reverification-runs` | The fill/freshness rollup, the trend series, recent re-verification runs (consumed by the Data Health page). |
| `POST /imports/bulk` · `GET /imports/bulk/:jobId` | Bulk import accept (stream→FileStore→createJob→enqueue drive) + status poll. **Hard-gated**: 403 `bulk_import_disabled` (after authn) when `BULK_IMPORT_ENABLED` is off → creates/enqueues nothing. |

Frontend: a dedicated **`/data-health`** page (`apps/web/features/data-health`, nav-wired) — Overview
(headline tiles, per-field coverage, freshness sparkline, email/phone verification breakdown) +
Re-verification activity, all on the 3 existing endpoints, four-states via `StateSwitch`.

## 5. Workers, flags, config

- **Workers (leader-locked, daily):** `reverificationSweep`, `dataQualitySnapshotSweep`,
  **`dataRetentionSweep`** (shadow-counts/enforce-purges per the policies, per active tenant — INERT
  until a tenant enables the flag). **Bulk:** the `bulk-imports` worker (drive→chunk fan-out → merge →
  finalize → rollups once) — registered ONLY inside `if (env.BULK_IMPORT_ENABLED)` (never constructed when off).
- **Per-tenant flags (fail-closed/opt-in):** `data_health.reverification`, **`retention_engine_enabled`**.
- **Config (all optional; absent → today's behaviour):** `REACHER_*`, `TWILIO_*`;
  **`BULK_IMPORT_ENABLED`** (default false), `BULK_IMPORT_STORAGE_DIR` (dev disk FileStore),
  `BULK_IMPORT_THRESHOLD_ROWS`.

## 6. CI validation checklist (run before merge)

Nothing below ran in the build sandbox. Required gates:

1. `bun install --frozen-lockfile`
2. `bun run typecheck` · `bun run lint` (Biome — may want `--write` for import-order nits) · `lint:boundaries`
3. `bun test` (units, incl. the verifier/pre-screen/route units)
4. The **itests** against real Postgres (+ Redis) — they provision via `applyMigrations`, so they exercise
   migrations **0021–0025** + the RLS-isolation itests. Highest-value new itests:
   - `retention.itest.ts` — RLS (policies read-only, runs append-only) + the sweep shadow/enforce + the
     cross-tenant enforce-isolation (deletes only the swept tenant's rows).
   - **`bulkImport.pipeline.itest.ts`** — **this IS the COPY-FROM-STDIN spike, executed in CI**: a
     byte-for-byte `copyRows`→`readChunkBand` round-trip (bytea/NULL/jsonb/special-char), the full
     drive→chunk→finalize, and the **bulk-vs-sync merge parity** (identical landed contact set).
5. **`drizzle-kit generate`** — should be a **no-op**; a non-empty diff means a hand-authored snapshot
   (0021–0025) drifted → regenerate that snapshot from the diff.

## 7. Enable-gates for the dark/inert features (NOT build gates — the code exists + is tested)

- **#2 bulk import** ships DARK. Before flipping `BULK_IMPORT_ENABLED`: (a) the COPY spike is now
  green-in-CI via the pipeline itest (✅ if §6.4 passes); (b) a **prod object store** — only the dev
  `diskFileStore` exists; the prod S3 adapter is injected at the composition root (no AWS SDK pulled in
  yet); (c) the plan-tier threshold routing + shadow cutover.
- **#6 retention** ships INERT. Before flipping a class to `enforce` on a flag-enabled tenant: confirm
  the legal/business **retention periods** (doc 16 §4 — `audit_log`/`contacts`/`consent` windows ship
  `null`/safe defaults); the enforce path is itest-gated (✅ if §6.4 passes).

## 8. Deferred / not built (with rationale)

| Item | Why |
|---|---|
| **#4 Teams/visibility + RBAC `org_role`** | ◑ Largely ALREADY built (reconciled): `requireOrgRole` middleware, the `org_role` model (`auth.ts`/`roleModel.itest.ts`), owner-scope (`ownerId` on contacts/lists/saved-searches), `visibleContactIds`. The remaining gap is a single unified app-layer `scopeFor` + a teams layer — a product/security policy call (the role→permission matrix), not an autonomous guess. |
| **ER/Splink tail · projection + true-ranked search** | ⏸ The deferred SCALE track (PLAN_00 C9) — not warranted at current scale. |
| **#7 CRM sync + write-back + erasure propagation** | ⛔ Multi-tick greenfield with external connectors/credentials. |
| **#8 Per-workspace ICP tuning** | ⛔ The weight *values* are a business/config decision (ADR-0008 "revisit-if"). |
| **Conflict-rate metric** | Needs cross-source value comparison (`field_provenance` stores only winners; raw values live in `source_imports`) + instrumenting the write path — a real analysis feature, not a single tick. |
| **On-demand re-verification trigger** | ✅ BUILT (data-management #3 follow-up): `POST /home/data-quality/reverify` — owner/admin-only (`requireRole("owner","admin")`) + per-caller `rateLimit` + a confirm dialog. NOT a new cost surface: the worker's `runReverification` re-checks the per-tenant `data_health.reverification` flag and **no-ops if off**, and the work is bounded to already-revealed, past-SLA contacts + idempotent — so it is the MANUAL form of the existing daily sweep, never a flag bypass. Platform-cost-only (re-verification re-runs the verifier; it does **not** debit tenant reveal credits — `chargeFor` is the reveal path only). The shared queue contract (`REVERIFICATION_QUEUE` + `ReverificationJobData`) moved to `@leadwolf/types` so api-producer + worker-consumer never drift. |

## 9. Frontend dashboards (web + admin) — delivered

The approved frontend plan (`.claude/plans/01-research-sparkling-crab.md`; W1/W2 + A1–A6) gives the
data-management backend its UI. All shipped on this branch, gated/inert as designed; every admin
surface is server-gated (`requireStaffRole` + `withPlatformTx` + a `platform_audit_log` row — client
render-gates are UX only). `useState`+`useEffect` (no TanStack), `@leadwolf/ui` + tokens, four-states
via `StateSwitch`, no new npm dependency (lockfile frozen).

**Web (`apps/web`):**
- **W1** — bulk-import polling UI (`features/import`: `postBulkImport`/`getBulkImportJob`, `useBulkImport`
  poll-to-terminal, `BulkImportProgress` + the 7 counts + rejected-rows link, an ImportWizard "large file"
  path, the `/imports/[jobId]` route). Renders a clear "not enabled" state for the dark-gate 403.
- **W2** — on-demand lead-score Recompute button (`POST /contacts/:id/rescore`).

**Admin (`apps/admin`):**
- **A1** — per-tenant auth-enforcement toggle + break-glass (super_admin, confirm dialog) on tenant-detail.
- **A2** — global retention policy editor (`GET`/`PUT /admin/retention-policies`; PUT super_admin + audited
  `retention_policy.set`; the shadow→enforce flip behind an explicit "permanent deletion" confirm).
- **A4** — cross-tenant bulk-import monitoring (`GET /admin/import-jobs`; bounded by `PLATFORM_READ_LIMIT`, no PII).
- **A5** — cross-tenant retention runs review (`GET /admin/retention-runs`; the shadow "what WOULD delete"
  evidence) — a Runs tab alongside A2's Policies.
- **A6 + A3** — flag rollout: seeded `retention_engine_enabled` + `bulk_import_enabled` defs (migration **0026**);
  the bulk gate is now `env` (global kill-switch) **+** the per-tenant `bulk_import_enabled` flag, both managed
  through the existing feature-flags admin (no new admin screen).

Backend prereqs built for the above: the admin retention GET/PUT + the `retention_policy.set` audit action (+
coverage drift-guard), the bounded cross-tenant `platformAdminReads` methods (`recentImportJobs`,
`recentRetentionRuns`), and the `enforcementEnabled` read on `getTenantDetail`. Backend-only **B1** (provider
secret-hint/health) + **B2** (real system-health probes) remain Platform/Ops-owned (the screens already render
those fields as stubs). The full plan + the autonomous decisions are in the plan file.

## 10. Recommended next move

**Run the §6 gates on the branch.** This is now the single highest-leverage action — one CI pass
validates 5 migrations, the COPY streaming, the bulk/sync merge parity, the retention engine + RLS,
and typecheck/lint across two backend features + a frontend page + the sync-import barrel-collision
fix. Once green (or with the failures sent back), the remaining work is the enable-gate inputs (§7 —
the prod S3 adapter, the legal retention periods) and the deferred/blocked items (§8); the genuinely-
unbuilt, in-sandbox-buildable, high-value data-management backlog is **done**.
