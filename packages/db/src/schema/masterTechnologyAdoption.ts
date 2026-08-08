// masterTechnologyAdoption.ts — Drizzle table object for `master_technology_adoptions`, the company↔technology
// adoption edge that replaces the `master_companies.technographics` jsonb blob (audit D1).
//
// NOT re-exported from schema/index.ts — deliberately, following the schema/provenanceEvent.ts precedent. The
// table is PARTITIONED BY RANGE (observed_at), which Drizzle cannot express, so migration 0101 is
// HAND-AUTHORED and `drizzle-kit generate` must never emit DDL for it. drizzle.config.ts points at
// schema/index.ts, so keeping this module out of that barrel is what guarantees generate never sees it.
// Repositories import this module directly (insert/select take the table object), exactly as the forge and
// provenance repositories do.
//
// STATUS: DDL + repository (masterTechnologyRepository). Nothing populates it yet — that waits on a licensed
// technographics feed.
//
// CORRECTION (Phase 6.5, supersedes an earlier note here): there is NO dual-write to stage against
// `master_companies.technographics`, because **nothing writes that column**. It is dead — a repo-wide grep
// finds its schema line and nothing else. The live technographic path never touches Layer 0 at all:
//   intent_signals(tech_install) -> runFirmographicRollup -> accounts.technologies (jsonb[], GIN-indexed)
//     -> accountSearchRepository `technology` facet -> the prospect filter group.
// So this table is not replacing a working column; it is the first real technographics store. What it should
// eventually supersede is that inference-from-signals rollup, which is a behavioural change to a shipped
// feature and therefore proposed rather than made. See 06-data-management-layer.md §6.5.
//
// ACCESS MODEL: Layer 0 — system-owned, isolated by ACCESS PATH not RLS (no workspace_id exists to write a
// fail-closed predicate over). leadwolf_app is REVOKE'd in applyMigrations.ts GRANTS, both explicitly and via
// the `^master_` convention loop.
//
// GRAIN IS ONE ROW PER DETECTION EPISODE, NOT ONE PER PAIR. There is deliberately NO unique on
// (company, technology, method): a technology detected, removed, then re-detected is three facts and must be
// three rows, because that sequence IS the displacement signal. A unique would also silently absorb the
// partition key and degrade to "one per pair per month" — the trap 0085 and 0089 both document. Idempotency
// is upstream: source_records.content_hash is UNIQUE and unpartitioned.

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { masterCompanies, sourceRecords } from "./masterGraph.ts";
import { masterTechnologies } from "./masterTechnology.ts";

export const masterTechnologyAdoptions = pgTable(
  "master_technology_adoptions",
  {
    id: uuid("id").notNull().default(sql`uuid_generate_v7()`),
    masterCompanyId: uuid("master_company_id")
      .notNull()
      .references(() => masterCompanies.id, { onDelete: "cascade" }),
    technologyId: uuid("technology_id")
      .notNull()
      .references(() => masterTechnologies.id, { onDelete: "cascade" }),
    // Drives BOTH the confidence weight and the decay half-life — research is explicit that decay varies by
    // source type, and a DNS record and a job posting cannot share one.
    detectionMethod: varchar("detection_method", { length: 30 }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    // NULL while live. This column IS the displacement signal.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    sourceCount: integer("source_count").notNull().default(1),
    sourceName: varchar("source_name", { length: 50 }),
    // SET NULL, not CASCADE: retention may reap a source_record and the detection must outlive its payload.
    evidenceRef: uuid("evidence_ref").references(() => sourceRecords.id, { onDelete: "set null" }),
    // VALID time (when the detection was true) — the PARTITION KEY. Deliberately not recorded_at: every read
    // is "what was true in window W", and a provider backfill landing three years of history in one day would
    // pile the whole backfill into a single recorded_at partition while the months it describes stayed empty.
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // A partitioned table's primary key must include the partition key.
    pk: primaryKey({ columns: [t.id, t.observedAt] }),
    // The query the jsonb blob could not answer: "which companies use technology X".
    technologyIdx: index("idx_tech_adoptions_technology").on(t.technologyId, t.lastSeenAt.desc()),
    // The company-profile read: "what does this company run".
    companyIdx: index("idx_tech_adoptions_company").on(t.masterCompanyId, t.technologyId),
    // Displacement scan. Partial: live detections dominate and are never looked up this way.
    removedIdx: index("idx_tech_adoptions_removed")
      .on(t.removedAt.desc(), t.technologyId)
      .where(sql`${t.removedAt} IS NOT NULL`),
  }),
);
