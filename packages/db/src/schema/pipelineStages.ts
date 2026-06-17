// pipelineStages.ts — Drizzle schema for the workspace pipeline-stage layer (G-REV-7, ADR-0028). Teams define
// their own ordered stages; each stage maps to EXACTLY ONE canonical `outreach_status` value so the load-bearing
// enum stays intact (boards/views operate on stages, the enum stays the system vocabulary). Workspace-scoped
// like contacts; the closed `maps_to_status` set uses the varchar + CHECK idiom every schema unit here uses —
// it MIRRORS the `outreachStatus` Zod enum in packages/types/src/contacts.ts (the source of truth) and the
// `contacts_outreach_status_enum` CHECK in contacts.ts, identically (not a new vocabulary). A nullable
// `pipeline_stage_id` FK on contacts (added in contacts.ts) records the assignment ON DELETE SET NULL.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./auth.ts";

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

// ── pipeline_stages — workspace-defined, ordered stages, each mapping to one canonical outreach_status ──
export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    name: varchar("name", { length: 120 }).notNull(),
    ordering: integer("ordering").notNull().default(0),
    // The canonical outreach_status a contact rolls up to when assigned to this stage. The CHECK mirrors the
    // contacts_outreach_status_enum set exactly (H-vocab: the enum is NOT re-opened, it is referenced).
    mapsToStatus: varchar("maps_to_status", { length: 50 }).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The board/management read path: a workspace's stages in display order.
    byWsOrdering: index("idx_pipeline_stages_ws_ordering").on(t.workspaceId, t.ordering),
    // Per-workspace stage-name uniqueness over the LIVE stages only (archived names may be reused).
    uniqWsName: uniqueIndex("uniq_pipeline_stages_ws_name")
      .on(t.workspaceId, t.name)
      .where(sql`${t.archived} = false`),
    // Mirror of contacts_outreach_status_enum — identical closed set, NOT a new vocabulary (ADR-0028 H-vocab).
    mapsToStatusEnum: check(
      "pipeline_stages_maps_to_status_enum",
      sql`${t.mapsToStatus} IN ('new','in_sequence','replied','meeting_booked','disqualified','nurture','unsubscribed')`,
    ),
  }),
);
