// verificationJobs.ts — Drizzle schema for the freshness re-verification AUDIT LEDGER (PLAN_06; data-management
// 09 §5 / 13 §6). One row per COMPLETED runReverification pass per workspace: the scanned/reverified/errored
// tally + the run window. Workspace-scoped (RLS like contacts, rls/verificationJobs.sql); append-only in practice
// (the reverify worker inserts; nothing updates). The freshness loop keys off contacts.last_verified_at — this
// ledger is the richer per-run observability the loop's header flagged as a follow-up, NOT the loop's watermark.

import { sql } from "drizzle-orm";
import { index, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
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

export const verificationJobs = pgTable(
  "verification_jobs",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    scanned: integer("scanned").notNull().default(0),
    reverified: integer("reverified").notNull().default(0),
    errored: integer("errored").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The "recent re-verification runs" read path, per workspace (newest-first via a backward index scan).
    byWsCreated: index("idx_verification_jobs_ws_created").on(t.workspaceId, t.createdAt),
  }),
);
