// masterCompanyDetail.ts — Layer-0 completeness tables (Group D): the company and person facts the audit
// found missing entirely. Four tables: master_company_locations, master_company_contact_points,
// master_company_funding, master_person_identifiers.
//
// Design 03-target-architecture.md §2.4/§2.5, validated 04-validation.md.
// Outcomes: [S-04] targeting precision · [S-09] has the person left · [A-01] per-value provenance.
//
// IMPORTANT — Layer 0 is SYSTEM-OWNED, NOT workspace-RLS-scoped, exactly like masterGraph.ts: no tenant_id,
// no workspace_id, no owner. Isolation is by ACCESS PATH (leadwolf_app holds no grant), never an RLS
// predicate. Every table is named master_* so the `^master_` convention loop in applyMigrations.ts GRANTS
// revokes it even if the explicit list is forgotten. Do NOT add the tenancy factories here.
//
// WHAT WAS WRONG (audit D7/D8)
//   D7 — company location lived ONLY at Layer 1 (`account_locations`, tenant-scoped) plus two scalars
//        (hq_city/hq_country) on master_companies. Two tenants observing the same company's offices could
//        not corroborate each other, which is the whole point of a shared graph.
//   D8 — person external identifiers were one COLUMN PER SOURCE (`linkedin_public_id`). Every new source was
//        a migration, and an identifier could not carry its own provenance.
// Both are additive fixes: nothing is dropped, and `master_persons.linkedin_public_id` STAYS (it is a hot,
// indexed, widely-referenced single-column lookup — removing it would be a wide, risky refactor for no
// outcome). Migration 0104 backfills it into the new table so the two agree.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  char,
  check,
  customType,
  date,
  index,
  integer,
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
const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ── master_company_locations (audit D7) ───────────────────────────────────────────────────────────────────
// The Layer-0 twin of the tenant-scoped `account_locations`. Both exist on purpose: the overlay row is what
// a tenant asserts about an account; this is what the graph knows about the company.
export const masterCompanyLocations = pgTable(
  "master_company_locations",
  {
    id: id(),
    masterCompanyId: uuid("master_company_id")
      .notNull()
      .references(() => masterCompanies.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 20 }).notNull(), // hq | office | plant | registered
    addressLine: varchar("address_line", { length: 255 }),
    city: varchar("city", { length: 120 }),
    region: varchar("region", { length: 120 }),
    countryCode: char("country_code", { length: 2 }),
    postalCode: varchar("postal_code", { length: 20 }),
    sourceCount: integer("source_count").notNull().default(1), // corroboration (survivorship input)
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    sourceName: varchar("source_name", { length: 50 }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    companyIdx: index("idx_master_company_locations_company").on(t.masterCompanyId, t.kind),
    // At most ONE headquarters per company — DB-enforced, mirroring uniq_employment_primary. Two sources
    // disagreeing about the HQ is a survivorship problem to resolve, not two rows to keep.
    uniqHq: uniqueIndex("uniq_master_company_hq")
      .on(t.masterCompanyId)
      .where(sql`${t.kind} = 'hq'`),
    kindEnum: check(
      "master_company_locations_kind_enum",
      sql`${t.kind} IN ('hq','office','plant','registered')`,
    ),
    confidenceRange: check(
      "master_company_locations_confidence_range",
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
  }),
);

// ── master_company_contact_points ─────────────────────────────────────────────────────────────────────────
// Switchboard numbers and generic mailboxes. Business-contact data under 09-compliance rule 3, so the value
// is stored in CLEARTEXT — unlike master_emails/master_phones, which are person channels and encrypted.
//
// BUT: `value_blind_index` exists because "generic" is a claim, not a guarantee. An `info@` mailbox is
// frequently routed to one identifiable person, and `firstname@` is a personal mailbox wearing a company
// hat. The suppression list keys on hashes, so without this column a suppressed individual could not be
// matched here at all and their address would keep re-entering the graph through the company door.
// The HMAC MUST use the same key and derivation as master_emails.email_blind_index or the two will never
// match. Populating it, and joining the suppression check in the ingest path, is Phase 6 work — the column
// exists now so that wiring is not a destructive migration later. (04-validation.md Part 3, requirement 1.)
export const masterCompanyContactPoints = pgTable(
  "master_company_contact_points",
  {
    id: id(),
    masterCompanyId: uuid("master_company_id")
      .notNull()
      .references(() => masterCompanies.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 20 }).notNull(), // switchboard | generic_email | fax
    valueNormalized: citext("value_normalized").notNull(), // E.164 for phones, lowercased for email
    valueBlindIndex: bytea("value_blind_index"), // HMAC — the suppression/DSAR lookup key (Phase 6)
    verificationStatus: varchar("verification_status", { length: 20 })
      .notNull()
      .default("unverified"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    sourceCount: integer("source_count").notNull().default(1),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    sourceName: varchar("source_name", { length: 50 }),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqPoint: uniqueIndex("uniq_master_company_contact_point").on(
      t.masterCompanyId,
      t.kind,
      t.valueNormalized,
    ),
    // Suppression/DSAR lookup by hash. Partial — the column is unpopulated until Phase 6 wires the HMAC.
    blindIndexIdx: index("idx_master_company_contact_blind_index")
      .on(t.valueBlindIndex)
      .where(sql`${t.valueBlindIndex} IS NOT NULL`),
    kindEnum: check(
      "master_company_contact_points_kind_enum",
      sql`${t.kind} IN ('switchboard','generic_email','fax')`,
    ),
    statusEnum: check(
      "master_company_contact_points_status_enum",
      sql`${t.verificationStatus} IN ('unverified','valid','risky','invalid','unknown')`,
    ),
  }),
);

// ── master_company_funding ────────────────────────────────────────────────────────────────────────────────
// The STRUCTURED FACT. Every row is also expected to have a master_signals row of family='funding' — the
// dated EVENT. Keeping both is deliberate: the company profile reads the fact ("total raised, last round"),
// the feed reads the event ("who raised this month"), and neither has to reshape the other's data.
export const masterCompanyFunding = pgTable(
  "master_company_funding",
  {
    id: id(),
    masterCompanyId: uuid("master_company_id")
      .notNull()
      .references(() => masterCompanies.id, { onDelete: "cascade" }),
    roundType: varchar("round_type", { length: 30 }),
    // Minor units + ISO-4217 so no float ever touches a currency amount.
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: char("currency", { length: 3 }),
    announcedOn: date("announced_on"),
    // SET NULL, not CASCADE: losing the investor record must not delete the fact that the round happened.
    leadInvestorCompanyId: uuid("lead_investor_company_id").references(
      (): AnyPgColumn => masterCompanies.id,
      { onDelete: "set null" },
    ),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    sourceName: varchar("source_name", { length: 50 }),
    evidenceUrl: text("evidence_url"),
    createdAt: createdAt(),
  },
  (t) => ({
    // The profile read: this company's rounds, newest first.
    companyIdx: index("idx_master_company_funding_company").on(
      t.masterCompanyId,
      t.announcedOn.desc(),
    ),
    // Dedup identity: one row per (company, round type, announcement date). Two sources reporting the same
    // Series B collapse; a genuine second round on a different date does not.
    uniqRound: uniqueIndex("uniq_master_company_funding_round").on(
      t.masterCompanyId,
      t.roundType,
      t.announcedOn,
    ),
    investorIdx: index("idx_master_company_funding_investor")
      .on(t.leadInvestorCompanyId)
      .where(sql`${t.leadInvestorCompanyId} IS NOT NULL`),
    amountNeedsCurrency: check(
      "master_company_funding_amount_needs_currency",
      sql`(${t.amountMinor} IS NULL AND ${t.currency} IS NULL)
          OR (${t.amountMinor} IS NOT NULL AND ${t.currency} IS NOT NULL)`,
    ),
    confidenceRange: check(
      "master_company_funding_confidence_range",
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
  }),
);

// ── master_person_identifiers (audit D8) ──────────────────────────────────────────────────────────────────
// One row per (type, value) instead of one COLUMN per source. `id_type` is free-form varchar rather than a
// CHECK enum for exactly the D6 reason: the set of sources is the part most expected to grow, and a closed
// enum would make every new provider a migration.
//
// `master_persons.linkedin_public_id` STAYS. This table generalizes ADDITIONAL identifiers; it does not
// replace the primary one, which is a hot indexed lookup used across the codebase. Migration 0104 backfills
// it here as id_type='linkedin_public_id' so both agree.
export const masterPersonIdentifiers = pgTable(
  "master_person_identifiers",
  {
    id: id(),
    masterPersonId: uuid("master_person_id")
      .notNull()
      .references(() => masterPersons.id, { onDelete: "cascade" }), // DSAR blast radius
    idType: varchar("id_type", { length: 40 }).notNull(),
    idValue: citext("id_value").notNull(),
    sourceName: varchar("source_name", { length: 50 }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    // GLOBALLY unique per (type, value) — this is what makes the table an ER join key rather than a bag of
    // strings, the same posture as master_emails.email_blind_index. Two persons claiming one LinkedIn id is
    // a merge to perform, not two rows to keep.
    uniqIdentifier: uniqueIndex("uniq_master_person_identifier").on(t.idType, t.idValue),
    personIdx: index("idx_master_person_identifier_person").on(t.masterPersonId),
  }),
);
