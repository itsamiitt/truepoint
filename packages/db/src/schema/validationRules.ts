// validationRules.ts — Drizzle schema for the GLOBAL, staff-authored CUSTOM data-quality validation rules
// (database-management-research 06). Platform-managed like retention_class_policies: the customer app role READS
// the rules to validate imports in-request (under withTenantTx), and staff WRITE them via withPlatformTx. The
// BUILT-IN checks are code constants (@leadwolf/core validation/builtins), NOT rows here — this table holds only
// the custom rules the rule-builder creates. RLS: app SELECT-only, no write policy (rls/validationRules.sql).
import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);

export const validationRules = pgTable(
  "validation_rules",
  {
    id: id(),
    name: varchar("name", { length: 120 }).notNull(),
    field: varchar("field", { length: 60 }).notNull(), // the canonical contact field key the rule checks
    checkType: varchar("check_type", { length: 30 }).notNull(), // required|email_format|regex|max_length|one_of
    config: jsonb("config").notNull().default({}), // per-check config (pattern / maxLength / allowed)
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The import pipeline reads enabled rules; the rule builder lists by field.
    byField: index("idx_validation_rules_field").on(t.field),
  }),
);
