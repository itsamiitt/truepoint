// provenanceEvent.ts — Drizzle table object for `provenance_event`, the field-grain assertion log behind
// docs/strategy/08-architecture.md invariant 1 ("nothing writes to the materialized graph except through a
// provenance_event") and outcome A-01.
//
// NOT re-exported from schema/index.ts — deliberately, following the schema/forge.ts precedent. The table is
// PARTITIONED BY RANGE (recorded_at), which Drizzle cannot express, so migration 0089 is HAND-AUTHORED and
// `drizzle-kit generate` must never emit DDL for it. drizzle.config.ts points at schema/index.ts, so keeping
// this file out of that barrel is what guarantees generate never sees it. Repositories import this module
// directly (insert/select take the table object) exactly as the forge repositories do.
//
// STATUS: DDL only. Nothing reads or writes this table until S-04 lands the repository and S-06 flips
// PROVENANCE_EVENTS_ENABLED. The definitions below therefore describe the target, not current behaviour.
//
// ACCESS MODEL: system-owned, isolated by ACCESS PATH not RLS — it holds Layer-0 events and Layer 0 has no
// workspace_id to write a fail-closed predicate over (rls/masterGraph.sql). leadwolf_app is REVOKE'd from it
// in applyMigrations.ts GRANTS; leadwolf_er holds SELECT/INSERT/UPDATE. See rls/provenanceEvent.sql for the
// append-only trigger, which refuses every mutation for EVERY role including the owner.
//
// IDEMPOTENCY IS AN UPSTREAM CONTRACT, not an index. A partitioned table's unique indexes must include the
// partition key, which would turn "one event per assertion" into "one event per replay timestamp" — the trap
// 0085 documents for provider_calls. Instead: source_records.content_hash is UNIQUE and unpartitioned, so an
// identical payload never mints a second source_record, and the event append MUST be skipped when
// appendSourceRecord conflicted rather than inserted. That contract needs a test (S-04), not a comment.

import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sourceRecords } from "./masterGraph.ts";

export const provenanceEvent = pgTable(
  "provenance_event",
  {
    id: uuid("id").notNull().default(sql`uuid_generate_v7()`),
    // ── what is asserted, at FIELD grain ──────────────────────────────────────────────────────────────────
    entityType: varchar("entity_type", { length: 20 }).notNull(),
    // master_*.id for Layer 0, contacts.id/accounts.id for the overlay. No FK by design: it spans both layers
    // and stays re-pointable when an ER merge moves the assertion to a survivor.
    entityId: uuid("entity_id").notNull(),
    field: varchar("field", { length: 50 }).notNull(), // 'jobTitle' | 'primary_domain' | '*' (whole-entity)
    action: varchar("action", { length: 20 }).notNull(),
    // ── where it came from: the five-tuple invariant 1 requires ───────────────────────────────────────────
    sourceType: varchar("source_type", { length: 30 }).notNull(),
    sourceName: varchar("source_name", { length: 50 }), // 'zoominfo' | 'apollo'. NEVER a workspace id (C-02).
    method: varchar("method", { length: 30 }),
    // OPAQUE contributor handle. No FK, and nothing in `public` can resolve it — provenance.contributor lives
    // behind its own schema + role (0090), and withholding USAGE on that schema is the actual C-02 wall.
    contributorRef: uuid("contributor_ref"),
    // 09-compliance rule 4: anything untaggable does not enter the graph. Same vocabulary as consent_records.
    lawfulBasis: varchar("lawful_basis", { length: 30 }).notNull(),
    // ── the assertion ─────────────────────────────────────────────────────────────────────────────────────
    // {v: <normalized value>} for non-PII fields. For email/phone the payload stays {} and the value lives in
    // the encrypted channel row — a provenance log must not become a second cleartext PII store.
    payload: jsonb("payload").notNull().default({}),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    acceptanceState: varchar("acceptance_state", { length: 20 }).notNull().default("accepted"),
    // Lineage into the shipped evidence log. SET NULL, not CASCADE: retention may reap a source_record at 730d
    // and the assertion must outlive its payload (the one mutation the append-only trigger sanctions).
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, {
      onDelete: "set null",
    }),
    scopeRef: uuid("scope_ref"), // workspace_id for overlay events; NULL for Layer 0 (CHECK-enforced in 0089)
    // VALID time vs TRANSACTION time. Confidence decay (Phase 2) reads observed_at; the projection watermark
    // reads recorded_at. Conflating them is what makes a late-arriving old fact look fresh.
    observedAt: timestamp("observed_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Composite PK: a partitioned table's primary key must include the partition key.
    pk: primaryKey({ columns: [t.id, t.recordedAt] }),
    // The fold — rebuild one entity's field_provenance from its events, newest first.
    entityIdx: index("idx_prov_event_entity").on(
      t.entityType,
      t.entityId,
      t.field,
      t.recordedAt.desc(),
    ),
    // The badge (S-10) — count(DISTINCT contributor_ref) + max(observed_at), aggregated inside the DB so the
    // ref never leaves it as a value.
    badgeIdx: index("idx_prov_event_badge").on(t.entityType, t.entityId, t.observedAt.desc()),
    // Replay/dedup lookup. NON-unique on purpose — see the idempotency note in the header.
    sourceRecordIdx: index("idx_prov_event_source_record")
      .on(t.sourceRecordId, t.entityType, t.entityId, t.field)
      .where(sql`${t.sourceRecordId} IS NOT NULL`),
  }),
);
