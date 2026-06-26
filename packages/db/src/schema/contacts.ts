// contacts.ts — Drizzle schema for the per-workspace data layer: `accounts`, `contacts`, `source_imports`
// (03 §5, ADR-0006). One cohesive schema unit (exceeds the ~300-line guide by design; one table set, one
// responsibility). PII (`email`/`phone`) is encrypted at the app layer (bytea ciphertext) and masked until
// reveal; per-workspace uniqueness uses a hashed blind index since unique constraints can't run on ciphertext.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { masterCompanies, masterPersons } from "./masterGraph.ts";
import { pipelineStages } from "./pipelineStages.ts";

// Shared column idioms (kept local per the self-contained-schema convention in auth.ts).
const citext = customType<{ data: string }>({ dataType: () => "citext" });
const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ── Accounts (companies; workspace-scoped) ─────────────────────────────────────────────────────────────
export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    // overlay → Layer-0 golden bridge (ADR-0021); nullable = in-flight ER staging only (PLAN_00 C8). No
    // onDelete (03 §5.2): the bridge is re-pointable on master merge/split, not cascade-deleted.
    masterCompanyId: uuid("master_company_id").references(() => masterCompanies.id),
    name: varchar("name", { length: 255 }).notNull(),
    domain: citext("domain"), // non-PII; the per-workspace account dedup key
    linkedinCompanyUrl: varchar("linkedin_company_url", { length: 500 }),
    salesNavAccountUrl: varchar("sales_nav_account_url", { length: 500 }),
    industry: varchar("industry", { length: 100 }),
    subIndustry: varchar("sub_industry", { length: 100 }),
    employeeCount: integer("employee_count"),
    revenueRange: varchar("revenue_range", { length: 50 }),
    hqCountry: varchar("hq_country", { length: 100 }),
    hqCity: varchar("hq_city", { length: 100 }),
    // Firmographic facets for advanced search (24 §2). `technologies` = array of normalized tech slugs;
    // `fundingStage`/`companyStage` are coarse strings kept in clear for faceting; `foundedYear` → company age.
    technologies: jsonb("technologies").notNull().default([]),
    fundingStage: varchar("funding_stage", { length: 50 }),
    companyStage: varchar("company_stage", { length: 50 }),
    foundedYear: integer("founded_year"),
    icpFitScore: integer("icp_fit_score"),
    // Typed-jsonb custom-field values (ADR-0028, 03 §14): shallow-merged `existing || incoming`; validated
    // against custom_field_definitions at the app edge. GIN-indexed for facet/filter queries.
    customFields: jsonb("custom_fields").notNull().default({}),
    // Per-field provenance/confidence seam (C6, PLAN_03 §3.3 / PLAN_00 §5.3): which source/run set each
    // overlay field, for merge precedence + reconciliation against Layer-0. Empty {} until first enrichment.
    fieldProvenance: jsonb("field_provenance").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Partial bridge index — only the accounts already linked to a Layer-0 master company (overlay → golden).
    masterIdx: index("idx_accounts_master")
      .on(t.masterCompanyId)
      .where(sql`${t.masterCompanyId} IS NOT NULL`),
    // Per-workspace dedup on domain (partial — only rows that carry a domain).
    uniqWsDomain: uniqueIndex("uniq_accounts_ws_domain")
      .on(t.workspaceId, t.domain)
      .where(sql`${t.domain} IS NOT NULL`),
    icpRange: check(
      "accounts_icp_fit_range",
      sql`${t.icpFitScore} IS NULL OR ${t.icpFitScore} BETWEEN 0 AND 100`,
    ),
    customFieldsGin: index("idx_accounts_custom_fields_gin").using("gin", t.customFields),
    // GIN over the technologies array so `technology` facet filters (contains) stay index-backed.
    technologiesGin: index("idx_accounts_technologies_gin").using("gin", t.technologies),
    // Account-search sort/filter support (24/ADR-0035, company-level search): composite with workspace_id so
    // the facet/sort stays index-backed under the RLS workspace predicate (never a seq-scan).
    wsIndustryIdx: index("idx_accounts_ws_industry").on(t.workspaceId, t.industry),
    wsEmployeeIdx: index("idx_accounts_ws_employee_count").on(t.workspaceId, t.employeeCount),
    wsNameIdx: index("idx_accounts_ws_name").on(t.workspaceId, t.name),
    wsCreatedIdx: index("idx_accounts_ws_created_at").on(t.workspaceId, t.createdAt),
  }),
);

// ── Contacts (people; workspace-scoped, masked until reveal) ───────────────────────────────────────────
export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    // overlay → Layer-0 golden bridge (ADR-0021); nullable = in-flight ER staging only (PLAN_00 C8). No
    // onDelete (03 §5.2): the bridge is re-pointable on master merge/split, not cascade-deleted.
    masterPersonId: uuid("master_person_id").references(() => masterPersons.id),
    // Soft owner (24, soft-owner model): the assignable owner powering the "My prospects" / by-owner filter
    // and assign/reassign. DISTINCT from the immutable revealedByUserId (first-reveal credit owner). Visibility
    // stays workspace-wide via RLS — owner is a FILTER dimension, never a per-row access wall. SET NULL on user
    // delete (the contact stays in the workspace, just unassigned).
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    firstName: varchar("first_name", { length: 100 }),
    lastName: varchar("last_name", { length: 100 }),
    emailEnc: bytea("email_enc"), // AES-GCM ciphertext; masked until reveal
    emailBlindIndex: bytea("email_blind_index"), // HMAC(normalized email) for per-workspace uniqueness/lookup
    emailDomain: citext("email_domain"), // non-PII facet (kept in clear for faceting)
    emailStatus: varchar("email_status", { length: 20 }).notNull().default("unverified"),
    linkedinUrl: varchar("linkedin_url", { length: 500 }),
    linkedinPublicId: varchar("linkedin_public_id", { length: 255 }),
    salesNavProfileUrl: varchar("sales_nav_profile_url", { length: 500 }),
    salesNavLeadId: varchar("sales_nav_lead_id", { length: 255 }),
    jobTitle: varchar("job_title", { length: 255 }),
    seniorityLevel: varchar("seniority_level", { length: 50 }),
    department: varchar("department", { length: 100 }),
    phoneEnc: bytea("phone_enc"), // AES-GCM ciphertext; masked until reveal
    phoneStatus: varchar("phone_status", { length: 50 }),
    locationCountry: varchar("location_country", { length: 100 }),
    locationCity: varchar("location_city", { length: 100 }),
    priorityScore: integer("priority_score"), // cache of latest scores.composite_score (M4)
    outreachStatus: varchar("outreach_status", { length: 50 }).notNull().default("new"),
    // Workspace pipeline-stage assignment (G-REV-7, ADR-0028). Nullable: a contact may sit in no stage; on
    // stage delete the assignment clears (SET NULL) while outreach_status (the rollup) is left untouched.
    pipelineStageId: uuid("pipeline_stage_id").references(() => pipelineStages.id, {
      onDelete: "set null",
    }),
    isRevealed: boolean("is_revealed").notNull().default(false),
    revealedByUserId: uuid("revealed_by_user_id").references(() => users.id),
    revealedAt: timestamp("revealed_at", { withTimezone: true }),
    // When the contact's PII fields were last VERIFIED (email/phone correctness — set by verify-on-reveal and
    // by enrichment; list-plan/06 §3.3 gap). Powers `computeContactDataQuality(ageDaysSinceVerified)`: the
    // freshness sub-score + the Data Health column's freshness_status badge. NULL = never verified (cold start
    // → "aging", not punished). Distinct from `updated_at` (any write) and `last_activity_at` (outreach).
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    jurisdiction: char("jurisdiction", { length: 2 }),
    region: char("region", { length: 2 }).notNull().default("US"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    // Likely-duplicate pointer (24 data-signals): set by the dedup worker to the canonical contact this row
    // merges into; null = not a known duplicate. Powers the "find/hide probable duplicates" facet. Self-FK.
    duplicateOfContactId: uuid("duplicate_of_contact_id").references(
      (): AnyPgColumn => contacts.id,
      {
        onDelete: "set null",
      },
    ),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // DSAR tombstone (08 §4.2): set + PII nulled
    // Typed-jsonb custom-field values (ADR-0028, 03 §14): shallow-merged `existing || incoming` (03 §15.3);
    // validated against custom_field_definitions at the app edge. GIN-indexed for facet/filter queries.
    customFields: jsonb("custom_fields").notNull().default({}),
    // Per-field provenance/confidence seam (C6, PLAN_03 §3.3 / PLAN_00 §5.3): which source/run set each
    // overlay field, for merge precedence + reconciliation against Layer-0. Empty {} until first enrichment.
    fieldProvenance: jsonb("field_provenance").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Partial bridge index — only the contacts already linked to a Layer-0 master person (overlay → golden).
    masterIdx: index("idx_contacts_master")
      .on(t.masterPersonId)
      .where(sql`${t.masterPersonId} IS NOT NULL`),
    // Backfill scan/enumeration index (PLAN_07 Stage B) — the INVERSE of masterIdx: the still-unresolved, live
    // contacts the master-link backfill walks (keyset by id, per workspace) and the scheduled sweep enumerates
    // by workspace. Partial, so it stays tiny once the backlog is resolved (only NULL-bridge rows are indexed).
    unresolvedIdx: index("idx_contacts_unresolved")
      .on(t.workspaceId, t.id)
      .where(sql`${t.masterPersonId} IS NULL AND ${t.deletedAt} IS NULL`),
    // The three per-workspace dedup keys (partial unique — only where the key is present). 03 §5/§11.
    uniqWsEmail: uniqueIndex("uniq_contacts_ws_email")
      .on(t.workspaceId, t.emailBlindIndex)
      .where(sql`${t.emailBlindIndex} IS NOT NULL`),
    uniqWsLinkedin: uniqueIndex("uniq_contacts_ws_linkedin")
      .on(t.workspaceId, t.linkedinPublicId)
      .where(sql`${t.linkedinPublicId} IS NOT NULL`),
    uniqWsSalesNav: uniqueIndex("uniq_contacts_ws_salesnav")
      .on(t.workspaceId, t.salesNavLeadId)
      .where(sql`${t.salesNavLeadId} IS NOT NULL`),
    emailStatusEnum: check(
      "contacts_email_status_enum",
      sql`${t.emailStatus} IN ('unverified','valid','risky','invalid','catch_all','unknown')`,
    ),
    seniorityEnum: check(
      "contacts_seniority_enum",
      sql`${t.seniorityLevel} IS NULL OR ${t.seniorityLevel} IN ('c_suite','vp','director','manager','ic','other')`,
    ),
    outreachEnum: check(
      "contacts_outreach_status_enum",
      sql`${t.outreachStatus} IN ('new','in_sequence','replied','meeting_booked','disqualified','nurture','unsubscribed')`,
    ),
    priorityRange: check(
      "contacts_priority_range",
      sql`${t.priorityScore} IS NULL OR ${t.priorityScore} BETWEEN 0 AND 100`,
    ),
    // Reveal-ownership invariants (first reveal wins; set by the AFTER INSERT trigger in M3). 03 §5/§10.
    revealOwner: check(
      "contacts_reveal_owner",
      sql`${t.isRevealed} = (${t.revealedByUserId} IS NOT NULL)`,
    ),
    revealAt: check("contacts_reveal_at", sql`${t.isRevealed} = (${t.revealedAt} IS NOT NULL)`),
    customFieldsGin: index("idx_contacts_custom_fields_gin").using("gin", t.customFields),
    // Owner filter ("My prospects" / by-owner) — composite with workspace so the facet stays index-backed.
    ownerIdx: index("idx_contacts_ws_owner").on(t.workspaceId, t.ownerUserId),
    // Duplicate facet — partial (only rows flagged as a likely duplicate).
    duplicateIdx: index("idx_contacts_duplicate_of")
      .on(t.duplicateOfContactId)
      .where(sql`${t.duplicateOfContactId} IS NOT NULL`),
    // Per-account contact rollup (account-search contactCount/revealedContactCount, 24/ADR-0035): composite
    // with workspace_id so the correlated count subquery stays index-backed under the RLS workspace predicate.
    wsAccountIdx: index("idx_contacts_ws_account")
      .on(t.workspaceId, t.accountId)
      .where(sql`${t.accountId} IS NOT NULL`),
    // Dashboard "hot leads" read (contactRepository.topByPriority: WHERE deleted_at IS NULL AND priority_score
    // IS NOT NULL ORDER BY priority_score DESC LIMIT 5). Composite with workspace_id so it stays index-backed
    // under the RLS workspace predicate; PARTIAL on the live, scored rows only so the index is small and the
    // top-N becomes a backwards index scan instead of a seq-scan + sort (perf RC#9).
    wsPriorityIdx: index("idx_contacts_ws_priority_score")
      .on(t.workspaceId, t.priorityScore.desc())
      .where(sql`${t.deletedAt} IS NULL AND ${t.priorityScore} IS NOT NULL`),
  }),
);

// ── Source imports (per-import provenance — the ONLY lineage under ADR-0006) ───────────────────────────
// NOTE: 03 §12 targets monthly range-partitioning for this high-volume table; shipped as a plain table in
// M1 and converted when volume warrants (do not silently drop the partitioning intent).
export const sourceImports = pgTable(
  "source_imports",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    importedByUserId: uuid("imported_by_user_id").references(() => users.id),
    sourceName: varchar("source_name", { length: 50 }).notNull(),
    sourceFile: varchar("source_file", { length: 255 }),
    rawData: jsonb("raw_data").notNull().default({}),
    contentHash: bytea("content_hash"), // sha256 of the canonical payload → identical re-imports are skipped
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Identical-payload idempotency: a second import of the same content into the same workspace is a no-op.
    uniqWsContentHash: uniqueIndex("uniq_source_imports_ws_content")
      .on(t.workspaceId, t.contentHash)
      .where(sql`${t.contentHash} IS NOT NULL`),
    // Dashboard "recent imports" read (sourceImportRepository: WHERE workspace_id ... ORDER BY imported_at
    // DESC): composite with workspace_id so the recency feed stays index-backed under the RLS workspace
    // predicate instead of a seq-scan + sort on this high-volume table (perf RC#9).
    wsImportedAtIdx: index("idx_source_imports_ws_imported_at").on(
      t.workspaceId,
      t.importedAt.desc(),
    ),
    sourceNameEnum: check(
      "source_imports_source_name_enum",
      sql`${t.sourceName} IN ('apollo','zoominfo','linkedin','sales_navigator','hubspot','salesforce','clearbit','manual')`,
    ),
  }),
);
