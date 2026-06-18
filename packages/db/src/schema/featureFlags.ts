// featureFlags.ts — Drizzle schema for the platform feature-flag system (13 §3.5, ADR-0011). Two tables:
//   • feature_flags        — GLOBAL, platform-managed flag definitions (key, description, global_enabled,
//                            default). NOT workspace-scoped. Writes are owner/withPlatformTx only; the app
//                            role gets READ-ONLY access for evaluation (see rls/featureFlags.sql).
//   • tenant_feature_flags — per-tenant on/off overrides, keyed by tenant_id (workspace-RLS-adjacent;
//                            readable by leadwolf_app under withTenantTx for in-app evaluation).
// The schemas in packages/types/src/featureFlags.ts are the source of truth for the shapes mirrored here.

import { sql } from "drizzle-orm";
import { boolean, pgTable, primaryKey, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants } from "./auth.ts";

// ── feature_flags — the global definition table. `key` is the natural primary key (a stable identifier used
// in code gates), so there is no surrogate id. Platform-managed: the customer app never writes here. ───────
export const featureFlags = pgTable("feature_flags", {
  key: varchar("key", { length: 100 }).primaryKey(),
  description: varchar("description", { length: 500 }),
  globalEnabled: boolean("global_enabled").notNull().default(false),
  // The fallback when neither global_enabled nor a tenant override decides. Column name "default" is quoted
  // by Drizzle; exposed in TS as `defaultEnabled` to avoid the reserved word.
  defaultEnabled: boolean("default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── tenant_feature_flags — per-tenant override. Composite PK (flag_key, tenant_id): one override per pair.
// FK to feature_flags.key cascades so deleting a flag removes its overrides; FK to tenants cascades on
// tenant delete. tenant_id is the RLS scope key (rls/featureFlags.sql). ───────────────────────────────────
export const tenantFeatureFlags = pgTable(
  "tenant_feature_flags",
  {
    flagKey: varchar("flag_key", { length: 100 })
      .notNull()
      .references(() => featureFlags.key, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.flagKey, t.tenantId] }),
  }),
);
