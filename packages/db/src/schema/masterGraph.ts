// masterGraph.ts — Drizzle schema for the Layer-0 master graph: the system-owned "golden" prospect↔company
// universe (03 §5.1, ADR-0021; prospect-company-data PLAN_01 entities + PLAN_02 affiliation edge + PLAN_03
// provenance seam). Seven tables: master_companies, master_persons, master_employment, master_emails,
// master_phones, source_records, match_links.
//
// IMPORTANT — Layer 0 is SYSTEM-OWNED, NOT workspace-RLS-scoped (PLAN_00 C7, PLAN_01 §5, ADR-0021:33-35):
// none of these tables carry tenant_id/workspace_id/owner/visibility. Isolation is structural (by access path —
// no direct grant to leadwolf_app), never an RLS predicate. Do NOT add the tenancy factories here; that is a
// deliberate inversion of the Layer-1 overlay (contacts.ts), not an omission to "fix".
//
// PII (email/phone) lives only in the normalized channel tables (master_emails/master_phones) as bytea
// ciphertext + an HMAC blind index; the blind index is the GLOBAL dedup + DSAR/suppression lookup key.
//
// DEFERRED (do not add): the pg_trgm GIN fuzzy-name indexes (03:407 on name_normalized, 03:425 on full_name)
// are intentionally NOT built — pg_trgm is not bootstrapped, OpenSearch owns user fuzzy search, and the trgm
// GIN is scale-track / ER-blocking-only (PLAN_01 §6 scale-gate, C9, ADR-0021:72-73). Per-table notes below.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Shared column idioms (kept local per the self-contained-schema convention in contacts.ts/auth.ts). NOTE: the
// tenantId()/workspaceId() factories are deliberately omitted — Layer 0 is system-owned (PLAN_00 C7).
const citext = customType<{ data: string }>({ dataType: () => "citext" });
const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// The shared seniority enum, reused on master_persons + master_employment (03:415-416, PLAN_02:64-66).
const SENIORITY_LEVELS = sql`('c_suite','vp','director','manager','ic','other')`;

// ── master_companies (golden company node; 03 §5.1:390-407, PLAN_01 §2.2) ──────────────────────────────────
// primary_domain (PSL eTLD+1) is the strongest company key — nullable (a citext UNIQUE admits NULL), so a
// domainless/registry-only/stealth company is representable. Free-mail guard that stops gmail.com minting a
// company is ER-owned (PLAN_02), not a column constraint.
// DEFERRED: gin_master_companies_name (trgm GIN on name_normalized, 03:407) — scale-track/ER-blocking only.
export const masterCompanies = pgTable(
  "master_companies",
  {
    id: id(),
    primaryDomain: citext("primary_domain"), // registrable domain (PSL); strongest company key (UNIQUE, nullable)
    altDomains: citext("alt_domains").array().notNull().default(sql`'{}'`), // redirects, acquired brands, country TLDs
    name: varchar("name", { length: 255 }).notNull(),
    nameNormalized: citext("name_normalized"), // legal-suffix-stripped + casefolded (no-domain fuzzy fallback)
    linkedinCompanyId: varchar("linkedin_company_id", { length: 255 }),
    // Subsidiary → parent hierarchy. Self-FK (no onDelete — a parent delete must not cascade subsidiaries away).
    parentCompanyId: uuid("parent_company_id").references((): AnyPgColumn => masterCompanies.id),
    industry: varchar("industry", { length: 100 }),
    subIndustry: varchar("sub_industry", { length: 100 }),
    employeeCount: integer("employee_count"), // raw value
    employeeBand: varchar("employee_band", { length: 20 }), // band ('11-50','51-200',…) = the search facet
    revenueRange: varchar("revenue_range", { length: 50 }),
    technographics: jsonb("technographics").notNull().default({}), // detected tech stack (BuiltWith/HG Insights)
    hqCountry: varchar("hq_country", { length: 100 }),
    hqCity: varchar("hq_city", { length: 100 }),
    dataQualityScore: integer("data_quality_score"),
    region: char("region", { length: 2 }),
    jurisdiction: char("jurisdiction", { length: 2 }),
    // [RESERVED, leave UNINDEXED — PLAN_01 §2.8] ER blocking key (e.g. name word-n-gram); reserved at freeze so
    // the deferred scale-track blocking switches on without a destructive migration. Unread at MVP.
    blockKey: varchar("block_key", { length: 255 }),
    // [C6 seam — PLAN_03 §3.2] per-field winning-descriptor map. App-edge-validated JSONB (no DB CHECK), holds no
    // PII; populated by the Phase-3 survivorship projector. prov_hwm is the monotonic re-projection guard.
    fieldProvenance: jsonb("field_provenance").notNull().default({}),
    provHwm: timestamp("prov_hwm", { withTimezone: true }), // max(source_records.ingested_at) seen by last projection
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqPrimaryDomain: uniqueIndex("uniq_master_companies_primary_domain")
      .on(t.primaryDomain)
      .where(sql`${t.primaryDomain} IS NOT NULL`),
    uniqLinkedinCompany: uniqueIndex("uniq_master_companies_linkedin")
      .on(t.linkedinCompanyId)
      .where(sql`${t.linkedinCompanyId} IS NOT NULL`),
    dataQualityRange: check(
      "master_companies_data_quality_range",
      sql`${t.dataQualityScore} IS NULL OR ${t.dataQualityScore} BETWEEN 0 AND 100`,
    ),
  }),
);

// ── master_persons (golden person node; 03 §5.1:409-426, PLAN_01 §2.3) ─────────────────────────────────────
// linkedin_public_id is the strongest person key (UNIQUE). current_company_id is a DENORMALIZED cache of the
// is_current/is_primary employment edge (PLAN_02 §2.2), never hand-set. has_email/has_phone are precomputed
// boolean facets so masked search never joins the channel tables (and channel PII is never reachable from them).
// is_suppressed mirrors global suppression/objection state and gates reveal (08 §3); set by the DSAR fan-out.
// DEFERRED: gin_master_persons_name (trgm GIN on full_name, 03:425) — scale-track/ER-blocking only.
export const masterPersons = pgTable(
  "master_persons",
  {
    id: id(),
    linkedinPublicId: varchar("linkedin_public_id", { length: 255 }), // strongest person key (UNIQUE, nullable)
    fullName: varchar("full_name", { length: 255 }),
    firstName: varchar("first_name", { length: 100 }),
    lastName: varchar("last_name", { length: 100 }),
    // Denormalized current-company pointer (the is_current/is_primary edge's company). No onDelete — recomputed.
    currentCompanyId: uuid("current_company_id").references(() => masterCompanies.id),
    jobTitle: varchar("job_title", { length: 255 }),
    seniorityLevel: varchar("seniority_level", { length: 50 }),
    department: varchar("department", { length: 100 }),
    locationCountry: varchar("location_country", { length: 100 }),
    locationCity: varchar("location_city", { length: 100 }),
    hasEmail: boolean("has_email").notNull().default(false), // precomputed search facets (no channel join at query time)
    hasPhone: boolean("has_phone").notNull().default(false),
    dataQualityScore: integer("data_quality_score"),
    isSuppressed: boolean("is_suppressed").notNull().default(false), // global suppression mirror; gates reveal (08 §3)
    region: char("region", { length: 2 }),
    jurisdiction: char("jurisdiction", { length: 2 }),
    blockKey: varchar("block_key", { length: 255 }), // [RESERVED, UNINDEXED — PLAN_01 §2.8] ER blocking key
    fieldProvenance: jsonb("field_provenance").notNull().default({}), // [C6 seam — PLAN_03 §3.2]
    provHwm: timestamp("prov_hwm", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqLinkedinPublic: uniqueIndex("uniq_master_persons_linkedin")
      .on(t.linkedinPublicId)
      .where(sql`${t.linkedinPublicId} IS NOT NULL`),
    seniorityEnum: check(
      "master_persons_seniority_enum",
      sql`${t.seniorityLevel} IS NULL OR ${t.seniorityLevel} IN ${SENIORITY_LEVELS}`,
    ),
    dataQualityRange: check(
      "master_persons_data_quality_range",
      sql`${t.dataQualityScore} IS NULL OR ${t.dataQualityScore} BETWEEN 0 AND 100`,
    ),
    // 03:426 — person → current-company lookups + the denorm-pointer back-scan stay index-backed.
    companyIdx: index("idx_master_persons_company").on(t.currentCompanyId),
  }),
);

// ── master_employment (the person↔company affiliation EDGE; 03 §5.1:428-436 EXTENDED by PLAN_02 §0.1) ───────
// SCD2 grain: one row per (person, company) stint, a DERIVED PROJECTION over the immutable source_records →
// match_links log. started_on defaults to '-infinity' (sentinel = "start unknown") so two unknown-start stints
// for the same pair COLLIDE under the dedup unique → merge to one edge (no NULL-pair duplicates; a real boomerang
// has distinct known starts → distinct rows). is_primary is the ONE edge driving current_company_id, DB-enforced
// to at most one per person. The thin {asserting_source, match_method, confidence, source_count, observed_at,
// last_verified_at} cache is the U2 provenance seam (PLAN_02 §0.2); truth lives in source_records + match_links.
export const masterEmployment = pgTable(
  "master_employment",
  {
    id: id(),
    masterPersonId: uuid("master_person_id")
      .notNull()
      .references(() => masterPersons.id, { onDelete: "cascade" }), // DSAR blast radius (PLAN_02 §4)
    masterCompanyId: uuid("master_company_id")
      .notNull()
      .references(() => masterCompanies.id, { onDelete: "cascade" }),
    // ── affiliation facts (as planned, 03:432) ──
    title: varchar("title", { length: 255 }),
    department: varchar("department", { length: 100 }),
    seniorityLevel: varchar("seniority_level", { length: 50 }), // reuse the person enum (03:415-416)
    // ── SCD2 validity + current/primary state (H1/H2) ──
    isCurrent: boolean("is_current").notNull().default(true), // ≥1 may be true/person (concurrent affiliations)
    isPrimary: boolean("is_primary").notNull().default(false), // the ONE edge that drives current_company_id
    startedOn: date("started_on").notNull().default(sql`'-infinity'`), // sentinel = "start unknown" → dedup collides
    endedOn: date("ended_on"), // NULL while current
    // ── derived provenance cache (U2 seam; TRUTH is source_records + match_links) ──
    assertingSource: varchar("asserting_source", { length: 50 }), // winning source_name
    matchMethod: varchar("match_method", { length: 20 }), // deterministic_domain|deterministic_email|fuzzy_name_company|manual
    confidence: numeric("confidence", { precision: 4, scale: 3 }), // Fellegi-Sunter (03:478)
    sourceCount: integer("source_count").notNull().default(1), // corroboration (# accepted source_records agreeing)
    observedAt: timestamp("observed_at", { withTimezone: true }), // the single transaction-time field (1.5-temporal)
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }), // freshness decay hook (ADR-0025; Phase 6)
    fieldProvenance: jsonb("field_provenance").notNull().default({}), // [C6 seam — PLAN_03 §3.2; the edge's own map]
    provHwm: timestamp("prov_hwm", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    seniorityEnum: check(
      "master_employment_seniority_enum",
      sql`${t.seniorityLevel} IS NULL OR ${t.seniorityLevel} IN ${SENIORITY_LEVELS}`,
    ),
    confidenceRange: check(
      "master_employment_confidence_range",
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
    endedAfterStarted: check(
      "master_employment_ended_after_started",
      sql`${t.endedOn} IS NULL OR ${t.endedOn} >= ${t.startedOn}`, // a stint cannot end before it starts
    ),
    primaryIsCurrent: check(
      "master_employment_primary_is_current",
      sql`${t.isPrimary} = false OR ${t.isCurrent} = true`, // a primary edge MUST be current
    ),
    // Edge dedup identity (PLAN_02 §0.1): one edge per stint; unknown-start pairs collide via the '-infinity' sentinel.
    uniqStint: uniqueIndex("uniq_employment_stint").on(
      t.masterPersonId,
      t.masterCompanyId,
      t.startedOn,
    ),
    // At most ONE primary edge per person — DB-enforced so concurrent writers can never both win the primary slot.
    uniqPrimary: uniqueIndex("uniq_employment_primary")
      .on(t.masterPersonId)
      .where(sql`${t.isPrimary}`),
    // Hot read: person → current affiliation(s). Partial → ≈1 row/person, tiny + cache-warm (03:436 retained).
    currentIdx: index("idx_employment_current").on(t.masterPersonId).where(sql`${t.isCurrent}`),
    // Reverse: company → its current people. Admin/recompute/cursor scans ONLY — never the OLTP hot path (§5).
    companyIdx: index("idx_employment_company").on(t.masterCompanyId).where(sql`${t.isCurrent}`),
  }),
);

// ── master_emails (verifiable email channel; 03 §5.1:438-449, PLAN_01 §2.4) ────────────────────────────────
// Separated from the person row: one row per (person, email value). email_enc is AES-GCM ciphertext, decrypted
// only in the paid-reveal tx. email_blind_index is HMAC(normalized email) and is GLOBALLY UNIQUE — the dedup +
// DSAR/suppression lookup key (concurrent ingests of the same value can't double-insert). Channels keep their
// native source_count/last_verified_at/status (the retained scoped instance of D; PLAN_03 §3.6) and are
// referenced-not-duplicated by the field_provenance map (OQ5), so PII never enters the JSONB map in clear.
export const masterEmails = pgTable(
  "master_emails",
  {
    id: id(),
    masterPersonId: uuid("master_person_id")
      .notNull()
      .references(() => masterPersons.id, { onDelete: "cascade" }),
    emailEnc: bytea("email_enc").notNull(), // AES-GCM ciphertext; revealed only via the paid-reveal path
    emailBlindIndex: bytea("email_blind_index").notNull(), // HMAC; GLOBAL dedup + DSAR/suppression key (UNIQUE)
    emailDomain: citext("email_domain"),
    emailStatus: varchar("email_status", { length: 20 }).notNull().default("unverified"),
    sourceCount: integer("source_count").notNull().default(1), // corroboration (survivorship input)
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    verificationSource: varchar("verification_source", { length: 50 }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(), // channel rows are append-only — no updated_at (PLAN_01 §2.8)
  },
  (t) => ({
    uniqBlindIndex: uniqueIndex("uniq_master_emails_blind_index").on(t.emailBlindIndex),
    emailStatusEnum: check(
      "master_emails_email_status_enum",
      sql`${t.emailStatus} IN ('unverified','valid','risky','invalid','catch_all','unknown')`,
    ),
  }),
);

// ── master_phones (verifiable phone channel; 03 §5.1:451-459, PLAN_01 §2.4) ────────────────────────────────
// One row per (person, phone value). phone_blind_index is HMAC over the E.164-normalized number, GLOBALLY UNIQUE
// (dedup + DSAR key). Same channel posture as master_emails.
export const masterPhones = pgTable(
  "master_phones",
  {
    id: id(),
    masterPersonId: uuid("master_person_id")
      .notNull()
      .references(() => masterPersons.id, { onDelete: "cascade" }),
    phoneEnc: bytea("phone_enc").notNull(), // AES-GCM ciphertext
    phoneBlindIndex: bytea("phone_blind_index").notNull(), // HMAC over E.164 (libphonenumber-normalized) (UNIQUE)
    lineType: varchar("line_type", { length: 20 }), // direct|mobile|hq|unknown
    phoneStatus: varchar("phone_status", { length: 50 }),
    sourceCount: integer("source_count").notNull().default(1),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: createdAt(), // append-only
  },
  (t) => ({
    uniqBlindIndex: uniqueIndex("uniq_master_phones_blind_index").on(t.phoneBlindIndex),
  }),
);

// ── source_records (the immutable per-source evidence LOG; 03 §5.1:461-471, PLAN_01 §2.5) ──────────────────
// B's backbone: append-only, never destroyed, so merges stay reversible and survivorship is recomputable.
// content_hash = sha256(canonical payload), GLOBALLY UNIQUE → idempotent ingest. resolved_*_id are set by the ER
// pipeline. source_name records the channel, NEVER a workspace (co-op data enters as source_name='coop';
// MATCH-AGAINST writes no row here — PLAN_01 §5 S2).
// NOTE: 03 §12 targets monthly range-partitioning by ingested_at (bulk cold → S3/Iceberg); shipped as a plain
// table at MVP and converted when volume warrants, exactly like source_imports (do not silently drop the
// partitioning intent).
export const sourceRecords = pgTable(
  "source_records",
  {
    id: id(),
    sourceName: varchar("source_name", { length: 50 }).notNull(), // apollo|zoominfo|clearbit|coop|public_registry|…
    contentHash: bytea("content_hash").notNull(), // sha256(canonical payload) → idempotent ingest (UNIQUE)
    rawData: jsonb("raw_data").notNull(), // verbatim source payload
    matchKeys: jsonb("match_keys").notNull().default({}), // extracted normalized keys (email_bi, domain, li_id, phone)
    resolvedPersonId: uuid("resolved_person_id").references(() => masterPersons.id), // set by the ER pipeline
    resolvedCompanyId: uuid("resolved_company_id").references(() => masterCompanies.id),
    lawfulBasisSnapshot: jsonb("lawful_basis_snapshot"),
    region: char("region", { length: 2 }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(), // partition key (deferred)
  },
  (t) => ({
    uniqContentHash: uniqueIndex("uniq_source_records_content_hash").on(t.contentHash),
    // Companion index so the employment-edge recompute is a bounded index scan over a (person, company) cluster's
    // accepted assertions, not a seq-scan of source_records (PLAN_02:106-107; co-lands with the edge, Q5).
    employmentIdx: index("idx_source_records_employment")
      .on(t.resolvedPersonId, t.resolvedCompanyId)
      .where(sql`${t.resolvedPersonId} IS NOT NULL AND ${t.resolvedCompanyId} IS NOT NULL`),
  }),
);

// ── match_links (ER output — which source_records form which golden entity; 03 §5.1:473-485, PLAN_01 §2.6) ──
// cluster_id IS the golden entity id (master_persons/master_companies.id) — there is NO separate match_clusters
// table at MVP (PLAN_01 §2.6). is_duplicate_of is the survivor link when two clusters merge — the C4 re-point
// cascade source (PLAN_02). MVP writes match_method='deterministic'/review_status='auto'; match_probability +
// 'splink' + the pending/confirmed/rejected review queue are scale-track columns present at freeze (C9).
export const matchLinks = pgTable(
  "match_links",
  {
    id: id(),
    entityType: varchar("entity_type", { length: 10 }).notNull(), // person|company
    clusterId: uuid("cluster_id").notNull(), // the golden entity id (master_persons/master_companies.id)
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => sourceRecords.id, { onDelete: "cascade" }),
    matchProbability: numeric("match_probability", { precision: 4, scale: 3 }), // Splink (Fellegi-Sunter)
    matchMethod: varchar("match_method", { length: 20 }).notNull(), // deterministic|splink|manual
    isDuplicateOf: uuid("is_duplicate_of"), // survivor link when two clusters merge (the C4 re-point source)
    reviewStatus: varchar("review_status", { length: 20 }).notNull().default("auto"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityTypeEnum: check(
      "match_links_entity_type_enum",
      sql`${t.entityType} IN ('person','company')`,
    ),
    matchProbabilityRange: check(
      "match_links_match_probability_range",
      sql`${t.matchProbability} IS NULL OR ${t.matchProbability} BETWEEN 0 AND 1`,
    ),
    reviewStatusEnum: check(
      "match_links_review_status_enum",
      sql`${t.reviewStatus} IN ('auto','pending','confirmed','rejected')`,
    ),
    // 03:485 — cluster membership lookups (which source_records form this golden entity) stay index-backed.
    clusterIdx: index("idx_match_links_cluster").on(t.entityType, t.clusterId),
  }),
);
