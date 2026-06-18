// enrichmentPolicy.ts — Drizzle schema for the per-workspace auto-enrich policy (G-ENR-1; 29 §3, 06 §4.1).
// One row per workspace (workspace_id UNIQUE): the `enabled` flag, the `triggers` allowlist
// (on_import/on_reveal/on_stale), the `field_allowlist` (which fields auto-enrich may fill), and the
// `monthly_budget_micros` cap on auto-enrich provider spend. Workspace-scoped like contacts; the closed
// enums live in @leadwolf/types and are validated at the edge, so the jsonb columns stay free-form here
// (mirrors enrichment_jobs.options / column_mapping). Shares the set_updated_at trigger via the RLS file.

import { sql } from "drizzle-orm";
import { bigint, boolean, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

// ── enrichment_policy — one auto-enrich policy per workspace ────────────────────────────────────────────
export const enrichmentPolicy = pgTable(
  "enrichment_policy",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    enabled: boolean("enabled").notNull().default(false),
    // The enabled triggers (subset of on_import/on_reveal/on_stale) — array stored as jsonb, validated by
    // @leadwolf/types at the API edge. Default [] = no trigger fires (fail-closed).
    triggers: jsonb("triggers").notNull().default([]),
    // The fields auto-enrich may fill (subset of enrichField). Default [] = no field permitted (fail-closed).
    fieldAllowlist: jsonb("field_allowlist").notNull().default([]),
    // Monthly auto-enrich provider-spend cap, in micros (the provider_calls.cost_micros unit, 06 §6).
    monthlyBudgetMicros: bigint("monthly_budget_micros", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One policy per workspace — the upsert target (unique → `uniq_` prefix, per package convention).
    uniqWorkspace: uniqueIndex("uniq_enrichment_policy_workspace").on(t.workspaceId),
  }),
);
