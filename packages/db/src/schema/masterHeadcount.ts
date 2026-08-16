// masterHeadcount.ts — Drizzle table object for `master_company_headcount`, the Layer-0 monthly headcount
// TIME SERIES (migration 0114, linkedin_api source). The structured FACT behind the company-growth read
// paths; the dated EVENT lives in master_signals (headcount_surge/headcount_decline), following the
// master_company_funding fact+signal precedent verbatim.
//
// NOT re-exported from schema/index.ts — deliberately, the masterSignals/masterEducation precedent: 0114 is
// HAND-AUTHORED (PARTITION BY HASH cannot be expressed by drizzle-kit), and keeping this module out of the
// barrel guarantees `drizzle-kit generate` never emits competing DDL. Repositories import it directly.
//
// ACCESS MODEL: Layer 0 — system-owned, isolated by ACCESS PATH not RLS. The parent AND its 32 partitions
// all match the `^master_` convention REVOKE loop in applyMigrations.ts; leadwolf_er is granted on the
// PARENT (routed DML checks the parent's privileges), and mirror_partition_acl (0102) keeps the partitions
// in agreement.
//
// PARTITIONING — HASH (master_company_id), 32 static partitions, NOT the 0103 RANGE-on-observed_at shape.
// Three forcing facts, recorded so nobody "fixes" this back:
//   1. This is an UPSERT table with a dedup identity of (company, month, job_function). A partitioned unique
//      must include the partition key — RANGE on observed_at would degrade "one row per month" into "one row
//      per refetch" (the 0085 trap evidenceRepository documents).
//   2. RANGE on month would satisfy the unique, but ensure_month_partitions (0102) creates partitions FORWARD
//      only, and every first fetch carries ~24 months of history — historical rows would land in DEFAULT and
//      permanently block later partition creation (0103's own header warning).
//   3. Every hot read is per-company (profile series, latest month) → hash pruning makes those
//      single-partition. The "who grew this month" feed does NOT scan this table — it reads master_signals.
//
// Growth windows (1m/3m/6m/1y/2y) and change_pct are NOT stored — derived with lag() over ≤25 rows per
// company at read time (the no-rollup rule); the vendor's growth block survives verbatim in
// source_records.raw_data.

import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { masterCompanies } from "./masterGraph.ts";

export const masterCompanyHeadcount = pgTable(
  "master_company_headcount",
  {
    // NOT the PK — the composite (master_company_id, month, job_function) is, because a partitioned PK must
    // include the hash key and the composite IS the upsert target. Kept as a stable row handle for tooling.
    id: uuid("id").notNull().default(sql`uuid_generate_v7()`),
    masterCompanyId: uuid("master_company_id")
      .notNull()
      .references(() => masterCompanies.id, { onDelete: "cascade" }),
    month: date("month").notNull(), // first-of-month; CHECK-enforced canonical form
    // '' = the whole-company total row. by_function rows use the vendor's function label verbatim; the
    // dimension is future-proofed (all sample payloads ship it empty) without a second table.
    jobFunction: varchar("job_function", { length: 60 }).notNull().default(""),
    employeeCount: integer("employee_count").notNull(),
    sourceName: varchar("source_name", { length: 50 }).notNull(),
    // When the VENDOR asserted this point (the fetch's as_of) — the stale-replay guard: an upsert only wins
    // when its observed_at is >= the stored one, so overlapping 25-month refetches converge and a stale
    // queued replay no-ops.
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    monthCanonical: check(
      "master_company_headcount_month_canonical",
      sql`${t.month} = date_trunc('month', ${t.month})::date`,
    ),
    countNonNegative: check("master_company_headcount_count_nonneg", sql`${t.employeeCount} >= 0`),
    // The totals sparkline/latest read: index-only per-company scan of job_function='' rows, newest first.
    // Declared here for the type layer; the ACTUAL index is hand-authored in 0114 (partitioned parent).
    totalsIdx: index("idx_master_company_headcount_totals").on(t.masterCompanyId, t.month.desc()),
  }),
);
