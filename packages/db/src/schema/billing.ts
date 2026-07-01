// billing.ts — Drizzle schema for the M3 money loop + compliance gate (03 §5/§7/§8, ADR-0007, ADR-0009):
// `contact_reveals` (the per-reveal event log; unique claim key = reveal idempotency), `stripe_customers` +
// `purchases` (idempotent top-ups), `suppression_list` (gates reveal AND send), `idempotency_keys` (the
// stored-response replay store for money endpoints) and the append-only `audit_log`. The closed enums here
// mirror packages/types/src/billing.ts — that file is the source of truth.

import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
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
    // Dashboard "recent reveals" read (revealRepository: WHERE workspace_id ... ORDER BY revealed_at DESC):
    // composite with workspace_id so the recency feed stays index-backed under the RLS workspace predicate
    // instead of a seq-scan + sort on this high-volume event log (perf RC#9).
    wsRevealedAtIdx: index("idx_contact_reveals_ws_revealed_at").on(
      t.workspaceId,
      t.revealedAt.desc(),
    ),
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

// ── credit_ledger — the append-only credit audit trail (M11, ADR-0029). One immutable, tenant-scoped entry
// per balance mutation: signed `delta` + entry_type + idempotency_key (dedups retries). The counter
// tenants.reveal_credit_balance stays the fast read cache; SUM(delta) per tenant must equal it (the
// billing-recon worker asserts this). RLS + the UPDATE/DELETE-blocking trigger live in rls/creditLedger.sql.
// The lease/settle/release entry types + budget scoping are reserved for the M12 bulk/team-budget work.
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: id(),
    tenantId: tenantId(),
    // Optional workspace scoping (null on tenant-level entries like Stripe grants).
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    entryType: varchar("entry_type", { length: 20 }).notNull(),
    // SIGNED: grant/credit_back/release ≥ 0; spend/lease/settle ≤ 0; adjustment ±. Guarded by the sign CHECK.
    delta: integer("delta").notNull(),
    // Materialized running balance AFTER this entry (read from inside the mutation tx) — a read convenience.
    balanceAfter: integer("balance_after"),
    // Dedup key: exactly one entry per (tenant, key). grant:<stripe_event_id> / reveal:<reveal_id> / adjust:<key>.
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    revealId: uuid("reveal_id").references(() => contactReveals.id, { onDelete: "set null" }),
    purchaseId: uuid("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id").references(() => users.id), // null = system/automation
    reason: varchar("reason", { length: 255 }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Exactly one entry per (tenant, idempotency_key) — a replayed grant/reveal re-posts nothing.
    uniqTenantIdem: uniqueIndex("uniq_credit_ledger_tenant_idem").on(t.tenantId, t.idempotencyKey),
    // The tenant credit-history read (newest-first) + the recon SUM scan.
    tenantCreatedIdx: index("idx_credit_ledger_tenant_created").on(t.tenantId, t.createdAt.desc()),
    entryTypeEnum: check(
      "credit_ledger_entry_type_enum",
      sql`${t.entryType} IN ('grant','spend','credit_back','adjustment','lease','settle','release')`,
    ),
    // Sign discipline per ADR-0029 — a generator can never post a wrong-signed entry.
    deltaSign: check(
      "credit_ledger_delta_sign",
      sql`(${t.entryType} IN ('grant','credit_back','release') AND ${t.delta} >= 0)
       OR (${t.entryType} IN ('spend','lease','settle') AND ${t.delta} <= 0)
       OR (${t.entryType} = 'adjustment')`,
    ),
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
        'mailbox.connect','mailbox.disconnect','sending_domain.add','sending_domain.verify',
        'login.success','login.failure','login.locked','mfa.challenge','mfa.success','mfa.failure',
        'password.reset.request','password.reset.complete','sso.initiated','sso.callback',
        'token.issued','token.refresh','token.revoke','device.trusted','device.revoked','session.revoked',
        'code.issued','code.exchanged','signup','oauth.link'
      )`,
    ),
    // Dashboard activity feed + compliance viewer (auditRepository.listByTenant/listByWorkspace: WHERE
    // tenant_id = ... ORDER BY occurred_at DESC LIMIT N). Composite so the newest-first slice is a backwards
    // index scan, not a seq-scan + sort on this append-only, ever-growing log (perf RC#9). The workspace feed
    // adds an OR workspace_id IS NULL / = :ws clause on top of the same tenant+recency prefix, which this
    // index still serves.
    tenantOccurredAtIdx: index("idx_audit_log_tenant_occurred_at").on(
      t.tenantId,
      t.occurredAt.desc(),
    ),
    // Auth Admin ▸ Security audit (auditRepository.listAuthEvents: WHERE tenant_id = ... AND action IN
    // (auth actions) ORDER BY occurred_at DESC). PARTIAL on just the auth-domain action slice so this index
    // stays tiny relative to the full log while serving the filtered recency read. The predicate mirrors
    // AUTH_AUDIT_ACTIONS in auditRepository.ts — keep the two in sync if the auth vocabulary changes.
    tenantAuthOccurredAtIdx: index("idx_audit_log_tenant_auth_occurred_at")
      .on(t.tenantId, t.occurredAt.desc())
      .where(
        sql`${t.action} IN (
          'login.success','login.failure','login.locked','mfa.challenge','mfa.success','mfa.failure',
          'password.reset.request','password.reset.complete','sso.initiated','sso.callback',
          'token.issued','token.refresh','token.revoke','device.trusted','device.revoked','session.revoked',
          'code.issued','code.exchanged','signup','oauth.link'
        )`,
      ),
  }),
);
