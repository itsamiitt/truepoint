// enrichmentJobs.ts — Drizzle schema for bulk CSV enrichment (Wave 1, additive foundation): the control
// table `enrichment_jobs`, the work-partition table `enrichment_job_chunks`, and the high-volume per-row
// ledger `enrichment_job_rows`. Workspace-scoped like contacts; closed enums use the varchar + CHECK idiom
// that every schema unit here uses (this repo declares no pgEnum — see contacts.ts email_status, billing.ts
// audit_log action). `email_status` REUSES the exact contacts column shape + the same closed set, so a bulk
// row's verification verdict stays comparable to contacts.email_status. NOTE: 03 §12 targets monthly
// range-partitioning for the high-volume `enrichment_job_rows` (same intent as activities/provider_calls);
// shipped as a plain table until volume warrants — do not silently drop the partitioning intent.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { contacts } from "./contacts.ts";

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

// ── enrichment_jobs — the control row (one per uploaded file; NOT partitioned) ─────────────────────────
export const enrichmentJobs = pgTable(
  "enrichment_jobs",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id), // null = system/automation
    sourceFile: varchar("source_file", { length: 1024 }).notNull(), // S3 key of the uploaded CSV
    sourceName: varchar("source_name", { length: 255 }).notNull(), // original filename shown to the user
    status: varchar("status", { length: 30 }).notNull().default("queued"),
    totalRows: integer("total_rows").notNull().default(0),
    processedRows: integer("processed_rows").notNull().default(0),
    matchedRows: integer("matched_rows").notNull().default(0),
    enrichedRows: integer("enriched_rows").notNull().default(0),
    chargedRows: integer("charged_rows").notNull().default(0),
    creditEstimateMicros: bigint("credit_estimate_micros", { mode: "number" }),
    creditSpentMicros: bigint("credit_spent_micros", { mode: "number" }).notNull().default(0),
    columnMapping: jsonb("column_mapping").notNull().default({}), // CSV header → canonical field map
    options: jsonb("options").notNull().default({}), // run options (providers, dedup policy, etc.)
    idempotencyKey: varchar("idempotency_key", { length: 255 }), // dedups re-submits of the same upload
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedReason: text("failed_reason"),
  },
  (t) => ({
    // The dashboard/worker read path: jobs of a given status within a workspace.
    byWsStatus: index("idx_enrichment_jobs_ws_status").on(t.workspaceId, t.status),
    // Submit idempotency: a re-submit carrying the same key into the same workspace collapses onto the job.
    uniqWsIdempotency: uniqueIndex("uniq_enrichment_jobs_ws_idempotency")
      .on(t.workspaceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    statusEnum: check(
      "enrichment_jobs_status_enum",
      sql`${t.status} IN ('queued','estimating','awaiting_confirmation','running','paused','completed','failed','cancelled')`,
    ),
  }),
);

// ── enrichment_job_chunks — the unit of work a runner claims (a contiguous row band of a job) ──────────
export const enrichmentJobChunks = pgTable(
  "enrichment_job_chunks",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => enrichmentJobs.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    rowStart: integer("row_start").notNull(),
    rowEnd: integer("row_end").notNull(),
    // Reuses the job-status vocabulary as free text (a subset is meaningful for a chunk).
    status: varchar("status", { length: 30 }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    processedRows: integer("processed_rows").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    // The runner read path + dedup of a (job, chunk) pair (unique → `uniq_` prefix, per package convention).
    byJobChunk: uniqueIndex("uniq_enrichment_job_chunks_job_chunk").on(t.jobId, t.chunkIndex),
    statusEnum: check(
      "enrichment_job_chunks_status_enum",
      sql`${t.status} IN ('queued','estimating','awaiting_confirmation','running','paused','completed','failed','cancelled')`,
    ),
  }),
);

// ── enrichment_job_rows — one row per input CSV line; the match/enrich/cost ledger (HIGH VOLUME) ────────
// NOTE: 03 §12 targets monthly range-partitioning (same as activities/provider_calls) — plain table until
// volume warrants; do not silently drop the partitioning intent.
export const enrichmentJobRows = pgTable(
  "enrichment_job_rows",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => enrichmentJobs.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => enrichmentJobChunks.id, { onDelete: "cascade" }),
    rowIndex: integer("row_index").notNull(), // 0-based line offset within the source file
    workspaceId: workspaceId(), // denormalized for direct RLS on this high-volume table
    input: jsonb("input").notNull().default({}), // the raw parsed CSV row
    matchMethod: varchar("match_method", { length: 30 }).notNull().default("none"),
    matchOutcome: varchar("match_outcome", { length: 30 }).notNull().default("unmatched"),
    matchedContactId: uuid("matched_contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    matchedMasterPersonId: uuid("matched_master_person_id"), // cross-workspace master graph (no FK in Wave 1)
    matchConfidence: numeric("match_confidence", { precision: 5, scale: 4 }), // 0.0000–1.0000
    enrichedFields: jsonb("enriched_fields").notNull().default({}),
    providerSource: varchar("provider_source", { length: 50 }),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    charged: boolean("charged").notNull().default(false),
    emailStatus: varchar("email_status", { length: 20 }).notNull().default("unverified"), // reuse contacts set
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Read paths: all rows of a job; outcome rollups within a workspace.
    byJob: index("idx_enrichment_job_rows_job").on(t.jobId),
    byWsOutcome: index("idx_enrichment_job_rows_ws_outcome").on(t.workspaceId, t.matchOutcome),
    matchMethodEnum: check(
      "enrichment_job_rows_match_method_enum",
      sql`${t.matchMethod} IN ('deterministic_email','deterministic_linkedin','deterministic_phone','deterministic_domain','fuzzy_name_company','provider','none')`,
    ),
    matchOutcomeEnum: check(
      "enrichment_job_rows_match_outcome_enum",
      sql`${t.matchOutcome} IN ('matched_internal','matched_provider','unmatched','suppressed','error')`,
    ),
    // Reuse of the contacts.email_status closed set — identical, not a new vocabulary.
    emailStatusEnum: check(
      "enrichment_job_rows_email_status_enum",
      sql`${t.emailStatus} IN ('unverified','valid','risky','invalid','catch_all','unknown')`,
    ),
    confidenceRange: check(
      "enrichment_job_rows_confidence_range",
      sql`${t.matchConfidence} IS NULL OR ${t.matchConfidence} BETWEEN 0 AND 1`,
    ),
  }),
);
