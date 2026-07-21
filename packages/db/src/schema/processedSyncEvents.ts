// processed_sync_events — the idempotent-consumer dedup table for the forge master-sync apply (docs/planning/
// forge/11 §3, G-FORGE-1108). One row per applied Forge event_id; a redelivered event conflicts and is a no-op
// (effectively-once, [S21]). System-owned Layer-0 (written under leadwolf_er, no RLS). Hand-authored migration
// 0053 (drizzle-kit generate is unsafe here).
import { sql } from "drizzle-orm";
import { customType, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

export const processedSyncEvents = pgTable("processed_sync_events", {
  eventId: uuid("event_id").primaryKey(),
  contentHash: bytea("content_hash"),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().default(sql`now()`),
});
