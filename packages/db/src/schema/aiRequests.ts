// aiRequests.ts — Drizzle schema for the metered AI-request log (23 §7-8 / 13a Area 14, M14). One row per AI
// model call (today: NL→structured search): which tenant/workspace/user, the task + model, the outcome +
// latency, and nullable token counts for future cost attribution. Workspace-scoped (RLS like
// notifications/contacts, rls/aiRequests.sql); staff read it CROSS-TENANT on the owner connection for platform
// AI observability. Append-only in practice — a metering row is immutable. user_id is ON DELETE SET NULL so a
// tenant's usage history survives a member's removal (metering must not shrink when someone leaves).

import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
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

export const aiRequests = pgTable(
  "ai_requests",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    // The caller. SET NULL on user delete so tenant-level metering history survives member removal.
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    // The AI task (closed vocab in code; varchar for forward-compat). Today only "nl_search".
    task: varchar("task", { length: 50 }).notNull(),
    // The configured model name at call time (AI_NL_SEARCH_MODEL); nullable if unknown.
    model: varchar("model", { length: 100 }),
    // Outcome vocab mirrored in @leadwolf/types aiRequestOutcome.
    outcome: varchar("outcome", { length: 30 }).notNull(),
    // True when the adapter needed a repair pass to produce a valid filter (a soft-quality signal).
    usedRepair: boolean("used_repair").notNull().default(false),
    latencyMs: integer("latency_ms"),
    // Token counts — nullable now (the AiPort doesn't surface usage yet); populated when it does (cost).
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Per-workspace history (RLS-scoped customer reads), newest-first (backward index scan).
    byWorkspaceCreated: index("idx_ai_requests_workspace_created").on(t.workspaceId, t.createdAt),
    // The platform cross-tenant time-bound scan (staff usage rollups since N days).
    byCreated: index("idx_ai_requests_created").on(t.createdAt),
  }),
);
