// lists.ts — Drizzle schema for static prospect lists (24, bulk "add to list"): `lists` (workspace-scoped
// named collections) + `list_members` (the contact↔list join; one membership per (list, contact)). A list is
// a manual collection, distinct from `saved_searches` (a dynamic re-runnable filter set). Workspace-scoped
// like contacts/saved_searches; RLS in src/rls/lists.sql. Owner-vs-workspace visibility (if ever needed) is
// an app-layer concern — RLS only guarantees the workspace boundary.

import { sql } from "drizzle-orm";
import { pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { contacts } from "./contacts.ts";

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

// ── lists — named manual collections of contacts ───────────────────────────────────────────────────────
export const lists = pgTable(
  "lists",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    // Creator; kept for attribution (no cascade-delete — a removed user shouldn't drop a shared list).
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // One list name per workspace (case-sensitive at MVP; matches outreach_sequences).
    uniqWsName: uniqueIndex("uniq_lists_ws_name").on(t.workspaceId, t.name),
  }),
);

// ── list_members — the contact↔list join; unique (list, contact) = membership idempotency ──────────────
export const listMembers = pgTable(
  "list_members",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    addedByUserId: uuid("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Re-adding the same contact to a list is a no-op (ON CONFLICT DO NOTHING upstream).
    uniqListContact: uniqueIndex("uniq_list_members_list_contact").on(t.listId, t.contactId),
  }),
);
