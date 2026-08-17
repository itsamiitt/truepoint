// sourceFetchRegistry.ts — the Layer-0 URL fetch registry (migration 0118; docs/planning ecosystem work).
// One row per external target (a canonical LinkedIn/Sales-Nav URL); records WHEN we last fetched it, so the
// 30-day freshness sweep and the on-view fast path can dedup and short-circuit.
//
// WHY A NEW TABLE — nothing existing can serve this:
//   • source_records dedups on payload content_hash, so a byte-identical refetch writes NOTHING and bumps
//     no clock — it records "the content last changed on X", not "we last asked on X".
//   • provider_calls is workspace-scoped and its called_at never advances on a `hit`; the platform lane
//     deliberately writes no row there.
//   • master_*.updated_at / prov_hwm / observed_at each mean something else.
// The freshness clock must be written on the fetch ATTEMPT, independent of whether landing changed anything.
//
// ACCESS MODEL: platform-global, system-owned. leadwolf_app is REVOKEd ENTIRELY in applyMigrations — NOT
// master_*-prefixed, so the convention loop does not cover it; the explicit REVOKE is load-bearing. The
// capture route (owner conn) and the worker sweep (owner/withPrivilegedTx) are the only writers; it holds
// URLs + ids only, never PII.

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const sourceFetchRegistry = pgTable(
  "source_fetch_registry",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v7()`),
    entityKind: varchar("entity_kind", { length: 10 }).notNull(), // 'person' | 'company'
    normalizedUrl: varchar("normalized_url", { length: 500 }).notNull(), // the canonical fetch key (linkedinUrlKey)
    externalId: varchar("external_id", { length: 64 }), // linkedin member/company id or /in slug, when known
    sourceName: varchar("source_name", { length: 50 }).notNull().default("linkedin_api"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // NULL = never fetched → the 30-day sweep's primary target (NULLS FIRST). Written on the ATTEMPT.
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastOutcome: varchar("last_outcome", { length: 20 }), // ok | rejected | unavailable
    fetchCount: integer("fetch_count").notNull().default(0),
    // The landed golden ids, for back-reference from a URL to what it produced.
    resolvedPersonId: uuid("resolved_person_id"),
    resolvedCompanyId: uuid("resolved_company_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTarget: uniqueIndex("uniq_source_fetch_registry_target").on(t.entityKind, t.normalizedUrl),
    // The sweep read: per-kind, never-fetched first, then oldest. Declared here for the type layer; the
    // actual NULLS FIRST ordered index is hand-authored in 0118.
    dueIdx: index("idx_source_fetch_registry_due").on(t.entityKind, t.lastFetchedAt),
    externalIdx: index("idx_source_fetch_registry_external")
      .on(t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
  }),
);
