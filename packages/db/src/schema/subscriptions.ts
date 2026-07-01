// subscriptions.ts — Drizzle schema for recurring billing (M11 subscriptions, ADR-0041). `subscriptions` is one
// row per tenant's recurring plan (Stripe is the source of truth for state; the webhook reconciles it);
// `billing_cycles` is one row per term billed — the monthly-grant/reset anchor. The grant worker grants
// grant_credits ONCE per cycle (keyed on (subscription_id, period_start)), posting a credit_ledger `grant` +
// resetting the subscription bucket. Tenant-scoped (RLS like purchases, rls/subscriptions.sql). Trials + plan
// grandfathering + the invoices FK are deferred (invoice_id is a bare uuid for now).

import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./auth.ts";
import { creditLedger } from "./billing.ts";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    tenantId: tenantId(),
    // The logical product (plan_templates.key). Stripe subscription id set once Stripe Billing links it.
    planTemplateKey: text("plan_template_key").notNull(),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }).unique(),
    // trialing | active | past_due | canceled | paused | incomplete (mirrors Stripe).
    status: varchar("status", { length: 20 }).notNull().default("active"),
    // ADR-0012-aligned default; annual is opt-in enterprise.
    term: varchar("term", { length: 20 }).notNull().default("month_to_month"),
    // ADR-0012: auto-renew is NEVER defaulted-on — opt-in only.
    autoRenew: boolean("auto_renew").notNull().default(false),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusEnum: check(
      "subscriptions_status_enum",
      sql`${t.status} IN ('trialing','active','past_due','canceled','paused','incomplete')`,
    ),
    termEnum: check("subscriptions_term_enum", sql`${t.term} IN ('month_to_month','annual')`),
    // At most ONE active-ish subscription per tenant.
    tenantActive: uniqueIndex("uniq_subscriptions_tenant_active")
      .on(t.tenantId)
      .where(sql`${t.status} IN ('trialing','active','past_due','paused')`),
    tenantIdx: index("idx_subscriptions_tenant").on(t.tenantId, t.createdAt.desc()),
    renewalDue: index("idx_subscriptions_renewal_due")
      .on(t.currentPeriodEnd)
      .where(sql`${t.autoRenew} = true AND ${t.status} = 'active'`),
  }),
);

export const billingCycles = pgTable(
  "billing_cycles",
  {
    id: id(),
    tenantId: tenantId(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    // Snapshot of plan_templates.monthly_credit_grant at grant time.
    grantCredits: integer("grant_credits").notNull().default(0),
    // null until the monthly-grant worker runs; once set the row is immutable (rls trigger).
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    grantLedgerId: uuid("grant_ledger_id").references(() => creditLedger.id, {
      onDelete: "set null",
    }),
    // Reset-model: always 0 (no rollover). Kept for schema fidelity / future capped-rollover.
    rolloverCredits: integer("rollover_credits").notNull().default(0),
    // Bare uuid — the invoices table + FK land in Phase 3.
    invoiceId: uuid("invoice_id"),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusEnum: check(
      "billing_cycles_status_enum",
      sql`${t.status} IN ('open','granted','closed','skipped')`,
    ),
    grantNonneg: check(
      "billing_cycles_grant_nonneg",
      sql`${t.grantCredits} >= 0 AND ${t.rolloverCredits} >= 0`,
    ),
    // Exactly-once grant per cycle — the worker keys on this.
    subPeriod: uniqueIndex("uniq_billing_cycles_sub_period").on(t.subscriptionId, t.periodStart),
    tenantIdx: index("idx_billing_cycles_tenant").on(t.tenantId, t.periodStart.desc()),
    // The grant worker's sweep key: open cycles whose period has started but not yet granted.
    pendingGrant: index("idx_billing_cycles_pending_grant")
      .on(t.periodStart)
      .where(sql`${t.grantedAt} IS NULL AND ${t.status} = 'open'`),
  }),
);
