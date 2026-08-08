// masterTechnology.ts — Drizzle schema for the Layer-0 technology/product catalog: the system-owned
// vocabulary that `master_companies.technographics` (a jsonb blob) could never be.
// Five tables: master_technologies, master_technology_categories, master_technology_aliases,
// master_technology_vendors, master_technology_features.
//
// Design + validation: docs/planning/intelligence-platform/03-target-architecture.md §2.1 (Group A/B),
// 04-validation.md. Outcomes: [S-04] targeting precision, [S-13] change detection, [A-01] per-value provenance.
//
// IMPORTANT — Layer 0 is SYSTEM-OWNED, NOT workspace-RLS-scoped, exactly like masterGraph.ts: no tenant_id,
// no workspace_id, no owner, no visibility. Isolation is structural (by access path — leadwolf_app holds no
// grant), never an RLS predicate. Do NOT add the tenancy factories here.
//
// NAMING IS FAIL-CLOSED ON PURPOSE. Every table here carries the `master_` prefix so the convention-based
// catch-all in applyMigrations.ts GRANTS ("REVOKE ALL ON public.%I FROM leadwolf_app" for every
// `tablename ~ '^master_'`) covers it even if someone forgets the explicit REVOKE list. A Layer-0 table named
// `technology_categories` would have been auto-GRANTed by ALTER DEFAULT PRIVILEGES and silently readable by
// the customer app role. The prefix is the fail-closed default; the explicit list is the belt.
//
// THE ADOPTION EDGE IS NOT HERE. `master_technology_adoptions` (company↔technology, the large table) is
// PARTITIONED BY RANGE and therefore lives in its own module with a HAND-AUTHORED migration, following the
// provenanceEvent.ts precedent — Drizzle cannot express partitioning and must never emit DDL for it.
//
// DEFERRED (do not add): technology_versions. Versions multiply cardinality and no listed outcome needs
// version-level displacement; `cpe23` already encodes a version where one exists. 03 §2.1.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { masterCompanies } from "./masterGraph.ts";

// Shared column idioms, kept local per the self-contained-schema convention (contacts.ts/masterGraph.ts).
const citext = customType<{ data: string }>({ dataType: () => "citext" });
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ── master_technology_categories (the category tree) ──────────────────────────────────────────────────────
// Adjacency list, not ltree: ltree needs an extension this database does not bootstrap, and the tree is two
// or three levels deep with a few hundred nodes. A recursive CTE over a few hundred rows is free; adding an
// extension to avoid it is not. Revisit only if the taxonomy grows a deep, hot subtree query.
export const masterTechnologyCategories = pgTable(
  "master_technology_categories",
  {
    id: id(),
    name: varchar("name", { length: 120 }).notNull(),
    slug: citext("slug").notNull(),
    // Self-FK. No onDelete: deleting a parent must not silently orphan or cascade away its children.
    parentId: uuid("parent_id").references((): AnyPgColumn => masterTechnologyCategories.id),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqSlug: uniqueIndex("uniq_master_technology_categories_slug").on(t.slug),
    parentIdx: index("idx_master_technology_categories_parent").on(t.parentId),
  }),
);

// ── master_technologies (the catalog) ─────────────────────────────────────────────────────────────────────
// `slug` is the natural key. cpe23 / wikidata_qid are OPTIONAL EXTERNAL keys, never the primary one: CPE
// entries are typically minted only when a CVE is filed, so coverage of martech/SaaS/industrial tooling is
// thin (01-research.md R10). A schema that keyed on CPE would be unable to represent most of its own catalog.
//
// `kind` is the product/technology discriminator (03 Group B): research found NO established B2B
// product-intelligence entity model, and a vendor's product IS an adopter's technology seen from the other
// end. One catalog, one ER path, one alias table — instead of a parallel hierarchy invented on no evidence.
export const masterTechnologies = pgTable(
  "master_technologies",
  {
    id: id(),
    canonicalName: varchar("canonical_name", { length: 200 }).notNull(),
    slug: citext("slug").notNull(),
    kind: varchar("kind", { length: 20 }).notNull().default("technology"),
    description: text("description"),
    categoryId: uuid("category_id").references(() => masterTechnologyCategories.id),
    // Pre-ER hint only. The AUTHORITY on who owns/created a technology is master_technology_vendors, which is
    // SCD2; this column exists so an unresolved catalog row still carries the string it arrived with.
    vendorDomain: citext("vendor_domain"),
    isOpenSource: boolean("is_open_source"),
    isSaas: boolean("is_saas"),
    pricingModel: varchar("pricing_model", { length: 20 }).array().notNull().default(sql`'{}'`),
    cpe23: varchar("cpe23", { length: 255 }),
    wikidataQid: varchar("wikidata_qid", { length: 32 }),
    // Stack relationships. Arrays of technology ids rather than a link table: they are read whole (the
    // Technology Profile renders the full set), never filtered on individually, and a 3-row link table per
    // technology would triple the row count of the catalog for no query we actually run.
    impliesTechIds: uuid("implies_tech_ids").array().notNull().default(sql`'{}'`),
    requiresTechIds: uuid("requires_tech_ids").array().notNull().default(sql`'{}'`),
    excludesTechIds: uuid("excludes_tech_ids").array().notNull().default(sql`'{}'`),
    // ER blocking key, same posture as master_persons/master_companies. INDEXED SINCE 0106 — the index is
    // HAND-AUTHORED there, not declared here, because CREATE INDEX CONCURRENTLY cannot run inside a
    // transaction block and Drizzle emits a plain, blocking CREATE INDEX for a schema-declared index.
    // Do not "fix" this by adding an index() entry.
    blockKey: varchar("block_key", { length: 255 }),
    fieldProvenance: jsonb("field_provenance").notNull().default({}),
    provHwm: timestamp("prov_hwm", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqSlug: uniqueIndex("uniq_master_technologies_slug").on(t.slug),
    // Partial: most catalog rows will never have a CPE, and a plain UNIQUE would be a wall of NULLs.
    uniqCpe: uniqueIndex("uniq_master_technologies_cpe")
      .on(t.cpe23)
      .where(sql`${t.cpe23} IS NOT NULL`),
    uniqWikidata: uniqueIndex("uniq_master_technologies_wikidata")
      .on(t.wikidataQid)
      .where(sql`${t.wikidataQid} IS NOT NULL`),
    kindEnum: check(
      "master_technologies_kind_enum",
      sql`${t.kind} IN ('technology','product','service')`,
    ),
    categoryIdx: index("idx_master_technologies_category").on(t.categoryId),
  }),
);

// ── master_technology_aliases ─────────────────────────────────────────────────────────────────────────────
// The ER resolution path for incoming free-text technology names. citext so "SAP" and "sap" collapse without
// a functional index.
export const masterTechnologyAliases = pgTable(
  "master_technology_aliases",
  {
    id: id(),
    technologyId: uuid("technology_id")
      .notNull()
      .references(() => masterTechnologies.id, { onDelete: "cascade" }),
    alias: citext("alias").notNull(),
    aliasType: varchar("alias_type", { length: 20 }), // rename | abbreviation | misspelling | locale
    sourceName: varchar("source_name", { length: 50 }),
    createdAt: createdAt(),
  },
  (t) => ({
    // An alias may legitimately be ambiguous across technologies ("Atlas" is several products), so the
    // uniqueness is per (alias, technology) — not global. Resolution ranks candidates; it does not assume one.
    uniqAlias: uniqueIndex("uniq_master_technology_aliases").on(t.alias, t.technologyId),
    aliasLookupIdx: index("idx_master_technology_aliases_lookup").on(t.alias),
    aliasTypeEnum: check(
      "master_technology_aliases_type_enum",
      sql`${t.aliasType} IS NULL OR ${t.aliasType} IN ('rename','abbreviation','misspelling','locale')`,
    ),
  }),
);

// ── master_technology_vendors (who made it / who owns it now) ─────────────────────────────────────────────
// SCD2 so an ACQUISITION NEVER REWRITES HISTORY: when vendor A is acquired by B, close A's current_owner row
// (ended_on = acquisition date) and insert B's. A's `creator` row stays open-ended and untouched forever.
// started_on defaults to '-infinity' — the same "start unknown" sentinel master_employment uses, so two
// unknown-start rows for the same (technology, company, relationship) COLLIDE under the unique instead of
// silently duplicating.
//
// This link is what turns a flat technographic lookup into competitive intelligence: "every company using
// anything vendor V makes" is a join, not a data project. Most incumbents model company→technology only.
export const masterTechnologyVendors = pgTable(
  "master_technology_vendors",
  {
    id: id(),
    technologyId: uuid("technology_id")
      .notNull()
      .references(() => masterTechnologies.id, { onDelete: "cascade" }),
    masterCompanyId: uuid("master_company_id")
      .notNull()
      .references(() => masterCompanies.id, { onDelete: "cascade" }),
    relationship: varchar("relationship", { length: 20 }).notNull(),
    startedOn: date("started_on").notNull().default(sql`'-infinity'`),
    endedOn: date("ended_on"),
    sourceName: varchar("source_name", { length: 50 }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    relationshipEnum: check(
      "master_technology_vendors_relationship_enum",
      sql`${t.relationship} IN ('creator','current_owner','former_owner')`,
    ),
    confidenceRange: check(
      "master_technology_vendors_confidence_range",
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
    endedAfterStarted: check(
      "master_technology_vendors_ended_after_started",
      sql`${t.endedOn} IS NULL OR ${t.endedOn} >= ${t.startedOn}`,
    ),
    uniqLink: uniqueIndex("uniq_master_technology_vendors_link").on(
      t.technologyId,
      t.masterCompanyId,
      t.relationship,
      t.startedOn,
    ),
    // At most ONE open current_owner per technology — DB-enforced, so two concurrent writers can never both
    // win the ownership slot. Mirrors uniq_employment_primary in masterGraph.ts.
    uniqCurrentOwner: uniqueIndex("uniq_master_technology_current_owner")
      .on(t.technologyId)
      .where(sql`${t.relationship} = 'current_owner' AND ${t.endedOn} IS NULL`),
    // The competitive-intelligence direction: vendor -> everything they make.
    companyIdx: index("idx_master_technology_vendors_company").on(
      t.masterCompanyId,
      t.relationship,
    ),
  }),
);

// ── master_technology_features (the Product Profile's feature list) ───────────────────────────────────────
// Rows are expected only where master_technologies.kind = 'product'. Not CHECK-enforced: `kind` can change
// as a catalog row is refined, and a constraint that deletes evidence on reclassification is worse than a
// few orphan-ish rows. The read path filters by kind.
export const masterTechnologyFeatures = pgTable(
  "master_technology_features",
  {
    id: id(),
    technologyId: uuid("technology_id")
      .notNull()
      .references(() => masterTechnologies.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    sourceName: varchar("source_name", { length: 50 }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqFeature: uniqueIndex("uniq_master_technology_features").on(t.technologyId, t.name),
  }),
);
