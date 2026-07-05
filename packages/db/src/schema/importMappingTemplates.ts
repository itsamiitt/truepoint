// importMappingTemplates.ts — Drizzle schema for saved import column-mapping templates (G-IMP-3, 30 §8): a
// NAMED, workspace-scoped, replayable `ColumnMapping` so a recurring drop from the same source maps itself.
// Workspace-scoped like contacts/enrichment_jobs (tenant_id + workspace_id FKs, cascade on delete). The
// `mapping` jsonb holds the canonical-field → source-header map (the @leadwolf/types `columnMappingSchema`
// shape — validated at the API edge, stored verbatim). The (workspace_id, lower(name)) unique index makes a
// re-save under the same name UPSERT in place (case-insensitive) rather than accumulate duplicates.
// S-I2 (import-redesign 08 §3.1) adds the sharing knob (`visibility`) and the template-carried strategy
// block (`merge_mode` / `preserve_populated` / `options`) — a template stores the mapping PLUS the settings.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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

// ── import_mapping_templates — one named, replayable column mapping per workspace (NOT partitioned) ─────────
export const importMappingTemplates = pgTable(
  "import_mapping_templates",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    name: varchar("name", { length: 120 }).notNull(), // workspace-unique handle (case-insensitive, see index)
    mapping: jsonb("mapping").notNull().default({}), // canonical field → source header (columnMappingSchema)
    createdByUserId: uuid("created_by_user_id").references(() => users.id), // null = system/automation
    // ── Import v2 sharing + strategy block (import-redesign 08 §3.1, S-I2) — UNREAD while the
    // IMPORT_V2_ENABLED dual gate is off. 'workspace' default keeps every existing row's current
    // workspace-visible semantics; 'private' is the Data Loader .sdl-per-user analog (creator-only).
    visibility: varchar("visibility", { length: 10 }).notNull().default("workspace"),
    // The 08 §5 strategy pair ON the template — NULLABLE: NULL = "template doesn't pin a strategy; inherit
    // the import_policy workspace default", so pre-S-I2 templates never silently pin one.
    mergeMode: varchar("merge_mode", { length: 20 }),
    preservePopulated: boolean("preserve_populated"),
    // Parse/import options copied with the template (same shape as import_jobs.options; owned by S-I5/S-I8).
    options: jsonb("options").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Per-workspace, case-insensitive name uniqueness: a re-save under the same name (any case) collapses
    // onto the existing template (the upsert target) instead of accumulating duplicates.
    uniqWsLowerName: uniqueIndex("uniq_import_mapping_templates_ws_lower_name").on(
      t.workspaceId,
      sql`lower(${t.name})`,
    ),
    visibilityEnum: check(
      "import_mapping_templates_visibility_enum",
      sql`${t.visibility} IN ('private','workspace')`,
    ),
    mergeModeEnum: check(
      "import_mapping_templates_merge_mode_enum",
      sql`${t.mergeMode} IN ('create_and_update','create_only','update_only')`,
    ),
  }),
);
