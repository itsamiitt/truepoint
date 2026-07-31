// usageEvent.ts — Drizzle table object for `usage_event`, the outcome-metric substrate behind
// docs/strategy/08-architecture.md § Instrumentation ("emit from day one") and every Phase 1 acceptance
// criterion written as a time/likelihood/count.
//
// NOT re-exported from schema/index.ts, for the same reason as provenanceEvent.ts: the table is PARTITIONED BY
// RANGE (occurred_at), which Drizzle cannot express, so migration 0092 is HAND-AUTHORED and `drizzle-kit
// generate` must never emit DDL for it. drizzle.config.ts points at schema/index.ts, so staying out of that
// barrel is what guarantees generate never sees it. Repositories import this module directly.
//
// It does NOT replace the five shipped meters (contact_reveals, credit_ledger, provider_calls, ai_requests,
// activities). Those keep metering billing and interaction; this answers the product questions none of them
// can — reveal-hit rate, reveal latency, save success, badge impressions. A metric surface and a money surface
// should never be the same rows.
//
// RLS: workspace-scoped, ENABLE + FORCE (rls/usageEvents.sql). No append-only trigger, deliberately — this is
// a metric surface, not evidence. The evidence table is provenance_event, and nothing on this path can reach it.

import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";

const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

export const usageEvent = pgTable(
  "usage_event",
  {
    id: uuid("id").notNull().default(sql`uuid_generate_v7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // SET NULL, not CASCADE: metering history must survive a member's removal, or a departing rep
    // retroactively shrinks last quarter's numbers.
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: varchar("action", { length: 50 }).notNull(),
    subjectType: varchar("subject_type", { length: 20 }),
    subjectId: uuid("subject_id"), // absent on a miss — there IS no record to point at
    // A keyed HMAC, NEVER a raw identifier. A reveal-miss records that somebody was looked for and not found;
    // storing the slug or email searched would make this a shadow database of people we hold nothing about,
    // which an opt-out cannot reach because there is no record to suppress. Sharing the blind-index key space
    // means a suppression check can still MATCH it without the log ever holding the identifier.
    subjectFingerprint: bytea("subject_fingerprint"),
    demandedFields: text("demanded_fields").array(),
    quantity: integer("quantity").notNull().default(1),
    entitlementKey: varchar("entitlement_key", { length: 50 }), // which cap this counted against; NULL = unmetered
    metadata: jsonb("metadata").notNull().default({}), // PII-free by contract
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // A partitioned table's primary key must include the partition key.
    pk: primaryKey({ columns: [t.id, t.occurredAt] }),
    capIdx: index("idx_usage_event_cap").on(t.tenantId, t.entitlementKey, t.occurredAt),
    wsIdx: index("idx_usage_event_ws").on(t.workspaceId, t.occurredAt.desc()),
    wantedIdx: index("idx_usage_event_wanted")
      .on(t.action, t.subjectFingerprint)
      .where(sql`${t.action} = 'reveal_miss'`),
  }),
);
