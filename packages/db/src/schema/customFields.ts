// customFields.ts — Drizzle schema for the workspace-scoped record-customization layer (ADR-0028, 03 §14,
// 05 §7, gap G-REV-5). `custom_field_definitions` is the per-workspace, per-entity typed registry; the values
// themselves live in a typed-jsonb `custom_fields` column on `contacts`/`accounts` (added in contacts.ts) —
// NOT EAV, NOT physical columns (no DDL churn at 100M+ rows). `key` is immutable and unique per (workspace,
// entity); `field_type`/`entity` are closed enums mirrored in @leadwolf/types + the CHECK constraints here.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./auth.ts";

// Shared column idioms (kept local per the self-contained-schema convention in contacts.ts).
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ── Custom field definitions (workspace-scoped, per entity) ──────────────────────────────────────────────
export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    // Which overlay record this customizes. The `custom_fields` jsonb lives on that record.
    entity: varchar("entity", { length: 20 }).notNull(),
    // Immutable jsonb storage key (^[a-z][a-z0-9_]*$ — enforced at the edge by @leadwolf/types).
    key: varchar("key", { length: 64 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    fieldType: varchar("field_type", { length: 20 }).notNull(),
    // Allowed values for a `select` field; null otherwise.
    options: jsonb("options").$type<string[] | null>(),
    required: boolean("required").notNull().default(false),
    // Soft-archive: keeps historical values readable while hiding the field from new edits.
    archived: boolean("archived").notNull().default(false),
    ordering: integer("ordering").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // One definition per key within a workspace's entity (the jsonb storage contract).
    uniqWsEntityKey: uniqueIndex("uniq_custom_field_defs_ws_entity_key").on(
      t.workspaceId,
      t.entity,
      t.key,
    ),
    entityEnum: check("custom_field_defs_entity_enum", sql`${t.entity} IN ('contact','account')`),
    fieldTypeEnum: check(
      "custom_field_defs_type_enum",
      sql`${t.fieldType} IN ('text','number','date','select','boolean','url')`,
    ),
    // A select field MUST carry a non-empty options array; every other type MUST NOT.
    optionsShape: check(
      "custom_field_defs_options_shape",
      sql`(${t.fieldType} = 'select' AND ${t.options} IS NOT NULL AND jsonb_array_length(${t.options}) > 0)
          OR (${t.fieldType} <> 'select' AND ${t.options} IS NULL)`,
    ),
  }),
);
