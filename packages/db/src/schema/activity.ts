// activity.ts — Drizzle schema for the per-contact activity timeline (03 §7, 05 §10, M8): every
// interaction (sends, opens, replies, calls, meetings, notes) in one append-style stream; closed enums
// mirror packages/types activity.ts. contacts.last_activity_at is a CACHE of the newest occurred_at,
// maintained by the trigger in rls/activity.sql.
// NOTE: 03 §12/05 §10 target monthly range-partitioning; plain table until volume warrants.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { contacts } from "./contacts.ts";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
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
    // The timeline read path: newest-first per contact within a workspace (05 §10).
    byContactRecency: index("idx_activities_ws_contact_occurred").on(
      t.workspaceId,
      t.contactId,
      t.occurredAt.desc(),
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
