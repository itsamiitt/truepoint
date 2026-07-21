// accountChildren.ts — Drizzle schema for the company-overlay child tables `account_domains` +
// `account_locations` (import-and-data-model-redesign 06 §1/§3 — THE spec; 07 §3/§4/§8; S-A1/S-A3,
// migration 0061). One schema unit, two tables, symmetric with the doc-05 channel pattern (child rows +
// flat primary-cache column) applied to accounts' domains/locations.
//
// STATUS: DDL expand only — DEAD SCHEMA. Nothing reads or writes these tables until S-A2 lands the single
// account write path (child + cache in one withTenantTx, cache authoritative until S-A6). The flat accounts
// columns remain the source of truth and, permanently, the denormalized PRIMARY caches: `accounts.domain`
// (primary-domain cache of the live is_primary account_domains row) and `accounts.hq_country`/`hq_city`
// (primary-location cache). Doc 05 owns the cache-sync rationale; these tables inherit it (06 §1).
//
// Key design facts mirrored from the spec (06/07):
//   • PII posture: domains and office addresses are NOT PII (06 §1/§3) — stored CLEAR (citext domain; plain
//     address text). The deliberate contrast with doc 05's encrypted channel values; no value_enc/blind_index.
//   • Tenancy (DM4): denormalized NOT NULL tenant_id + workspace_id on every row; RLS (ENABLE+FORCE,
//     fail-closed NULLIF workspace GUC) is DIRECT on workspace_id, never derived through the accounts join
//     (rls/accountChildren.sql — the contact_emails / import_job_rows precedent).
//   • account_domains: whole-set ws-domain partial unique (`uniq_account_domains_ws_domain`) STRENGTHENS the
//     flat uniq_accounts_ws_domain from primary-only to the whole set — what makes ladder rung C2 "any-domain
//     exact" a safe match (06 §1/§5). At-most-one live primary per account (`uniq_account_domains_primary`);
//     provenance trio source/source_import_id/pinned + verified_at (per-row, DM6 form).
//   • account_locations: type hq|branch|office; address fields; country char(2) NULL (ISO-3166 alpha-2, NULL
//     when source was unmappable freetext — backfill honesty, 06 §3). Carries source + pinned but DELIBERATELY
//     NO source_import_id lineage FK — locations are subordinate to company identity and NEVER a dedup key
//     (06 §3); 07 §3's FK inventory lists only tenant/workspace + account_id for this table (and 07 §2.2 draws
//     no locations→source_imports edge). See doc 16 drift row. At-most-one live primary per account.
//   • FKs (07 §3): account_id → accounts CASCADE on BOTH (hard-purge/retention fanout ONLY — product delete is
//     soft via deleted_at); account_domains.source_import_id → source_imports SET NULL (retention may reap
//     lineage); tenant/workspace → CASCADE.
//   • All value indexes are partial on live rows (`deleted_at IS NULL`) so tombstones release keys (06 §4:
//     soft-delete releases the ws-domain unique so the workspace can re-create the company later).
//   • Per-account caps (domains ≤ 50, locations ≤ 200 — 06 §Misuse) are APP-LAYER at the API edge; no DB constraint.

import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  customType,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./auth.ts";
import { accounts, sourceImports } from "./contacts.ts";

// Shared column idioms (kept local per the self-contained-schema convention used across this folder).
const citext = customType<{ data: string }>({ dataType: () => "citext" });
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
// CASCADE covers the hard-purge/retention fanout ONLY; product deletion of an account is soft (deleted_at),
// which tombstones child rows in the same tx (06 §4) rather than dropping them.
const accountId = () =>
  uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" });

// ── account_domains (multi-domain child; the flat accounts.domain caches the live primary) ──────────────
export const accountDomains = pgTable(
  "account_domains",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    accountId: accountId(),
    domain: citext("domain").notNull(), // normalized eTLD+1 (DM1 normalizer); freemail-guarded at the app edge; NON-PII
    isPrimary: boolean("is_primary").notNull().default(false), // at-most-one live primary (exactly-one is app-enforced)
    source: varchar("source", { length: 30 }).notNull(), // import|enrichment|manual|master_suggestion (CHECK)
    // Lineage pointer for import-born domains (SET NULL: retention may reap source_imports — the row survives).
    sourceImportId: uuid("source_import_id").references(() => sourceImports.id, {
      onDelete: "set null",
    }),
    pinned: boolean("pinned").notNull().default(false), // pinned rows are never detached/demoted by import/enrichment
    verifiedAt: timestamp("verified_at", { withTimezone: true }), // last confirmed live/owned (enrichment sets it); NULL = never
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft-detach tombstone; releases the ws-domain unique
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Whole-set domain uniqueness per workspace → makes rung C2 (any-domain exact) safe (06 §1/§5). Live rows only.
    uniqWsDomain: uniqueIndex("uniq_account_domains_ws_domain")
      .on(t.workspaceId, t.domain)
      .where(sql`${t.deletedAt} IS NULL`),
    // At-most-one live primary per account; the single writer maintains exactly-one (S-A2), the sweep detects drift.
    uniqPrimary: uniqueIndex("uniq_account_domains_primary")
      .on(t.accountId)
      .where(sql`${t.isPrimary} AND ${t.deletedAt} IS NULL`),
    // Render the domain set on the account drawer; live rows only.
    accountIdx: index("idx_account_domains_account")
      .on(t.accountId)
      .where(sql`${t.deletedAt} IS NULL`),
    sourceEnum: check(
      "account_domains_source_enum",
      sql`${t.source} IN ('import','enrichment','manual','master_suggestion')`,
    ),
  }),
);

// ── account_locations (offices child; the flat accounts.hq_country/hq_city cache the primary hq) ─────────
export const accountLocations = pgTable(
  "account_locations",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    accountId: accountId(),
    type: varchar("type", { length: 10 }).notNull(), // hq|branch|office (CHECK)
    line1: varchar("line1", { length: 255 }),
    line2: varchar("line2", { length: 255 }),
    city: varchar("city", { length: 100 }),
    region: varchar("region", { length: 100 }), // state/province, freetext
    postalCode: varchar("postal_code", { length: 20 }),
    country: char("country", { length: 2 }), // ISO-3166 alpha-2; NULL when source was unmappable freetext (06 §3)
    isPrimary: boolean("is_primary").notNull().default(false),
    source: varchar("source", { length: 30 }).notNull(), // import|enrichment|manual|master_suggestion (CHECK)
    // NO source_import_id: locations are subordinate to identity and never a dedup key (06 §3) — 07 §3's FK
    // inventory lists only tenant/workspace + account_id for this table (doc 16 drift row).
    pinned: boolean("pinned").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqPrimary: uniqueIndex("uniq_account_locations_primary")
      .on(t.accountId)
      .where(sql`${t.isPrimary} AND ${t.deletedAt} IS NULL`),
    typeEnum: check("account_locations_type_enum", sql`${t.type} IN ('hq','branch','office')`),
    sourceEnum: check(
      "account_locations_source_enum",
      sql`${t.source} IN ('import','enrichment','manual','master_suggestion')`,
    ),
  }),
);
