// masterIndustries.ts — the controlled industry taxonomy (migration 0128; market-intelligence MI-S3):
// a two-level sector→subsector tree + vendor-spelling aliases. The free-text `industry` columns remain
// the raw vendor truth; `industry_id` on master_companies/accounts is the CANONICAL node — a derived
// column resolved at landing / backfill (the current_company_id posture), never written by the fold.
//
// ACCESS: shared REFERENCE data. Writes revoked everywhere (curation = staff/migration work); SELECT
// granted to BOTH leadwolf_er (alias resolution at landing) and leadwolf_app (the facet/label join runs
// inside tenant transactions) — see applyMigrations.ts for why this deliberately differs from
// master_signal_types.

import { sql } from "drizzle-orm";
import { customType, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);

export const masterIndustries = pgTable("master_industries", {
  id: id(),
  parentId: uuid("parent_id"),
  code: varchar("code", { length: 50 }).notNull().unique(),
  label: varchar("label", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const masterIndustryAliases = pgTable("master_industry_aliases", {
  id: id(),
  industryId: uuid("industry_id")
    .notNull()
    .references(() => masterIndustries.id, { onDelete: "cascade" }),
  alias: citext("alias").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
