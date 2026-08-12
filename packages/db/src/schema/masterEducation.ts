// masterEducation.ts — Drizzle table object for `master_education`, the person↔organization EDUCATION edge
// (migration 0108). The sibling of master_employment: same substrate (a person bound to a
// master_companies node), different payload.
//
// NOT re-exported from schema/index.ts — deliberately, following the masterTechnologyAdoption/provenanceEvent
// precedent. Migration 0108 is HAND-AUTHORED (the partial unique indexes and the CITEXT column are expressed
// in SQL), and drizzle.config.ts points at schema/index.ts, so keeping this module out of that barrel is what
// guarantees `drizzle-kit generate` never emits competing DDL for it. Repositories import this module directly.
//
// ACCESS MODEL: Layer 0 — system-owned, isolated by ACCESS PATH not RLS (there is no workspace_id to write a
// fail-closed predicate over). leadwolf_app is REVOKE'd by the `^master_` convention loop in
// applyMigrations.ts, so this table is unreachable from the customer app role by construction.
//
// WHY A SEPARATE TABLE FROM master_employment (read before "unifying" them): the payloads genuinely differ —
// degree/fields_of_study/years here, title/seniority/is_primary there. One table with a type discriminator
// would NULL half the columns on every row. Every provider surveyed splits them the same way (Crunchbase
// jobs/degrees, PDL experience[]/education[], Diffbot employments[]/educations[]). They share the substrate,
// not the payload.
//
// THERE IS NO `is_alumnus` COLUMN, deliberately. Alumnus status is DERIVED from ended_on being in the past.
// Storing it would mean every graduation silently invalidates a stored value; the reverse traversal
// ("alumni of X") is a date predicate, which is why ended_on sits in idx_master_education_school.

import { sql } from "drizzle-orm";
import {
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { masterCompanies, masterPersons } from "./masterGraph.ts";

const citext = customType<{ data: string }>({ dataType: () => "citext" });

export const masterEducation = pgTable(
  "master_education",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v7()`),
    masterPersonId: uuid("master_person_id")
      .notNull()
      .references(() => masterPersons.id, { onDelete: "cascade" }), // DSAR blast radius
    // NULLABLE for the same reason master_employment.master_company_id is (0105): an education assertion
    // whose school has not yet resolved must still be recordable, or the fact is lost at the door.
    masterCompanyId: uuid("master_company_id").references(() => masterCompanies.id, {
      onDelete: "cascade",
    }),
    // The school name EXACTLY as the source gave it. Retained after resolution — it is the audit trail for
    // why this stint matched this institution, and the input to any future re-resolution.
    schoolNameRaw: varchar("school_name_raw", { length: 255 }),
    // Written by the SAME TypeScript normalizer that computes master_companies.name_normalized. Stored, not
    // an expression index: two implementations of "normalize an institution name" WILL drift.
    schoolNameNormalized: citext("school_name_normalized"),
    // ── education facts ──
    degree: varchar("degree", { length: 120 }),
    fieldsOfStudy: text("fields_of_study").array(),
    startedOn: date("started_on").notNull().default(sql`'-infinity'`), // sentinel = "start unknown" → dedup collides
    endedOn: date("ended_on"), // NULL while enrolled; a past date IS alumnus
    // ── derived provenance cache (TRUTH stays source_records + match_links) ──
    assertingSource: varchar("asserting_source", { length: 50 }),
    matchMethod: varchar("match_method", { length: 20 }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    sourceCount: integer("source_count").notNull().default(1),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    fieldProvenance: jsonb("field_provenance").notNull().default({}),
    provHwm: timestamp("prov_hwm", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Mirrors uniq_employment_stint: '-infinity' makes two "start unknown" assertions COLLIDE and dedup.
    uniqStint: uniqueIndex("uniq_education_stint")
      .on(t.masterPersonId, t.masterCompanyId, t.startedOn)
      .where(sql`${t.masterCompanyId} IS NOT NULL`),
    // NULLs are distinct, so unresolved stints need their own best-effort cover on the normalized name.
    uniqUnresolvedStint: uniqueIndex("uniq_education_unresolved_stint")
      .on(t.masterPersonId, t.schoolNameNormalized, t.startedOn)
      .where(sql`${t.masterCompanyId} IS NULL AND ${t.schoolNameNormalized} IS NOT NULL`),
    personIdx: index("idx_master_education_person").on(t.masterPersonId, t.endedOn.desc()),
    // The reverse traversal: "who are the alumni of this school".
    schoolIdx: index("idx_master_education_school")
      .on(t.masterCompanyId, t.endedOn.desc())
      .where(sql`${t.masterCompanyId} IS NOT NULL`),
    // The ER backfill work queue.
    unresolvedIdx: index("idx_master_education_unresolved")
      .on(t.schoolNameNormalized)
      .where(sql`${t.masterCompanyId} IS NULL`),
  }),
);
