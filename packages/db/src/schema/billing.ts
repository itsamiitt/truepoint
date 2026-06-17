// billing.ts — Drizzle schema for the M3 money loop + compliance gate (03 §5/§7/§8, ADR-0007, ADR-0009):
// `contact_reveals` (the per-reveal event log; unique claim key = reveal idempotency), `stripe_customers` +
// `purchases` (idempotent top-ups), `suppression_list` (gates reveal AND send), `idempotency_keys` (the
// stored-response replay store for money endpoints) and the append-only `audit_log`. The closed enums here
// mirror packages/types/src/billing.ts — that file is the source of truth.

import { sql } from "drizzle-orm";
import {
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
import { contacts } from "./contacts.ts";

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });
const inet = customType<{ data: string }>({ dataType: () => "inet" });
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ── contact_reveals — the reveal event log (07 §2; first row per (ws,contact) flips ownership) ─────────
// NOTE: 03 §12 targets monthly range-partitioning; plain table until volume warrants (same note as
// source_imports — do not silently drop the partitioning intent).
export const contactReveals = pgTable(
  "contact_reveals",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    revealedByUserId: uuid("revealed_by_user_id")
      .notNull()
      .references(() => users.id),
    revealType: varchar("reveal_type", { length: 20 }).notNull(),
    dataSource: varchar("data_source", { length: 20 }).notNull().default("internal"),
    creditsConsumed: integer("credits_consumed").notNull().default(1),
    revealedFields: jsonb("revealed_fields").notNull().default({}),
    revealedAt: timestamp("revealed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // THE reveal-idempotency key (ADR-0007/H2): re-revealing the same workspace copy conflicts → free.
    uniqClaim: uniqueIndex("uniq_contact_reveals_claim").on(
      t.workspaceId,
      t.contactId,
      t.revealType,
    ),
    revealTypeEnum: check(
      "contact_reveals_type_enum",
      sql`${t.revealType} IN ('email','phone','full_profile')`,
    ),
    dataSourceEnum: check(
      "contact_reveals_source_enum",
      sql`${t.dataSource} IN ('apollo','zoominfo','linkedin','internal')`,
    ),
    creditsNonNegative: check("contact_reveals_credits_nonneg", sql`${t.creditsConsumed} >= 0`),
  }),
);

// ── Stripe linkage + idempotent top-ups (07 §4) ─────────────────────────────────────────────────────────
export const stripeCustomers = pgTable("stripe_customers", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  stripeCustomerId: varchar("stripe_customer_id", { length: 255 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchases = pgTable(
  "purchases",
  {
    id: id(),
    tenantId: tenantId(),
    stripeEventId: varchar("stripe_event_id", { length: 255 }).notNull().unique(), // duplicate webhooks grant once
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
    credits: integer("credits").notNull(),
    amountCents: integer("amount_cents"),
    status: varchar("status", { length: 20 }).notNull().default("completed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    creditsPositive: check("purchases_credits_positive", sql`${t.credits} > 0`),
    statusEnum: check("purchases_status_enum", sql`${t.status} IN ('completed','refunded')`),
  }),
);

// ── suppression_list — gates reveal AND send, checked IN-TX (08 §3; scopes global|tenant|workspace) ────
export const suppressionList = pgTable(
  "suppression_list",
  {
    id: id(),
    scope: varchar("scope", { length: 20 }).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }), // null on global rows
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    matchType: varchar("match_type", { length: 20 }).notNull(),
    emailBlindIndex: bytea("email_blind_index"), // HMAC(normalized email) — matches contacts.email_blind_index
    domain: citext("domain"),
    phoneBlindIndex: bytea("phone_blind_index"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    reason: varchar("reason", { length: 255 }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeEnum: check("suppression_scope_enum", sql`${t.scope} IN ('global','tenant','workspace')`),
    matchEnum: check(
      "suppression_match_enum",
      sql`${t.matchType} IN ('email','domain','phone','contact_id')`,
    ),
    // Scope ↔ id coherence: global rows carry no tenant/workspace; workspace rows carry both.
    scopeCoherence: check(
      "suppression_scope_coherence",
      sql`(${t.scope} = 'global' AND ${t.tenantId} IS NULL AND ${t.workspaceId} IS NULL)
       OR (${t.scope} = 'tenant' AND ${t.tenantId} IS NOT NULL AND ${t.workspaceId} IS NULL)
       OR (${t.scope} = 'workspace' AND ${t.tenantId} IS NOT NULL AND ${t.workspaceId} IS NOT NULL)`,
    ),
    // The match key named by match_type must be present.
    matchKeyPresent: check(
      "suppression_match_key_present",
      sql`(${t.matchType} = 'email' AND ${t.emailBlindIndex} IS NOT NULL)
       OR (${t.matchType} = 'domain' AND ${t.domain} IS NOT NULL)
       OR (${t.matchType} = 'phone' AND ${t.phoneBlindIndex} IS NOT NULL)
       OR (${t.matchType} = 'contact_id' AND ${t.contactId} IS NOT NULL)`,
    ),
  }),
);

// ── idempotency_keys — stored-response replay for money endpoints (07 §3, 09 §5) ───────────────────────
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: id(),
    tenantId: tenantId(),
    key: varchar("key", { length: 255 }).notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantKey: uniqueIndex("uniq_idempotency_tenant_key").on(t.tenantId, t.key),
  }),
);

// ── audit_log — append-only, closed action enum (08 §5; UPDATE/DELETE blocked by trigger in rls/billing.sql)
// NOTE: 03 §12 targets monthly range-partitioning; plain table until volume warrants.
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }), // null = tenant-level
    actorUserId: uuid("actor_user_id").references(() => users.id), // null = system/automation
    action: varchar("action", { length: 50 }).notNull(),
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ipAddress: inet("ip_address"),
    userAgent: varchar("user_agent", { length: 500 }),
    originDomain: varchar("origin_domain", { length: 255 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The closed action enum — mirror of packages/types/src/billing.ts auditAction (the source of truth).
    actionEnum: check(
      "audit_log_action_enum",
      sql`${t.action} IN (
        'reveal','reveal.blocked','export','send','enroll','unsubscribe',
        'suppression.add','suppression.remove','consent.record','consent.withdraw',
        'dsar.access','dsar.delete','dsar.rectify','member.add','member.update','member.remove',
        'apikey.use','credit.adjust',
        'contact.create','contact.update','contact.delete','account.create','account.update','account.delete',
        'list.create','list.update','list.delete','sequence.create','sequence.update','sequence.delete',
        'template.create','template.update','template.delete','settings.update',
        'automation.rule.create','automation.rule.update','automation.rule.delete',
        'custom_field.create','custom_field.update','custom_field.delete',
        'tag.create','tag.update','tag.delete','tag.assign','tag.unassign',
        'pipeline_stage.create','pipeline_stage.update','pipeline_stage.delete','pipeline_stage.assign',
        'saved_search.create','saved_search.update','saved_search.delete',
        'automation.rule.enable','automation.rule.disable','automation.rule.run',
        'ai.config.update','ai.draft.approve','ai.draft.reject',
        'login.success','login.failure','login.locked','mfa.challenge','mfa.success','mfa.failure',
        'password.reset.request','password.reset.complete','sso.initiated','sso.callback',
        'token.issued','token.refresh','token.revoke','device.trusted','device.revoked','session.revoked',
        'code.issued','code.exchanged','signup','oauth.link'
      )`,
    ),
  }),
);
