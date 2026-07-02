// eventOutbox.ts — the ADR-0027 transactional outbox for DOMAIN EVENTS (reveal-experience Phase 4). A writer
// appends an event row IN THE SAME withTenantTx as the state change (so "DB commit ⇒ event enqueued" is
// crash-safe — no event is lost between commit and publish). A leaderless relay (apps/workers) drains pending
// rows FOR UPDATE SKIP LOCKED and publishes them to Redis pub/sub (fan-out across api instances) for the
// authenticated SSE stream. `id` is a v7 uuid = the event_id (time-sortable → the SSE `id:`/last-event-id).
// Payload is PII-FREE by contract (ids + counts + status only). Workspace-scoped like contacts/reveal_jobs.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./auth.ts";

export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v7()`), // = event_id (v7 → sortable by occurrence)
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 60 }).notNull(), // reveal.completed | credits.changed | reveal.job.progress …
    payload: jsonb("payload").notNull().default({}), // PII-free DTO
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: varchar("last_error", { length: 500 }),
  },
  (t) => ({
    // The relay drain path: oldest pending first.
    byStatusOccurred: index("idx_event_outbox_status_occurred").on(t.status, t.occurredAt),
    statusEnum: check(
      "event_outbox_status_enum",
      sql`${t.status} IN ('pending','published','failed')`,
    ),
  }),
);
