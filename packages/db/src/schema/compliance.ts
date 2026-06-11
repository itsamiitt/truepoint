// compliance.ts — Drizzle schema for the M5 compliance layer (03 §8, 08 §2/§4): `consent_records`
// (lawful basis per contact × jurisdiction) and `dsar_requests`. DSAR requests are PLATFORM-owned (a data
// subject spans every tenant — 08 §4), so the table carries no tenant FK and is reachable only by the
// privileged role; rls/compliance.sql denies the app role.

import { sql } from "drizzle-orm";
import { check, customType, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { contacts } from "./contacts.ts";

const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);

// ── consent_records — lawful basis per contact × jurisdiction (08 §2) ──────────────────────────────────
export const consentRecords = pgTable(
  "consent_records",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    jurisdiction: varchar("jurisdiction", { length: 2 }).notNull(), // ISO country of the subject
    lawfulBasis: varchar("lawful_basis", { length: 50 }).notNull(),
    source: varchar("source", { length: 255 }), // where the basis was established
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    basisEnum: check(
      "consent_basis_enum",
      sql`${t.lawfulBasis} IN ('legitimate_interest','consent','contract','public_record')`,
    ),
  }),
);

// ── dsar_requests — platform-owned subject-rights workflow (08 §4) ──────────────────────────────────────
export const dsarRequests = pgTable(
  "dsar_requests",
  {
    id: id(),
    requestType: varchar("request_type", { length: 20 }).notNull(), // access|delete|rectify
    subjectEmailEnc: bytea("subject_email_enc").notNull(), // encrypted; never stored plaintext
    subjectEmailBlindIndex: bytea("subject_email_blind_index").notNull(), // the find-everywhere key (H6)
    status: varchar("status", { length: 30 }).notNull().default("received"),
    scopeReport: jsonb("scope_report"), // access: the assembled report; delete: the erasure proof
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }), // requester identity verified (08 §4)
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    typeEnum: check("dsar_type_enum", sql`${t.requestType} IN ('access','delete','rectify')`),
    statusEnum: check(
      "dsar_status_enum",
      sql`${t.status} IN ('received','verifying','processing','completed','rejected')`,
    ),
  }),
);
