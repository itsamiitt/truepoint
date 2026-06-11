// contacts.ts — Drizzle schema for the per-workspace data layer: `accounts`, `contacts`, `source_imports`
// (03 §5, ADR-0006). One cohesive schema unit (exceeds the ~300-line guide by design; one table set, one
// responsibility). PII (`email`/`phone`) is encrypted at the app layer (bytea ciphertext) and masked until
// reveal; per-workspace uniqueness uses a hashed blind index since unique constraints can't run on ciphertext.

import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  customType,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";

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
    icpFitScore: integer("icp_fit_score"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Per-workspace dedup on domain (partial — only rows that carry a domain).
    uniqWsDomain: uniqueIndex("uniq_accounts_ws_domain")
      .on(t.workspaceId, t.domain)
      .where(sql`${t.domain} IS NOT NULL`),
    icpRange: check(
      "accounts_icp_fit_range",
      sql`${t.icpFitScore} IS NULL OR ${t.icpFitScore} BETWEEN 0 AND 100`,
    ),
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
    isRevealed: boolean("is_revealed").notNull().default(false),
    revealedByUserId: uuid("revealed_by_user_id").references(() => users.id),
    revealedAt: timestamp("revealed_at", { withTimezone: true }),
    jurisdiction: char("jurisdiction", { length: 2 }),
    region: char("region", { length: 2 }).notNull().default("US"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // DSAR tombstone (08 §4.2): set + PII nulled
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
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
    sourceNameEnum: check(
      "source_imports_source_name_enum",
      sql`${t.sourceName} IN ('apollo','zoominfo','linkedin','sales_navigator','hubspot','salesforce','clearbit','manual')`,
    ),
  }),
);
