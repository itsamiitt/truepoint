// masterPersonAttributes.ts — Layer-0 multi-value person attributes: SKILLS + LANGUAGES (migration 0116,
// linkedin_api source; docs/planning/linkedin-source-ingestion/).
//
// HISTORY, so nobody re-litigates it from half the record: intelligence-platform C6 deliberately did NOT
// build these ("serve no listed outcome"), and the 2026-08-16 landing shipped them raw-only. The HUMAN
// GATE was then opened the same day by an explicit user instruction ("make sure that there can be multiple
// languages … skills etc — plan everything accordingly"), which is the human decision C6 asked for.
// Volunteering was NOT named and stays raw-only in source_records.raw_data.
//
// Shape: one row per (person, value) — the same multi-value posture as master_person_identifiers. citext
// values so "SQL" and "sql" collapse; source_count is the corroboration counter (bumped on re-assert, the
// master_employment idiom). No positions/ordering column: LinkedIn's skill order is presentation, not fact.
//
// ACCESS MODEL: Layer 0 — system-owned, master_*-named so the ^master_ REVOKE convention loop covers both;
// leadwolf_er gets SELECT/INSERT/UPDATE (never DELETE — erasure is the audited DSAR fan-out, which DELETEs
// these rows for a suppressed subject exactly like identifier rows: a skill list is personal data).
//
// IN THE DRIZZLE BARREL on purpose (unlike masterSignals/masterEducation): nothing here needs partitioning,
// partial uniques, or hand-authored SQL, so `drizzle-kit generate` emits 0116 WITH its snapshot and the
// P-1.7 snapshot-deficit ratchet stays untouched.

import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { masterPersons } from "./masterGraph.ts";

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const masterPersonSkills = pgTable(
  "master_person_skills",
  {
    id: id(),
    masterPersonId: uuid("master_person_id")
      .notNull()
      .references(() => masterPersons.id, { onDelete: "cascade" }), // DSAR blast radius
    skill: citext("skill").notNull(), // as the source gave it; citext collapses case variants
    sourceName: varchar("source_name", { length: 50 }),
    sourceCount: integer("source_count").notNull().default(1), // corroboration (re-assert bumps)
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    // One row per (person, skill) — re-ingest converges instead of duplicating.
    uniqPersonSkill: uniqueIndex("uniq_master_person_skill").on(t.masterPersonId, t.skill),
    personIdx: index("idx_master_person_skills_person").on(t.masterPersonId),
  }),
);

export const masterPersonLanguages = pgTable(
  "master_person_languages",
  {
    id: id(),
    masterPersonId: uuid("master_person_id")
      .notNull()
      .references(() => masterPersons.id, { onDelete: "cascade" }),
    name: citext("name").notNull(), // "English", "Hindi" — citext for the same dedup reason
    // LinkedIn's five-level vocabulary, nullable (many profiles list a language with no level).
    proficiency: varchar("proficiency", { length: 30 }),
    sourceName: varchar("source_name", { length: 50 }),
    sourceCount: integer("source_count").notNull().default(1),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqPersonLanguage: uniqueIndex("uniq_master_person_language").on(t.masterPersonId, t.name),
    personIdx: index("idx_master_person_languages_person").on(t.masterPersonId),
    proficiencyEnum: check(
      "master_person_languages_proficiency_enum",
      sql`${t.proficiency} IS NULL OR ${t.proficiency} IN
          ('ELEMENTARY','LIMITED_WORKING','PROFESSIONAL_WORKING','FULL_PROFESSIONAL','NATIVE_OR_BILINGUAL')`,
    ),
  }),
);
