// contactChannels.ts — Drizzle schema for the multi-value channel overlay child tables `contact_emails` +
// `contact_phones` (import-and-data-model-redesign 05 §1–§2 — THE spec; 07 §3/§4/§8; S-CH1, migration 0058).
// One schema unit, two tables, one shared shape + per-table deltas.
//
// STATUS: DDL expand only — DEAD SCHEMA. Nothing reads or writes these tables until S-CH2 lands the single
// write path (`applyChannelWrite`, `CHANNEL_DUAL_WRITE`-gated). The flat contacts columns (email_enc/
// email_blind_index/email_domain/email_status · phone_enc/phone_status/phone_line_type) remain the source of
// truth and, permanently, the denormalized PRIMARY-VALUE CACHE: invariant CH-INV-1 (05 §3) — the flat columns
// are a byte-exact projection of the single live `is_primary` child row (or all-NULL when none exists).
//
// Key design facts mirrored from the spec:
//   • PII posture (DM1): `value_enc` = AES-GCM ciphertext (encryptPii); `blind_index` = keyed HMAC
//     (blindIndex) over the per-table index form (emails: normalizeEmailForIndex; phones: digit-compacted
//     raw). Phones additionally carry the DERIVED E.164 pair (`e164_enc`/`e164_blind_index`, NULL exactly
//     when unparseable), the byte-exact `raw_original_enc` (only when it differs from the cleaned form),
//     `country_hint` (parse reproducibility) and `extension` (outside the E.164 core, always — 03 §7).
//   • Tenancy (DM4): denormalized NOT NULL tenant_id + workspace_id on every row; RLS (ENABLE+FORCE,
//     fail-closed NULLIF workspace GUC) is DIRECT on workspace_id, never derived through the contacts join
//     (rls/contactChannels.sql — the import_job_rows precedent).
//   • Dedup asymmetry (05 §2.2, 07 §1 axis 3): emails are per-WORKSPACE value-unique (the any-value identity
//     rung) + per-contact unique; phones are per-CONTACT unique ONLY (shared HQ/switchboard lines are legal)
//     — the workspace E.164 probe `idx_contact_phones_ws_e164` is a NON-unique match SIGNAL, never an upsert
//     key. All value indexes are partial on live rows (`deleted_at IS NULL`) so tombstones release keys.
//   • At-most-one live primary per contact per table (`uniq_*_primary`); "exactly one whenever any live row
//     exists" is app-enforced (S-CH2) + swept (S-CH5). Promotion is an atomic demote-then-promote swap.
//   • Vocabularies are the SHIPPED ones (DM1, @leadwolf/types contacts.ts): email `status` = emailStatus,
//     phone `status` = phoneStatus (nullable like contacts.phone_status), `line_type` = the phoneLineType
//     union taxonomy (05 §1.5 — widened in place, additively). `type` per 05 §1.4.
//   • FKs (07 §3): contact_id → contacts CASCADE (hard-purge/DSAR fanout ONLY — product delete is soft via
//     deleted_at); source_import_id → source_imports SET NULL (retention may reap lineage at 730 d).
//   • Per-contact caps: 25 emails / 25 phones (MAX_CHANNEL_VALUES_PER_CONTACT, @leadwolf/types) — APP-LAYER,
//     enforced at the API edge (05 §Misuse); deliberately no DB constraint.
//   • Index budget: 6 per table incl. PK (05 §2.3) — nothing more without a measured read (doc 12).
// STORAGE PARAMS (S-P5 tripwire; comment-only — Drizzle can't express them): migration 0058 (re)states the
// 0056 append-heavy autovacuum posture on BOTH tables (scale factors 0.01, thresholds 10k, insert threshold
// 100k) because 0056's to_regclass-guarded ALTERs were no-ops wherever it ran before these tables existed.

import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  customType,
  index,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./auth.ts";
import { contacts, sourceImports } from "./contacts.ts";

// Shared column idioms (kept local per the self-contained-schema convention used across this folder).
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
// Stable per-value identity is normative (RFC 9553; 05 §1.1): merge/sync re-points or tombstones BY ID,
// never rewrites a value in place. CASCADE covers the hard-delete fanout only; product deletion is soft.
const contactId = () =>
  uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" });
// Lineage pointer for import-born values (ADR-0006: source_imports is the ONLY lineage); SET NULL because
// retention may reap source_imports at 730 d (types/retention.ts) — the value row survives its lineage.
const sourceImportId = () =>
  uuid("source_import_id").references(() => sourceImports.id, { onDelete: "set null" });

// ── contact_emails (unlimited per-contact email values; masked until reveal) ───────────────────────────
export const contactEmails = pgTable(
  "contact_emails",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    contactId: contactId(),
    valueEnc: bytea("value_enc").notNull(), // AES-GCM ciphertext of the STORAGE form (trim+lowercase)
    blindIndex: bytea("blind_index").notNull(), // HMAC of the INDEX form (plus-tag stripped) — byte-identical to contacts.email_blind_index
    // Clear, non-PII facet (emailDomainOf). NOT NULL here: a value row only exists when a well-formed email
    // exists (the flat contacts.email_domain stays nullable because the CONTACT may have no email).
    emailDomain: citext("email_domain").notNull(),
    type: varchar("type", { length: 20 }).notNull().default("other"), // usage context (05 §1.4)
    isPrimary: boolean("is_primary").notNull().default(false), // exactly-one-live-primary (CH-INV-1)
    status: varchar("status", { length: 20 }).notNull().default("unverified"), // shipped emailStatus vocab
    confidence: numeric("confidence", { precision: 3, scale: 2 }), // per-value confidence ∈ [0,1]
    source: varchar("source", { length: 50 }).notNull(), // field_provenance.src grammar — NEVER a workspace id
    sourceImportId: sourceImportId(),
    pinned: boolean("pinned").notNull().default(false), // row-grain human pin: blocks automated demotion/overwrite
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(), // survives re-imports
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }), // per-value verification timestamp
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete; tombstones ARE the channel history
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // At-most-one LIVE primary per contact (05 §2.1); demote-then-promote in one tx under this partial unique.
    uniqPrimary: uniqueIndex("uniq_contact_emails_primary")
      .on(t.contactId)
      .where(sql`${t.isPrimary} AND ${t.deletedAt} IS NULL`),
    // One email VALUE per workspace, wherever it sits — extends uniq_contacts_ws_email to any-value (05 §2.2).
    uniqWsValue: uniqueIndex("uniq_contact_emails_ws_value")
      .on(t.workspaceId, t.blindIndex)
      .where(sql`${t.deletedAt} IS NULL`),
    // Per-contact value dedup + the contact-leading FK/cascade-fanout index.
    uniqContactValue: uniqueIndex("uniq_contact_emails_contact_value")
      .on(t.contactId, t.blindIndex)
      .where(sql`${t.deletedAt} IS NULL`),
    // Per-contact channel fetch, index-backed under the RLS workspace predicate (05 §2.3).
    wsContactIdx: index("idx_contact_emails_ws_contact").on(t.workspaceId, t.contactId),
    // The any-value domain facet (G16 guard) — live rows only.
    wsDomainIdx: index("idx_contact_emails_ws_domain")
      .on(t.workspaceId, t.emailDomain)
      .where(sql`${t.deletedAt} IS NULL`),
    typeEnum: check(
      "contact_emails_type_enum",
      sql`${t.type} IN ('work','personal','other')`,
    ),
    // Mirrors contacts_email_status_enum exactly (DM1 — one vocabulary).
    statusEnum: check(
      "contact_emails_status_enum",
      sql`${t.status} IN ('unverified','valid','risky','invalid','catch_all','unknown')`,
    ),
    confidenceRange: check(
      "contact_emails_confidence_range",
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
  }),
);

// ── contact_phones (unlimited per-contact phone values; dual raw+E.164 representation) ─────────────────
export const contactPhones = pgTable(
  "contact_phones",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    contactId: contactId(),
    valueEnc: bytea("value_enc").notNull(), // ciphertext of the CLEANED as-entered value (dialable/display form)
    blindIndex: bytea("blind_index").notNull(), // HMAC of the digit-compacted raw — works even when E.164 parsing fails
    e164Enc: bytea("e164_enc"), // ciphertext of the derived E.164 (toE164); NULL exactly when unparseable
    e164BlindIndex: bytea("e164_blind_index"), // the NORMALIZED match key — dedup/match signals ride THIS, never the raw key
    rawOriginalEnc: bytea("raw_original_enc"), // byte-exact original WHEN it differs from value_enc's cleaned form
    countryHint: char("country_hint", { length: 2 }), // ISO-3166 alpha-2 region used at parse time (re-parse reproducibility)
    extension: varchar("extension", { length: 16 }), // outside the E.164 core, always (03 §7)
    lineType: varchar("line_type", { length: 24 }), // union taxonomy (05 §1.5) — the widened phoneLineType vocab
    lineTypeSource: varchar("line_type_source", { length: 20 }), // HOW determined — mandatory companion (offline typing is ambiguous)
    type: varchar("type", { length: 20 }).notNull().default("other"), // usage context incl. SI kinds direct|hq (05 §1.4)
    isPrimary: boolean("is_primary").notNull().default(false),
    status: varchar("status", { length: 50 }), // shipped phoneStatus vocab; nullable like contacts.phone_status
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    source: varchar("source", { length: 50 }).notNull(),
    sourceImportId: sourceImportId(),
    pinned: boolean("pinned").notNull().default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqPrimary: uniqueIndex("uniq_contact_phones_primary")
      .on(t.contactId)
      .where(sql`${t.isPrimary} AND ${t.deletedAt} IS NULL`),
    // Per-CONTACT unique ONLY (05 §2.2 deliberate asymmetry): an HQ/switchboard number legitimately appears
    // on many contacts, so phones are NEVER workspace-unique — phone is a dedup key nowhere in the market.
    uniqContactValue: uniqueIndex("uniq_contact_phones_contact_value")
      .on(t.contactId, t.blindIndex)
      .where(sql`${t.deletedAt} IS NULL`),
    // The workspace-level duplicate-SIGNAL probe (feeds the review queue as deterministic_phone rung — a
    // marker, never an upsert key). NON-unique by design; live+parsed rows only.
    wsE164Idx: index("idx_contact_phones_ws_e164")
      .on(t.workspaceId, t.e164BlindIndex)
      .where(sql`${t.e164BlindIndex} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    wsContactIdx: index("idx_contact_phones_ws_contact").on(t.workspaceId, t.contactId),
    typeEnum: check(
      "contact_phones_type_enum",
      sql`${t.type} IN ('work','personal','mobile','direct','hq','other')`,
    ),
    // The shipped phoneStatus vocabulary (kind+validity conflated — kept as-is per DM1; cleanup is doc-04's).
    statusEnum: check(
      "contact_phones_status_enum",
      sql`${t.status} IS NULL OR ${t.status} IN ('direct','mobile','hq','unknown','valid','invalid')`,
    ),
    // The 05 §1.5 union taxonomy: shipped 4 (mobile|landline|voip|unknown) ∪ Twilio Lookup's carrier-live
    // set ∪ libphonenumber's honest fixed_line_or_mobile ambiguity value.
    lineTypeEnum: check(
      "contact_phones_line_type_enum",
      sql`${t.lineType} IS NULL OR ${t.lineType} IN ('mobile','landline','fixed_voip','non_fixed_voip','voip','toll_free','premium_rate','shared_cost','personal','pager','uan','voicemail','fixed_line_or_mobile','unknown')`,
    ),
    lineTypeSourceEnum: check(
      "contact_phones_line_type_source_enum",
      sql`${t.lineTypeSource} IS NULL OR ${t.lineTypeSource} IN ('carrier_lookup','libphonenumber','provider','import')`,
    ),
    confidenceRange: check(
      "contact_phones_confidence_range",
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
  }),
);
