// workerOutbox.ts — Drizzle schema for the TRANSACTIONAL OUTBOX (ADR-0027; worker-platform plan 15 §5 —
// Phase 3). A business transition that must ALSO publish a queue job (today: the bulk-enrichment
// awaiting_confirmation → running confirm) inserts its publish-intent here IN THE SAME tenant tx — closing
// the enqueue-after-commit gap ADR-0027 explicitly rejects (a crash between commit and enqueue used to strand
// a `running` job with no drive job in Redis; 02-root-cause-analysis §6). The workers-side relay
// (apps/workers/src/outboxRelay.ts) drains pending rows LEADERLESSLY (FOR UPDATE SKIP LOCKED — re-audit F1)
// on a continuous poll and publishes to BullMQ at-least-once; consumers dedupe by stable jobId.
//
// Tenant-scoped + RLS-enforced (rls/workerOutbox.sql — workspace isolation, like enrichment_jobs): the writer
// runs inside withTenantTx as leadwolf_app. The RELAY reads cross-tenant on the base owner connection
// (the notificationRepository precedent). Payload is the SAME PII-free queue DTO the producer used to enqueue
// directly (jobId + scope only — never rows).
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);

export const workerOutbox = pgTable(
  "worker_outbox",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    /** Publisher routing key (e.g. BULK_ENRICHMENT_DRIVE_TOPIC). Closed vocabulary in @leadwolf/types. */
    topic: varchar("topic", { length: 60 }).notNull(),
    /** The queue DTO to publish, verbatim (PII-free by contract — validated by the relay before publish). */
    payload: jsonb("payload").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending|published|failed
    /** Claim count — incremented by the relay at claim time so a poison row can't spin forever. */
    attempts: integer("attempts").notNull().default(0),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: varchar("last_error", { length: 500 }),
  },
  (t) => ({
    // The relay claims the oldest pending rows; backward scan on the time-ordered enqueue (mirrors
    // idx_projection_outbox_status).
    byStatus: index("idx_worker_outbox_status").on(t.status, t.enqueuedAt),
  }),
);
