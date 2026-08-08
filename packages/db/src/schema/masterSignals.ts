// masterSignals.ts — Drizzle table objects for the Layer-0 canonical signal store: `master_signal_types`
// (the vocabulary) and `master_signals` (the dated events). Migration 0103.
//
// NOT re-exported from schema/index.ts — deliberately, following the provenanceEvent.ts precedent.
// `master_signals` is PARTITIONED BY RANGE (observed_at), which Drizzle cannot express, so 0103 is
// HAND-AUTHORED. `master_signal_types` is authored there too rather than generated: the two are one unit
// joined by an FK, and splitting them across the generated/hand-authored boundary would leave half of a
// coupled pair inside the drizzle snapshot and half outside it. Repositories import this module directly.
//
// RELATIONSHIP TO `intent_signals` (schema/intel.ts) — they are NOT duplicates and neither replaces the other:
//   intent_signals  = tenant_id + workspace_id + contact_id scoped. A TENANT'S PRIVATE scoring input.
//   master_signals  = Layer 0, no tenant key. A CANONICAL FACT about a company or person, corroborable
//                     across tenants, carrying provenance like every other fact in the graph.
// "Acme raised a Series B" is one fact the whole platform shares; "this contact opened my email" is not.
// Audit D6 is what forced the split: intent_signals is contact-scoped with a closed 9-value CHECK enum, so a
// company-level signal could not be attached to anything and each new signal family needed a migration.
//
// THE 'intent' FAMILY IS DELIBERATELY ABSENT from the vocabulary. Of the six industry-standard signal
// families, five are company facts and are in scope; intent/content-engagement is deferred non-goal X-04 and
// carries by far the heaviest privacy weight. The family CHECK in 0103 has no 'intent' value, so adding it
// costs a migration and a decision.
//
// ACCESS MODEL: Layer 0 — system-owned, isolated by ACCESS PATH not RLS. Both tables are named master_* so
// the `^master_` convention loop in applyMigrations.ts GRANTS revokes them by default; partitions inherit the
// parent ACL via mirror_partition_acl (0102).
//
// STATUS: DDL + the launch vocabulary only. Nothing reads or writes master_signals yet.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { masterCompanies, sourceRecords } from "./masterGraph.ts";
import { masterTechnologies } from "./masterTechnology.ts";

// ── master_signal_types — the vocabulary, as ROWS not a CHECK enum ────────────────────────────────────────
// This is the fix for audit D6. The vocabulary is the part most expected to grow, and a CHECK enum makes
// growth a schema change with a deploy behind it. It also gives each type a home for its own weight and
// DECAY HALF-LIFE — research is explicit that decay varies by type: a hiring surge is stale in a quarter, a
// funding round never becomes untrue (half_life_days NULL = does not decay).
export const masterSignalTypes = pgTable(
  "master_signal_types",
  {
    code: varchar("code", { length: 50 }).primaryKey(),
    family: varchar("family", { length: 30 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    defaultWeight: integer("default_weight").notNull().default(1),
    halfLifeDays: integer("half_life_days"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    familyEnum: check(
      "master_signal_types_family_enum",
      sql`${t.family} IN ('hiring','funding','tech_change','leadership','filing','other')`,
    ),
    weightRange: check(
      "master_signal_types_weight_range",
      sql`${t.defaultWeight} BETWEEN 1 AND 10`,
    ),
    halfLifePositive: check(
      "master_signal_types_half_life_positive",
      sql`${t.halfLifeDays} IS NULL OR ${t.halfLifeDays} > 0`,
    ),
  }),
);

// ── master_signals — the dated events ─────────────────────────────────────────────────────────────────────
// Partitioned monthly on observed_at (VALID time — when the event happened), not recorded_at: every read is
// "what happened in window W", and a provider backfill landing years of history in one day would otherwise
// pile the whole backfill into a single partition while the months it describes stayed empty.
export const masterSignals = pgTable(
  "master_signals",
  {
    id: uuid("id").notNull().default(sql`uuid_generate_v7()`),
    // Polymorphic subject — NO FK is possible, since it addresses either a company or a person. Same
    // trade-off provenance_event.entity_id makes and documents: referential integrity moves to the
    // repository, and in exchange one signal store serves both entity kinds instead of two near-identical
    // tables drifting apart.
    subjectType: varchar("subject_type", { length: 10 }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    typeCode: varchar("type_code", { length: 50 })
      .notNull()
      .references((): AnyPgColumn => masterSignalTypes.code),
    headline: varchar("headline", { length: 500 }),
    // Typed per family. CARRIES NO PII, EVER — same rule as provenance_event.payload. A 'job_change' signal
    // REFERENCES a person by id; it must never embed their email or phone. Needs an itest, not a comment.
    payload: jsonb("payload").notNull().default({}),
    // Minor units + ISO-4217, so no float ever touches a currency amount.
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: char("currency", { length: 3 }),
    // The counterparty: acquirer, investor, or the new employer on a leadership move. SET NULL, not CASCADE —
    // losing the counterparty must not delete the fact that the event happened.
    relatedCompanyId: uuid("related_company_id").references(() => masterCompanies.id, {
      onDelete: "set null",
    }),
    relatedTechnologyId: uuid("related_technology_id").references(() => masterTechnologies.id, {
      onDelete: "set null",
    }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    sourceName: varchar("source_name", { length: 50 }),
    evidenceRef: uuid("evidence_ref").references(() => sourceRecords.id, { onDelete: "set null" }),
    evidenceUrl: text("evidence_url"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(), // PARTITION KEY
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.observedAt] }),
    // The profile read: one subject's timeline, newest first.
    subjectIdx: index("idx_master_signals_subject").on(
      t.subjectType,
      t.subjectId,
      t.observedAt.desc(),
    ),
    // The feed read: everything of one type in a window.
    typeIdx: index("idx_master_signals_type").on(t.typeCode, t.observedAt.desc()),
    // The counterparty direction: "every company this acquirer bought", "who moved TO this company".
    relatedCompanyIdx: index("idx_master_signals_related_company")
      .on(t.relatedCompanyId, t.observedAt.desc())
      .where(sql`${t.relatedCompanyId} IS NOT NULL`),
    subjectTypeEnum: check(
      "master_signals_subject_type_enum",
      sql`${t.subjectType} IN ('company','person')`,
    ),
    confidenceRange: check(
      "master_signals_confidence_range",
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
    amountNeedsCurrency: check(
      "master_signals_amount_needs_currency",
      sql`(${t.amountMinor} IS NULL AND ${t.currency} IS NULL)
          OR (${t.amountMinor} IS NOT NULL AND ${t.currency} IS NOT NULL)`,
    ),
  }),
);
