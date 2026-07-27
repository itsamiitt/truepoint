// activity.ts — Drizzle schema for the per-contact activity timeline (03 §7, 05 §10, M8): every
// interaction (sends, opens, replies, calls, meetings, notes) in one append-style stream; closed enums
// mirror packages/types activity.ts. contacts.last_activity_at is a CACHE of the newest occurred_at,
// maintained by the trigger in rls/activity.sql.
// PARTITIONED by month on occurred_at (E-6.4, migration 0085). Two consequences visible here: the primary key
// is (id, occurred_at) — a partitioned table's unique constraints must include the partition key — and any
// bulk DELETE should carry an occurred_at predicate so Postgres can prune to the relevant months instead of
// scanning every one. Nothing depends on `id` alone being unique (no inbound foreign keys).

import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { contacts } from "./contacts.ts";

const id = () => uuid("id").notNull().default(sql`uuid_generate_v7()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ── activities — one row per interaction; written by the send engine, manual logging, and Sales Nav ────
export const activities = pgTable(
  "activities",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id), // null = system (send engine, sync)
    activityType: varchar("activity_type", { length: 30 }).notNull(),
    channel: varchar("channel", { length: 20 }).notNull(),
    outcome: varchar("outcome", { length: 20 }),
    note: varchar("note", { length: 2000 }),
    metadata: jsonb("metadata").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Composite because the table is partitioned on occurred_at (0085); see the header.
    pk: primaryKey({ columns: [t.id, t.occurredAt] }),
    // The timeline read path: newest-first per contact within a workspace (05 §10).
    byContactRecency: index("idx_activities_ws_contact_occurred").on(
      t.workspaceId,
      t.contactId,
      t.occurredAt.desc(),
    ),
    // The WORKSPACE-wide recency aggregate (countByTypeForWorkspace: WHERE occurred_at >= $since GROUP BY
    // activity_type, with RLS supplying workspace_id) — read on every Home summary. byContactRecency above
    // cannot serve it: contact_id sits between workspace_id and occurred_at, so the range is unusable and the
    // aggregate read every activity row in the workspace. activity_type trails so the group-by can be satisfied
    // from the index. Added in migration 0080.
    byWorkspaceRecency: index("idx_activities_ws_occurred_type").on(
      t.workspaceId,
      t.occurredAt.desc(),
      t.activityType,
    ),
    typeEnum: check(
      "activities_type_enum",
      sql`${t.activityType} IN ('email_sent','email_opened','email_clicked','email_replied','call_made',
        'call_connected','linkedin_message','linkedin_connected','sales_nav_inmail','meeting_held','note_added')`,
    ),
    channelEnum: check(
      "activities_channel_enum",
      sql`${t.channel} IN ('email','phone','linkedin','sales_navigator','in-person')`,
    ),
    outcomeEnum: check(
      "activities_outcome_enum",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('connected','voicemail','no_answer','positive','negative','neutral')`,
    ),
  }),
);
