// tags.ts — Drizzle schema for the record-customization tag layer (ADR-0028, G-REV-6): workspace-scoped,
// lightweight cross-list labels, orthogonal to lists. Two tables — `tags` (the definitions) and
// `record_tags` (the assignments). `color` is a BRAND PALETTE KEY (neutral/accent/success/warning/danger/
// info) the web app maps to a --tp-* token — NOT a raw hex (brand monochrome system, 04 §2/§3). Per-workspace
// case-insensitive name uniqueness via a unique index on lower(name). RLS + updated_at live in rls/tags.sql.

import { sql } from "drizzle-orm";
import { check, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./auth.ts";

// Shared column idioms (kept local per the self-contained-schema convention; mirrors contacts.ts).
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

// ── tags — the workspace-scoped tag definitions ────────────────────────────────────────────────────────
export const tags = pgTable(
  "tags",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    name: varchar("name", { length: 60 }).notNull(),
    // Brand palette KEY → --tp-* token in apps/web (tagColors.ts). Never a raw hex.
    color: varchar("color", { length: 20 }).notNull().default("neutral"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Per-workspace, case-insensitive name uniqueness — "Hot" and "hot" collide (409 in core).
    uniqWsName: uniqueIndex("uniq_tags_ws_name").on(t.workspaceId, sql`lower(${t.name})`),
    colorEnum: check(
      "tags_color_enum",
      sql`${t.color} IN ('neutral','accent','success','warning','danger','info')`,
    ),
  }),
);

// ── record_tags — the assignments (one row per tag↔record link) ────────────────────────────────────────
export const recordTags = pgTable(
  "record_tags",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    entity: varchar("entity", { length: 20 }).notNull(),
    recordId: uuid("record_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    // One assignment per (tag, record): re-assigning the same tag to the same record is a no-op (idempotent).
    uniqTagRecord: uniqueIndex("uniq_record_tags_tag_record").on(t.tagId, t.entity, t.recordId),
    entityEnum: check("record_tags_entity_enum", sql`${t.entity} IN ('contact','account')`),
  }),
);
