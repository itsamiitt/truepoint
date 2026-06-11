// outreach.ts — Drizzle schema for the M9 outreach engine (03 §7, 05 §13, ADR-0009): `outreach_sequences`
// (workspace-scoped definitions; the CAN-SPAM identity fields are nullable here and ENFORCED at the send
// transaction — 08 §6) → `outreach_steps` (ordered steps: channel, delay, template) → `outreach_log`
// (per-contact enrollment + status; unique (sequence, contact) = enrollment idempotency). The closed enums
// here mirror packages/types/src/outreach.ts — that file is the source of truth.

import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { contacts } from "./contacts.ts";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
const sequenceId = () =>
  uuid("sequence_id")
    .notNull()
    .references(() => outreachSequences.id, { onDelete: "cascade" });

// ── outreach_sequences — the send-engine definitions (05 §13) ──────────────────────────────────────────
export const outreachSequences = pgTable(
  "outreach_sequences",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    name: varchar("name", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    fromAddress: varchar("from_address", { length: 255 }), // CAN-SPAM truthful from — required at send (08 §6)
    physicalAddress: varchar("physical_address", { length: 500 }), // CAN-SPAM postal address — required at send
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqWsName: uniqueIndex("uniq_outreach_sequences_ws_name").on(t.workspaceId, t.name),
    statusEnum: check(
      "outreach_sequences_status_enum",
      sql`${t.status} IN ('active','paused','archived')`,
    ),
  }),
);

// ── outreach_steps — ordered steps within a sequence (channel, delay, template) ────────────────────────
export const outreachSteps = pgTable(
  "outreach_steps",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    sequenceId: sequenceId(),
    stepOrder: integer("step_order").notNull(),
    channel: varchar("channel", { length: 20 }).notNull().default("email"),
    delayHours: integer("delay_hours").notNull().default(0),
    subject: varchar("subject", { length: 255 }),
    body: varchar("body", { length: 5000 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqSeqOrder: uniqueIndex("uniq_outreach_steps_seq_order").on(t.sequenceId, t.stepOrder),
    channelEnum: check("outreach_steps_channel_enum", sql`${t.channel} IN ('email','linkedin')`),
    delayNonNegative: check("outreach_steps_delay_nonneg", sql`${t.delayHours} >= 0`),
  }),
);

// ── outreach_log — per-contact enrollment + lifecycle status (distinct from contacts.outreach_status,
// the contact-level rollup). Unique (sequence, contact) IS the enrollment-idempotency key.
// NOTE: 03 §12 targets monthly range-partitioning for this high-volume table; plain table until volume
// warrants (same note as source_imports — do not silently drop the partitioning intent).
export const outreachLog = pgTable(
  "outreach_log",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    sequenceId: sequenceId(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull().default("enrolled"),
    currentStep: integer("current_step").notNull().default(0),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqSeqContact: uniqueIndex("uniq_outreach_log_seq_contact").on(t.sequenceId, t.contactId),
    statusEnum: check(
      "outreach_log_status_enum",
      sql`${t.status} IN ('enrolled','active','replied','completed','unsubscribed','bounced')`,
    ),
  }),
);
