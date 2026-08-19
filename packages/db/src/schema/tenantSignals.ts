// tenantSignals.ts — the Layer-1 PROJECTION of master_signals (market-intelligence MI-S6;
// docs/planning/market-intelligence/06-architecture.md §3). Outcomes: [S-13] fast detection of changes on
// saved accounts/contacts · [S-09] person-still-there · [A-01] provenance (each row references its Layer-0
// signal, which carries the evidence).
//
// RELATIONSHIP TO THE TWO EXISTING SIGNAL STORES (the carried open question, now resolved):
//   master_signals   = the shared FACT, Layer 0, one row per event in the world.
//   tenant_signals   = this table — the tenant's DELIVERED COPY, one row per (workspace, master signal),
//                      written only by the signal_fanout sweep. Scoring and the alerts feed read THIS,
//                      never Layer 0 (leadwolf_app has no master_* grant, by design).
//   intent_signals   = the shipped contact-scoped store; its job_change path stays as-is. New company-fact
//                      families land HERE; a later step may migrate job_change onto this table.
//
// The projection is REBUILDABLE: rows carry a denormalized display slice (type, family, headline, amount)
// so the feed renders without a Layer-0 read, but Layer 0 stays the source of truth — on conflict the
// projection is deleted and re-fanned, never edited. The payload itself is NOT copied: anything richer
// than the display slice is a Layer-0 read through a server seam, which keeps the no-PII discipline
// single-homed in masterSignalsRepository.assertNoContactValues.

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./auth.ts";
import { accounts, contacts } from "./contacts.ts";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);

export const tenantSignals = pgTable(
  "tenant_signals",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The bridged overlay rows this signal is ABOUT, inside this workspace. Company-subject signals set
    // account_id; person-subject fan-out (later) sets contact_id. Both nullable so an account deletion
    // does not orphan-delete history silently — the FK cascades instead.
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    // The Layer-0 signal this row projects. No FK: master_signals is a partitioned parent in a different
    // trust layer, and the projection must survive Layer-0 partition maintenance. Uniqueness below is the
    // fan-out's idempotency key.
    masterSignalId: uuid("master_signal_id").notNull(),
    typeCode: varchar("type_code", { length: 50 }).notNull(),
    family: varchar("family", { length: 20 }).notNull(),
    headline: varchar("headline", { length: 300 }),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: varchar("currency", { length: 3 }),
    /** VALID time — when the event happened (the Layer-0 observed_at). The feed sorts on this. */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    /** When the fan-out delivered it to this workspace. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The fan-out's dedup wall: at-least-once delivery collapses to exactly-one row per workspace.
    uniqWsSignal: uniqueIndex("uniq_tenant_signals_ws_signal").on(t.workspaceId, t.masterSignalId),
    // The feed read: recent-first per workspace, and per account on the company page.
    wsObservedIdx: index("idx_tenant_signals_ws_observed").on(t.workspaceId, t.observedAt.desc()),
    wsAccountIdx: index("idx_tenant_signals_ws_account").on(
      t.workspaceId,
      t.accountId,
      t.observedAt.desc(),
    ),
    // Same closed family vocabulary as master_signal_types (0103) — and like it, deliberately NO 'intent'
    // (deferred non-goal X-04; docs/planning/market-intelligence/03-scope-and-constraints.md).
    familyEnum: check(
      "tenant_signals_family_enum",
      sql`${t.family} IN ('hiring','funding','tech_change','leadership','filing','other')`,
    ),
    // A projected signal is about SOMETHING in the workspace — a row about nothing is a fan-out bug.
    subjectPresent: check(
      "tenant_signals_subject_present",
      sql`${t.accountId} IS NOT NULL OR ${t.contactId} IS NOT NULL`,
    ),
  }),
);
