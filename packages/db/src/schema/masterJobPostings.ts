// masterJobPostings.ts — Drizzle table object for `master_job_postings`, the Layer-0 hiring-intelligence
// evidence table (migration 0127; market-intelligence MI-S1). The structured FACT behind "who is hiring
// for what"; surge EVENTS (job_posting_surge / key_role_opened) live in master_signals — the
// funding/headcount fact+signal precedent verbatim. Also the evidence table behind
// detection_method='job_posting' on master_technology_adoptions.
//
// NOT re-exported from schema/index.ts — the masterHeadcount/masterSignals precedent: 0127 is
// HAND-AUTHORED (PARTITION BY HASH), and keeping this module out of the barrel guarantees
// `drizzle-kit generate` never emits competing DDL. Repositories import it directly.
//
// ACCESS MODEL: Layer 0 — system-owned, isolated by ACCESS PATH not RLS. `^master_` REVOKE loop +
// leadwolf_er PARENT grant + mirror_partition_acl, exactly as masterHeadcount documents.
//
// PARTITIONING — HASH (master_company_id), 32 static partitions, the 0114 reasoning: the dedup identity
// (company, source_name, canonical_url) must live in a partitioned unique; a feed's first sync backfills
// history (RANGE-on-date lands it in DEFAULT); hot reads are per-company. A posting is STATE, not an
// event — refreshes move last_seen_at/closed_at in place.
//
// COMPLIANCE (09 rule 3): organization facts only. Deliberately NO recruiter/contact columns; the feed
// parser strips person data before landing (market-intelligence 08 §1).
//
// PRODUCER: none — gated on D-6 (licensed postings feed, decisions.md 2026-08-19). Writer ships ready.

import { sql } from "drizzle-orm";
import { date, pgTable, primaryKey, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { masterCompanies } from "./masterGraph.ts";

export const masterJobPostings = pgTable(
  "master_job_postings",
  {
    id: uuid("id").notNull().default(sql`uuid_generate_v7()`),
    masterCompanyId: uuid("master_company_id")
      .notNull()
      .references(() => masterCompanies.id, { onDelete: "cascade" }),
    sourceName: varchar("source_name", { length: 50 }).notNull(),
    canonicalUrl: varchar("canonical_url", { length: 500 }).notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    department: varchar("department", { length: 100 }),
    seniorityLevel: varchar("seniority_level", { length: 20 }),
    location: varchar("location", { length: 200 }),
    postedAt: date("posted_at"),
    closedAt: date("closed_at"),
    evidenceRef: uuid("evidence_ref"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      name: "master_job_postings_pk",
      columns: [t.masterCompanyId, t.sourceName, t.canonicalUrl],
    }),
  }),
);
