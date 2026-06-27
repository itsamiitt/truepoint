// dataQualitySnapshots.ts — Drizzle schema for the per-workspace Data Health TREND store (10 §5 / 22, ADR-0025).
// A daily leader-locked sweep captures one row per workspace: the WorkspaceDataQuality count rollup as JSONB +
// the capture time. The live aggregate (contactRepository.dataQualitySummary) is point-in-time; these snapshots
// give the dashboard HISTORY (fill/verification/freshness over time) + a precomputed read at scale. Workspace-
// scoped (RLS like contacts, rls/dataQualitySnapshots.sql); append-only (the sweep inserts; nothing updates).

import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
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

export const dataQualitySnapshots = pgTable(
  "data_quality_snapshots",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    // The WorkspaceDataQuality count rollup at capture time (non-PII: counts + statuses only).
    metrics: jsonb("metrics").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The trend read: a workspace's snapshots newest-first (backward index scan).
    byWsCreated: index("idx_data_quality_snapshots_ws_created").on(t.workspaceId, t.createdAt),
  }),
);
