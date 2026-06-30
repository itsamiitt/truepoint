// projectionOutbox.ts — Drizzle schema for the survivorship-projection work queue (prospect-database-platform I1 /
// Phase 05; audit P03). When a cluster's evidence changes (new source_record, merge, unmerge, refresh), a row is
// enqueued here; the projector worker drains it and rebuilds the golden master_* record from the immutable
// source_records/match_links log. SYSTEM-OWNED Layer-0 (no tenant scope, no RLS — isolation by access path:
// leadwolf_app is REVOKE-d, leadwolf_er is GRANT-ed in applyMigrations). Written under withErTx / owner only.
import { sql } from "drizzle-orm";
import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);

export const projectionOutbox = pgTable(
  "projection_outbox",
  {
    id: id(),
    entityType: varchar("entity_type", { length: 10 }).notNull(), // person|company
    clusterId: uuid("cluster_id").notNull(), // the golden master_persons / master_companies id to re-project
    reason: varchar("reason", { length: 30 }).notNull(), // evidence_added|merge|unmerge|refresh
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending|processing|done|failed
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    // The worker claims the oldest pending rows; backward scan on the time-ordered enqueue.
    byStatus: index("idx_projection_outbox_status").on(t.status, t.enqueuedAt),
  }),
);
