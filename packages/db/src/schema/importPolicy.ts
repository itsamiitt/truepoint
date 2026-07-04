// importPolicy.ts — Drizzle schema for the per-workspace import policy (import-and-data-model-redesign
// 10 §3, S-V1; G02). One row per workspace (workspace_id UNIQUE), mirroring the shipped enrichment_policy
// idiom: `who_can_import` is the named "import at all" grant escape hatch (default 'member' = the market
// broad default; 'admin' = governed workspaces), and the two strategy-default columns are the 08 §5
// org-admin workspace defaults (default_merge_mode / default_preserve_populated) consumed by S-I6 later —
// landed here so one policy object carries one settings surface and one audit trail. Closed vocabularies use
// the varchar + CHECK idiom (no pgEnum). `updated_by_user_id` records the last admin who changed the policy
// (the audited write is 'import.policy_updated'). UNREAD while the JOB_VISIBILITY_SCOPED dual gate is off.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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

// ── import_policy — one import policy per workspace ─────────────────────────────────────────────────────
export const importPolicy = pgTable(
  "import_policy",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    // The G02 grant knob: 'member' (default — member+ may create imports) or 'admin' (elevated only).
    whoCanImport: varchar("who_can_import", { length: 10 }).notNull().default("member"),
    // 08 §5 workspace strategy defaults (consumed by S-I6; stored now so the policy object is complete).
    defaultMergeMode: varchar("default_merge_mode", { length: 20 })
      .notNull()
      .default("create_and_update"),
    defaultPreservePopulated: boolean("default_preserve_populated").notNull().default(false),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id), // null = never user-set
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One policy per workspace — the upsert target (unique → `uniq_` prefix, per package convention).
    uniqWorkspace: uniqueIndex("uniq_import_policy_workspace").on(t.workspaceId),
    whoCanImportEnum: check(
      "import_policy_who_can_import_enum",
      sql`${t.whoCanImport} IN ('member','admin')`,
    ),
    defaultMergeModeEnum: check(
      "import_policy_default_merge_mode_enum",
      sql`${t.defaultMergeMode} IN ('create_and_update','create_only','update_only')`,
    ),
  }),
);
