// savedSearches.ts — Drizzle schema for `saved_searches` (M8, 24 §8): a workspace-scoped persisted filter
// set. `filters` stores the validated `contactQuery` blob (packages/types/src/search.ts) verbatim — applying
// a saved search re-runs POST /search/contacts with it (never raw SQL). `visibility` mirrors the closed enum
// in packages/types/src/savedSearch.ts (that file is the source of truth). Workspace-scoped like contacts;
// RLS in src/rls/savedSearches.sql.

import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";

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

// ── saved_searches — persisted filter sets (24 §8) ─────────────────────────────────────────────────────
export const savedSearches = pgTable(
  "saved_searches",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    // The creator. Owner-only mutations gate on this in the repository/core; workspace-visible rows are
    // readable by every member (listVisible). FK kept (no cascade-delete: a removed user shouldn't silently
    // drop a shared workspace search) — ownership is enforced in code, not by row removal.
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    name: varchar("name", { length: 120 }).notNull(),
    // The validated contactQuery blob (search.ts). Re-applied by re-running the search; never parsed as SQL.
    filters: jsonb("filters").notNull(),
    visibility: varchar("visibility", { length: 20 }).notNull().default("private"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    visibilityEnum: check(
      "saved_searches_visibility_enum",
      sql`${t.visibility} IN ('private','workspace')`,
    ),
  }),
);
