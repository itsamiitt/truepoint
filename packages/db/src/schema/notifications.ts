// notifications.ts — Drizzle schema for the in-app notification feed (28-audit G-NTF-1). One row per delivered
// notification to ONE user (the recipient): a typed event with a title/body and an optional entity link, plus a
// nullable `read_at` (null = unread). Workspace-scoped (RLS like contacts/saved_searches, rls/notifications.sql);
// PER-USER visibility is enforced in the repository by a user_id predicate (the GUC carries no user id). Producers
// insert; the recipient reads + marks read. Not append-only (read_at is updated).

import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
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

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    // The recipient. Per-user visibility is repo-enforced (RLS only bounds the workspace).
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Closed vocabulary mirrored in @leadwolf/types notificationType (kept a varchar for forward-compat).
    type: varchar("type", { length: 50 }).notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // Optional deep-link target (e.g. entityType='contact', entityId=<uuid>) so the feed row can route.
    entityType: varchar("entity_type", { length: 50 }),
    entityId: uuid("entity_id"),
    // null = unread; set to now() when the recipient reads it.
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The feed read: a user's notifications in a workspace, newest-first (backward index scan).
    byUserCreated: index("idx_notifications_user_created").on(t.workspaceId, t.userId, t.createdAt),
    // The unread-badge count: partial index over just the unread rows.
    unread: index("idx_notifications_unread")
      .on(t.workspaceId, t.userId)
      .where(sql`${t.readAt} IS NULL`),
  }),
);
