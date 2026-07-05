// importJobs.ts — Drizzle schema for the bulk COPY-staging import pipeline (15-bulk-import-design, backlog #2,
// ADR-0036): the control table `import_jobs`, the work-partition table `import_job_chunks`, and the high-volume
// per-row ledger `import_job_rows`. Mirrors the shipped enrichment trio (enrichmentJobs.ts) idiom-for-idiom —
// workspace-scoped like contacts, closed enums via the varchar + CHECK idiom this folder uses (no pgEnum),
// `uuid_generate_v7` PKs, partial-unique idempotency, denormalized `workspace_id` on the high-volume rows table
// for direct RLS. The per-job UNLOGGED non-RLS staging table is created/dropped at RUNTIME (not here). NOTE:
// 03 §12 targets monthly range-partitioning for the high-volume `import_job_rows` (same intent as
// activities/provider_calls/enrichment_job_rows); shipped as a plain table until volume warrants — do not
// silently drop the partitioning intent.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { importMappingTemplates } from "./importMappingTemplates.ts";

// Shared column idioms (kept local per the self-contained-schema convention used across this folder).
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ── import_jobs — the control row (one per uploaded file; NOT partitioned) ──────────────────────────────
// STORAGE PARAMS (S-P5, migration 0056 — Drizzle cannot express storage parameters, so this comment is the
// schema-side record; the hand-authored migration owns the DDL and a regen has nothing to fight):
// `fillfactor = 90` — the job row is the hottest row in the system during a run (≤ K chunk writers × ≤ 20
// counter deltas per 10k chunk, 09 §4.2), and the eight rows_* counters are deliberately NON-INDEXED so
// each delta is a HOT update given page headroom (12 §6.2). ⚠ NEVER INDEX A COUNTER COLUMN — an index on
// any rows_* / completed_chunks column forfeits HOT and puts ~200 index-entry writes per job on this row
// (12 §6.2's rule, recorded here per 12 §Rollout so no future index "optimization" trips it).
export const importJobs = pgTable(
  "import_jobs",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id), // null = system/automation
    sourceFile: varchar("source_file", { length: 1024 }).notNull(), // object-store key of the upload
    sourceName: varchar("source_name", { length: 255 }).notNull(), // original filename shown to the user
    status: varchar("status", { length: 30 }).notNull().default("queued"),
    fileSize: bigint("file_size", { mode: "number" }), // bytes; null until the upload is known
    avScanStatus: varchar("av_scan_status", { length: 20 }).notNull().default("pending"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }), // dedups re-submits of the same upload
    columnMapping: jsonb("column_mapping").notNull().default({}), // CSV header → canonical field map
    conflictPolicy: varchar("conflict_policy", { length: 20 }).notNull().default("skip"),
    targetListId: uuid("target_list_id"), // optional list to add imported contacts to (no FK; audit pointer)
    stagingTable: varchar("staging_table", { length: 128 }), // per-job UNLOGGED staging table name (runtime)
    byteOffset: bigint("byte_offset", { mode: "number" }).notNull().default(0), // resume watermark
    totalChunks: integer("total_chunks").notNull().default(0),
    completedChunks: integer("completed_chunks").notNull().default(0),
    rowsTotal: integer("rows_total").notNull().default(0),
    rowsCreated: integer("rows_created").notNull().default(0),
    rowsMatched: integer("rows_matched").notNull().default(0),
    rowsDuplicate: integer("rows_duplicate").notNull().default(0),
    rowsSkipped: integer("rows_skipped").notNull().default(0),
    rowsRejected: integer("rows_rejected").notNull().default(0),
    rowsDeduped: integer("rows_deduped").notNull().default(0),
    rowsUnprocessed: integer("rows_unprocessed").notNull().default(0),
    rejectedArtifactKey: varchar("rejected_artifact_key", { length: 1024 }), // object-store key of rejects
    // NON-PII reject breakdown (G08): stable label → count (e.g. {"email: invalid value": 12}). Never a row
    // value — see import/validateRow.rejectLabel. Powers the staff drill-down's "why rows were rejected" block.
    rejectHistogram: jsonb("reject_histogram").notNull().default({}),
    // Per-job share flag (import-redesign 10 §2.3, S-V1): column now, UX deferred — written by no route,
    // read only by the jobVisibility predicate (constant false ⇒ zero behavior change while unset).
    sharedWithWorkspace: boolean("shared_with_workspace").notNull().default(false),
    // ── Import v2 unified-job columns (import-redesign 08, S-I1) — ALL unread while the IMPORT_V2_ENABLED
    // dual gate is off. Written by S-I3+ (dual-write), S-I5 (routing), S-I6 (strategy), S-I8 (draft flow).
    // Server-side routing verdict at commit/one-shot (08 §1, S-I5): 'fast' | 'copy'; NULL = legacy row.
    processingMode: varchar("processing_mode", { length: 10 }),
    // The 08 §5.1 strategy pair (replaces conflict_policy through a compatibility mapping, S-I6). Defaults
    // mirror import_policy's workspace defaults (importPolicy.ts) so an unconfigured job matches the policy.
    mergeMode: varchar("merge_mode", { length: 20 }).notNull().default("create_and_update"),
    preservePopulated: boolean("preserve_populated").notNull().default(false),
    // Retry-failed child jobs (08 §6.3, S-I10): the child points at the parent it retries. SET NULL — a
    // deleted parent never cascades into its children's history.
    parentJobId: uuid("parent_job_id").references((): AnyPgColumn => importJobs.id, {
      onDelete: "set null",
    }),
    // Display filename for history (08 §Contradiction scan): source_name holds the SourceName PROVIDER ENUM,
    // not the filename, despite its inline comment — never repurposed; this column is the honest filename.
    sourceFilename: varchar("source_filename", { length: 255 }),
    // Template provenance (08 §3.1): which saved mapping template seeded this job. SET NULL on delete —
    // templates are named copies, never live references.
    mappingTemplateId: uuid("mapping_template_id").references(() => importMappingTemplates.id, {
      onDelete: "set null",
    }),
    // Parse/import options (countryHint, primary-from-column, delimiter…) — shape owned by S-I5/S-I8.
    options: jsonb("options").notNull().default({}),
    // Non-PII preview projection cache (08 §4): counts + histogram only, NEVER row values; NULL = never
    // previewed (sample rows are recomputed per request and never persisted here).
    previewSummary: jsonb("preview_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedReason: text("failed_reason"),
  },
  (t) => ({
    // The dashboard/worker read path: jobs of a given status within a workspace.
    byWsStatus: index("idx_import_jobs_ws_status").on(t.workspaceId, t.status),
    // Member-path keyset list (import-redesign 10 S-V1): the jobVisibility predicate narrowed to a creator
    // within a workspace, newest-first — keeps the scoped list index-ordered (no sort node).
    byWsCreatorCreated: index("idx_import_jobs_ws_creator_created").on(
      t.workspaceId,
      t.createdByUserId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    // Keyset list index for GET /imports (07 §4.3, S-I1): newest-first within a workspace, cursor-stable —
    // the exact ORDER BY listJobsByWorkspace already uses, which had no backing composite before.
    byWsCreated: index("idx_import_jobs_ws_created").on(
      t.workspaceId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    // Submit idempotency: a re-submit carrying the same key into the same workspace collapses onto the job.
    uniqWsIdempotency: uniqueIndex("uniq_import_jobs_ws_idempotency")
      .on(t.workspaceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    // 12-state vocabulary (08 §2.1, S-I1): the shipped 9 + draft/uploading/deferred — additive, none dropped.
    statusEnum: check(
      "import_jobs_status_enum",
      sql`${t.status} IN ('queued','validating','staged','running','paused','completed','partial','failed','cancelled','draft','uploading','deferred')`,
    ),
    processingModeEnum: check(
      "import_jobs_processing_mode_enum",
      sql`${t.processingMode} IN ('fast','copy')`,
    ),
    mergeModeEnum: check(
      "import_jobs_merge_mode_enum",
      sql`${t.mergeMode} IN ('create_and_update','create_only','update_only')`,
    ),
    avScanStatusEnum: check(
      "import_jobs_av_scan_status_enum",
      sql`${t.avScanStatus} IN ('pending','clean','infected','skipped')`,
    ),
    conflictPolicyEnum: check(
      "import_jobs_conflict_policy_enum",
      sql`${t.conflictPolicy} IN ('overwrite','skip','keep_both')`,
    ),
  }),
);

// ── import_job_chunks — the unit of work a runner claims (a contiguous row band of a job) ──────────────
export const importJobChunks = pgTable(
  "import_job_chunks",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    rowStart: integer("row_start").notNull(),
    rowEnd: integer("row_end").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    processedRows: integer("processed_rows").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    // The runner read path + dedup of a (job, chunk) pair (unique → `uniq_` prefix, per package convention).
    byJobChunk: uniqueIndex("uniq_import_job_chunks_job_chunk").on(t.jobId, t.chunkIndex),
    statusEnum: check(
      "import_job_chunks_status_enum",
      sql`${t.status} IN ('queued','running','paused','completed','partial','failed','cancelled')`,
    ),
  }),
);

// ── import_job_rows — one row per input CSV line; the create/match/reject ledger (HIGH VOLUME) ──────────
// NOTE: 03 §12 targets monthly range-partitioning (same as activities/provider_calls/enrichment_job_rows) —
// plain table until volume warrants; do not silently drop the partitioning intent. The four *_id pointer
// columns are plain uuid with NO FK (audit pointers; mirror enrichment_job_rows.matched_master_person_id).
// STORAGE PARAMS (S-P5, migration 0056; comment-only — Drizzle can't express them): per-table autovacuum
// posture for an append-only table at the 100M-row horizon (12 §6.2) — vacuum/analyze scale factors 0.01
// + insert threshold 100k, so the visibility map (index-only scans) and freeze keep up with import bursts
// instead of waiting for 20% of a 100M-row table. Reversible via ALTER … RESET (15 §R-P2).
export const importJobRows = pgTable(
  "import_job_rows",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => importJobChunks.id, { onDelete: "cascade" }),
    rowIndex: integer("row_index").notNull(), // 0-based line offset within the source file
    workspaceId: workspaceId(), // denormalized for direct RLS on this high-volume table
    input: jsonb("input").notNull().default({}), // the raw parsed CSV row
    outcome: varchar("outcome", { length: 20 }).notNull().default("unprocessed"),
    rejectReason: text("reject_reason"),
    createdContactId: uuid("created_contact_id"), // audit pointer (no FK)
    updatedContactId: uuid("updated_contact_id"), // audit pointer (no FK)
    matchedContactId: uuid("matched_contact_id"), // audit pointer (no FK)
    sourceImportId: uuid("source_import_id"), // audit pointer (no FK)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Read paths: all rows of a job; outcome rollups within a workspace.
    byJob: index("idx_import_job_rows_job").on(t.jobId),
    byWsOutcome: index("idx_import_job_rows_ws_outcome").on(t.workspaceId, t.outcome),
    outcomeEnum: check(
      "import_job_rows_outcome_enum",
      sql`${t.outcome} IN ('created','matched','duplicate','skipped','rejected','unprocessed')`,
    ),
  }),
);
