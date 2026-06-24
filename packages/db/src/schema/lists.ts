// lists.ts — Drizzle schema for static prospect lists (24, bulk "add to list"): `lists` (workspace-scoped
// named collections) + `list_members` (the contact↔list join; one membership per (list, contact)). A list is
// a manual collection, distinct from `saved_searches` (a dynamic re-runnable filter set). Workspace-scoped
// like contacts/saved_searches; RLS in src/rls/lists.sql. Owner-vs-workspace visibility (if ever needed) is
// an app-layer concern — RLS only guarantees the workspace boundary.

import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { contacts, sourceImports } from "./contacts.ts";
import { savedSearches } from "./savedSearches.ts";

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
    // static = explicit membership (a curated snapshot); dynamic = membership derived from `savedSearchId`
    // (Phase 4 auto-refresh). Default 'static' so every existing/created list is unchanged.
    listKind: varchar("list_kind", { length: 20 }).notNull().default("static"),
    // Light presentational metadata: palette KEY (not raw hex — design tokens) + icon name + freeform notes.
    color: varchar("color", { length: 30 }),
    icon: varchar("icon", { length: 40 }),
    // List-level organising tags (array of strings); distinct from contact tags (ADR-0028).
    tags: jsonb("tags").notNull().default([]),
    notes: text("notes"),
    // How the list was first created (manual | import | search | api) — list-level provenance.
    source: varchar("source", { length: 40 }),
    // Dynamic lists: the saved filter that defines membership (Phase 4 reads it). SET NULL if the search is
    // deleted — the list degrades to an empty dynamic list rather than dangling. NOTE: this FK only proves the
    // referenced row EXISTS, not that it is in the same workspace (FK checks bypass RLS). The Phase-4 write
    // path MUST validate this id under the caller's withTenantTx (reject a foreign id, like visibleContactIds
    // does for members) — never rely on the FK alone for workspace isolation.
    savedSearchId: uuid("saved_search_id").references(() => savedSearches.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // Soft-delete tombstone — a soft-deleted list frees its name (see the partial unique index below).
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // One LIVE list name per workspace — partial on deleted_at IS NULL so a soft-deleted list frees its name
    // (case-sensitive at MVP; matches outreach_sequences).
    uniqWsName: uniqueIndex("uniq_lists_ws_name")
      .on(t.workspaceId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    listKindEnum: check("lists_list_kind_enum", sql`${t.listKind} IN ('static','dynamic')`),
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
    // How this member entered the list (search reveal | import | manual | api) — per-member provenance.
    addedVia: varchar("added_via", { length: 20 }).notNull().default("manual"),
    // If added by an import job, the originating source_imports row (SET NULL if that provenance is purged).
    // NOTE: like saved_search_id, this FK is NOT a workspace guard — the Phase-2 import write path must set it
    // only from a same-workspace import job (validated under withTenantTx), never trust it for isolation.
    sourceImportId: uuid("source_import_id").references(() => sourceImports.id, {
      onDelete: "set null",
    }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Re-adding the same contact to a list is a no-op (ON CONFLICT DO NOTHING upstream).
    uniqListContact: uniqueIndex("uniq_list_members_list_contact").on(t.listId, t.contactId),
    addedViaEnum: check(
      "list_members_added_via_enum",
      sql`${t.addedVia} IN ('search','import','manual','api')`,
    ),
  }),
);
