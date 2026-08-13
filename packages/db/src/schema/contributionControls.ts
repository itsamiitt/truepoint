// contributionControls.ts — Drizzle table objects for the Phase-4 contribution controls
// (`contribution_policy`, `contribution_exclusion`, `crm_object_contribution`, migration 0097).
//
// WHY THESE EXIST NOW. The tables shipped in 0097 as hand-authored SQL with NO TypeScript definition at all —
// the only three tables in the system with a repository (`contributionPolicyRepository`) but no `pgTable`.
// Everything that touched them went through raw `sql` templates, so a renamed column or a changed CHECK was
// caught by nothing until a query failed at runtime (audit 32 · §9.2). These definitions close that gap: the
// repository can migrate to typed queries, and a schema-parity itest can compare them against the shipped DDL.
//
// NOT re-exported from schema/index.ts — deliberately, matching masterEducation / masterTechnologyAdoption /
// provenanceEvent. Migration 0097 is hand-authored (the partial unique indexes and the multi-branch target
// CHECK are expressed in SQL), and drizzle.config.ts points at that barrel, so staying out of it is what
// guarantees `drizzle-kit generate` never emits competing DDL. Repositories import this module directly.
//
// ACCESS MODEL: Layer-1, tenant-scoped, RLS-enforced. The policies live in `rls/contributionControls.sql`.
//
// ⚠ THE CONSTRAINTS ARE THE POINT — do not "simplify" them into the application:
//   • `contribution_policy_enabled_is_attributed` — an enabled policy MUST name who turned it on and when.
//     Consent with no actor is not a consent record (CLAUDE.md rule 4 / 09 rule 5), and only a CHECK keeps
//     that true when a future writer forgets.
//   • `contribution_exclusion_target` — exactly one target column populated, matching `kind`. Without it a
//     row can claim kind='domain' while carrying only an account_id, and the reader silently excludes
//     nothing. A deny list that fails OPEN is worse than none, because the customer believes it is working.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { accounts, contacts } from "./contacts.ts";
import { crmConnections } from "./crm.ts";

const citext = customType<{ data: string }>({ dataType: () => "citext" });

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** One policy per workspace — `workspace_id` IS the primary key, so the shape enforces the cardinality. */
export const contributionPolicy = pgTable(
  "contribution_policy",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    contributeEnabled: boolean("contribute_enabled").notNull().default(false),
    /** Fields this workspace will never contribute even when contribution is ON. Only ever SUBTRACTS. */
    neverShareFields: text("never_share_fields").array().notNull().default(sql`'{}'`),
    policyVersion: varchar("policy_version", { length: 20 }).notNull().default("v1"),
    enabledByUserId: uuid("enabled_by_user_id"),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    enabledIsAttributed: check(
      "contribution_policy_enabled_is_attributed",
      sql`${t.contributeEnabled} = false OR (${t.enabledByUserId} IS NOT NULL AND ${t.enabledAt} IS NOT NULL)`,
    ),
  }),
);

/** A per-target opt-out. `kind` selects which one of the three target columns is populated. */
export const contributionExclusion = pgTable(
  "contribution_exclusion",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v7()`),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    /** kind='domain' only. citext so the match is case-insensitive without lower(). */
    domain: citext("domain"),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    note: varchar("note", { length: 200 }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => ({
    kindEnum: check(
      "contribution_exclusion_kind_enum",
      sql`${t.kind} IN ('domain','account','contact')`,
    ),
    // Exactly one target, matching the kind — see the header for why this cannot move into app code.
    target: check(
      "contribution_exclusion_target",
      sql`(${t.kind} = 'domain'  AND ${t.domain} IS NOT NULL AND ${t.accountId} IS NULL AND ${t.contactId} IS NULL) OR
          (${t.kind} = 'account' AND ${t.accountId} IS NOT NULL AND ${t.domain} IS NULL AND ${t.contactId} IS NULL) OR
          (${t.kind} = 'contact' AND ${t.contactId} IS NOT NULL AND ${t.domain} IS NULL AND ${t.accountId} IS NULL)`,
    ),
    // Three PARTIAL uniques rather than one composite: the kinds populate different columns, so a single
    // UNIQUE across all three would let NULLs defeat it.
    uniqDomain: uniqueIndex("uniq_contribution_exclusion_domain")
      .on(t.workspaceId, t.domain)
      .where(sql`${t.kind} = 'domain'`),
    uniqAccount: uniqueIndex("uniq_contribution_exclusion_account")
      .on(t.workspaceId, t.accountId)
      .where(sql`${t.kind} = 'account'`),
    uniqContact: uniqueIndex("uniq_contribution_exclusion_contact")
      .on(t.workspaceId, t.contactId)
      .where(sql`${t.kind} = 'contact'`),
    workspaceIdx: index("idx_contribution_exclusion_workspace").on(t.workspaceId, t.kind),
  }),
);

/** Per-CRM-object contribution switch, keyed by (connection, object_type). */
export const crmObjectContribution = pgTable(
  "crm_object_contribution",
  {
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => crmConnections.id, { onDelete: "cascade" }),
    objectType: varchar("object_type", { length: 20 }).notNull(),
    contributeEnabled: boolean("contribute_enabled").notNull().default(false),
    enabledByUserId: uuid("enabled_by_user_id"),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.connectionId, t.objectType] }),
    // Mirrors crm_field_mappings.object_type, but is its OWN check rather than an FK: a customer may exclude
    // an object they have not mapped a single field of yet.
    objectEnum: check(
      "crm_object_contribution_object_enum",
      sql`${t.objectType} IN ('contact','account','lead','deal')`,
    ),
    enabledIsAttributed: check(
      "crm_object_contribution_enabled_is_attributed",
      sql`${t.contributeEnabled} = false OR (${t.enabledByUserId} IS NOT NULL AND ${t.enabledAt} IS NOT NULL)`,
    ),
  }),
);
