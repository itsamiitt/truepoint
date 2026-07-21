// retention.ts — Drizzle schema for the per-data-class, time-based RETENTION engine CONTROL PLANE (data-
// management backlog #6; design docs/planning/data-management/16-retention-engine-design.md, spec 08-compliance
// §7 + ADR-0025). Two tables, no deletion logic here (the sweep that reads them lives in core/workers, a later
// phase) — this is purely the policy/run store:
//   • retention_class_policies — GLOBAL, platform-managed config (one row per data class; `data_class` is the natural
//                          PK, no surrogate id — mirrors feature_flags). The app role READS it to evaluate;
//                          writes are platform-only (rls/retention.sql). SHADOW-first: every class ships `shadow`.
//   • retention_runs     — per-tenant, APPEND-ONLY audit of each sweep's outcome for ONE class (the shadow-mode
//                          evidence: candidate volume measured BEFORE any class is flipped to `enforce`).
// The class vocabulary, the disabled|shadow|enforce mode, and the conservative seed defaults are the shipped
// contract in @leadwolf/types (packages/types/src/retention.ts); the seed rows (12 in 0033_retention_engine.sql
// + the two S-CH1 channel classes in 0058_contact_channels.sql) MUST match DEFAULT_RETENTION_POLICIES exactly.
// Closed enums via the varchar + CHECK idiom this folder uses (no pgEnum).

import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants } from "./auth.ts";

// Shared column idioms (kept local per the self-contained-schema convention used across this folder).
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });

// ── retention_class_policies — GLOBAL config (one row per data class; NOT tenant-scoped, no surrogate id) ─────────
export const retentionClassPolicies = pgTable(
  "retention_class_policies",
  {
    dataClass: varchar("data_class", { length: 50 }).primaryKey(), // the class this policy governs (natural PK)
    ttlDays: integer("ttl_days"), // null = NEVER auto-delete
    mode: varchar("mode", { length: 20 }).notNull().default("shadow"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    modeEnum: check(
      "retention_class_policies_mode_enum",
      sql`${t.mode} IN ('disabled','shadow','enforce')`,
    ),
  }),
);

// ── retention_runs — per-tenant, APPEND-ONLY sweep audit (the shadow-mode evidence: "what WOULD delete") ────
export const retentionRuns = pgTable(
  "retention_runs",
  {
    id: id(),
    tenantId: tenantId(),
    dataClass: varchar("data_class", { length: 50 }).notNull(),
    mode: varchar("mode", { length: 20 }).notNull(),
    candidateCount: integer("candidate_count").notNull().default(0),
    deletedCount: integer("deleted_count").notNull().default(0), // 0 in shadow mode
    cutoff: timestamp("cutoff", { withTimezone: true }), // null when ttlDays is null (nothing ages out)
    runStartedAt: timestamp("run_started_at", { withTimezone: true }).notNull(),
    runFinishedAt: timestamp("run_finished_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The audit read path: a tenant's runs for a class, newest-first (backward index scan).
    byTenantClass: index("idx_retention_runs_tenant_class").on(
      t.tenantId,
      t.dataClass,
      t.createdAt,
    ),
    modeEnum: check("retention_runs_mode_enum", sql`${t.mode} IN ('disabled','shadow','enforce')`),
  }),
);
