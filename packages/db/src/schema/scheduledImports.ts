// scheduledImports.ts — Drizzle schema for per-workspace SCHEDULED IMPORTS (import-and-data-model-redesign
// 08 §9 · 14 Phase 5 · 15 §M-SEQ open P5 band). One row = one recurring import definition: a cadence + a
// stored source object + the replayable mapping/strategy. The leader-locked sweep (scheduledImportSweep.ts)
// fires due schedules by submitting an ordinary `import_jobs` row through the EXISTING durable pipeline
// (submitCopyImport) — 08 §9: "creates an ordinary import_jobs row — same trio, same machine". Nothing here
// re-implements the engine. Workspace-scoped like import_policy / import_mapping_templates (tenant_id +
// workspace_id FKs, cascade on delete; rls/scheduledImports.sql). Closed vocabularies use the varchar+CHECK
// idiom (no pgEnum). UNREAD/INERT while the SCHEDULED_IMPORTS_ENABLED env kill-switch + the per-tenant
// `scheduled_imports_enabled` flag (seeded off in 0063) are off.
//
// created_by_user_id semantics (08 §9): a FIRED job carries created_by NULL ("system/automation") with the
// schedule pointer in its options — but the SCHEDULE stores its creator here (the grant executes AS this
// user, re-evaluated at fire time; a lost grant disables the schedule + notifies the creator). ON DELETE SET
// NULL: a deleted creator nulls this, and the fire-time grant re-eval treats a null/absent-role creator as
// grant loss (disable, don't fire) — a schedule can never run as a departed user.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";

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

// ── scheduled_imports — one recurring import definition per (workspace, name) ──────────────────────────────
export const scheduledImports = pgTable(
  "scheduled_imports",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    // The schedule's creator/owner — runs execute AS this user's grant (re-evaluated each fire). NULL after
    // the user is deleted ⇒ the fire-time grant re-eval disables the schedule (never fires as a departed user).
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    name: varchar("name", { length: 120 }).notNull(),
    // The provider enum recorded on every fired job (import_jobs.source_name — a SourceName, NOT a filename).
    sourceName: varchar("source_name", { length: 40 }).notNull(),
    // The STORED source object re-imported each fire (the 08 §9 "re-uploaded template file" branch). The
    // remote-URL / connected-source branch is DEFERRED (13 §8 SSRF forward-guard) — never a tenant-typed URL.
    sourceObjectKey: varchar("source_object_key", { length: 512 }).notNull(),
    sourceFilename: varchar("source_filename", { length: 255 }), // display only
    // The replayable column mapping (canonical field → source header; columnMappingSchema shape).
    mapping: jsonb("mapping").notNull().default({}),
    // The 08 §5 strategy pair for the fired job — NULLABLE (NULL = inherit the import_policy workspace default).
    mergeMode: varchar("merge_mode", { length: 20 }),
    preservePopulated: boolean("preserve_populated"),
    // Optional list-membership target for every fired job (SET NULL: a deleted list detaches, never blocks).
    targetListId: uuid("target_list_id"),
    // Parse/import options copied onto each fired job (countryHint, delimiter…; same shape as import_jobs.options).
    options: jsonb("options").notNull().default({}),
    // The fire cadence (interval enum; the pure cadence math lives in core). 08 §9 said "cron" — this v1 ships
    // an enum (drift-logged); a cron string can be added later without a rename.
    cadence: varchar("cadence", { length: 20 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // Why an auto-disable happened (NULL = live or manually disabled). Non-PII.
    disabledReason: varchar("disabled_reason", { length: 20 }),
    // Consecutive FIRE-TIME failures (grant loss / submission error). Reset to 0 on a successful fire and on
    // manual re-enable; at the threshold the schedule auto-disables (disabled_reason='max_failures').
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    // The next due instant (the sweep fires enabled rows with next_run_at <= now). Set at create; advanced by
    // the pure cadence math after each fire (missed windows are skipped, never backfilled).
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }), // NULL = never fired
    // The most-recently-fired import_jobs.id (observability/audit pointer; no FK — jobs are purged on retention).
    lastJobId: uuid("last_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Per-workspace, case-insensitive name uniqueness — the update target; a re-create under a taken name 422s.
    uniqWsLowerName: uniqueIndex("uniq_scheduled_imports_ws_lower_name").on(
      t.workspaceId,
      sql`lower(${t.name})`,
    ),
    // The sweep's due-schedule read (system-level, owner connection): enabled rows ordered by next_run_at.
    // Partial index over just the enabled rows keeps it tiny regardless of how many schedules are paused.
    dueIdx: index("idx_scheduled_imports_due")
      .on(t.nextRunAt)
      .where(sql`${t.enabled} = true`),
    cadenceEnum: check(
      "scheduled_imports_cadence_enum",
      sql`${t.cadence} IN ('hourly','daily','weekly')`,
    ),
    mergeModeEnum: check(
      "scheduled_imports_merge_mode_enum",
      sql`${t.mergeMode} IN ('create_and_update','create_only','update_only')`,
    ),
    disabledReasonEnum: check(
      "scheduled_imports_disabled_reason_enum",
      sql`${t.disabledReason} IN ('grant_lost','max_failures')`,
    ),
  }),
);
