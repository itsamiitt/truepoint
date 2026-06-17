// importMappingTemplates.ts — Drizzle schema for saved import column-mapping templates (G-IMP-3, 30 §8): a
// NAMED, workspace-scoped, replayable `ColumnMapping` so a recurring drop from the same source maps itself.
// Workspace-scoped like contacts/enrichment_jobs (tenant_id + workspace_id FKs, cascade on delete). The
// `mapping` jsonb holds the canonical-field → source-header map (the @leadwolf/types `columnMappingSchema`
// shape — validated at the API edge, stored verbatim). The (workspace_id, lower(name)) unique index makes a
// re-save under the same name UPSERT in place (case-insensitive) rather than accumulate duplicates.

import { sql } from "drizzle-orm";
import { jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
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
  }),
);
