// email.ts — Drizzle schema for the M12 email subsystem: the NET-NEW persistence per email-planning/14 §2.1
// (D11). This subsystem EXTENDS the shipped M9 outreach engine (outreach_sequences/steps/log,
// suppression_list, consent_records, idempotency_keys, activities); it does NOT introduce parallel
// email_sequence/email_suppression/email_consent/email_idempotency_key tables. The only net-new tables are:
//   • sending_domain      — per-tenant authenticated send identity (DKIM/SPF/DMARC + tracking-CNAME state; D2/D3)
//   • mailbox_integration — workspace-scoped connected sending identity; ESP/OAuth/SMTP creds encrypted (D7)
//   • email_event         — the high-volume raw tracking-event firehose that FEEDS `activities` (04, 15 §A.2)
// The per-tenant send-quota lives on `tenants` (mirroring reveal_credit_balance — see auth.ts). Closed enums
// here mirror packages/types/src/email.ts (the source of truth).

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { contacts } from "./contacts.ts";
import { outreachLog } from "./outreach.ts";

// Shared column idioms (kept local per the self-contained-schema convention in auth.ts/contacts.ts).
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

// ── sending_domain — per-tenant authenticated send identity (D2/D3, 03, 07) ─────────────────────────────
// TENANT-scoped (a sending domain is a tenant asset, shared across its workspaces). `domain` is GLOBALLY
// unique — no sending domain is shared across tenants (D2). DNS-auth state gates usability: a domain is
// unusable for any send until `status = 'verified'` (the P1 send path refuses an unverified domain). Carries
// `region` so residency routing is deterministic when siloing lands (known-gap #4).
export const sendingDomain = pgTable(
  "sending_domain",
  {
    id: id(),
    tenantId: tenantId(),
    domain: citext("domain").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    spfState: varchar("spf_state", { length: 20 }).notNull().default("unverified"),
    dkimState: varchar("dkim_state", { length: 20 }).notNull().default("unverified"),
    dmarcState: varchar("dmarc_state", { length: 20 }).notNull().default("unverified"),
    dkimSelector: varchar("dkim_selector", { length: 100 }),
    dkimPublicKey: varchar("dkim_public_key", { length: 2000 }),
    trackingCname: varchar("tracking_cname", { length: 255 }), // per-tenant custom tracking domain (D3)
    trackingCnameState: varchar("tracking_cname_state", { length: 20 })
      .notNull()
      .default("unverified"),
    region: varchar("region", { length: 2 }).notNull().default("US"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // D2: a domain is owned by exactly one tenant — globally unique, never shared across tenants.
    uniqDomain: uniqueIndex("uniq_sending_domain_domain").on(t.domain),
    tenantIdx: index("idx_sending_domain_tenant").on(t.tenantId, t.createdAt),
    statusEnum: check(
      "sending_domain_status_enum",
      sql`${t.status} IN ('pending','verifying','verified','failed')`,
    ),
    authStateEnum: check(
      "sending_domain_auth_state_enum",
      sql`${t.spfState} IN ('unverified','pass','fail')
        AND ${t.dkimState} IN ('unverified','pass','fail')
        AND ${t.dmarcState} IN ('unverified','pass','fail')`,
    ),
  }),
);

// ── mailbox_integration — workspace-scoped connected sending identity (D1, D7, 02) ──────────────────────
// The connected mailbox a rep sends from (Google/Microsoft OAuth, or SMTP/ESP). Credentials are encrypted at
// rest (KMS-envelope — D7, known-gap #1) and NEVER leave the server / appear in logs. Bound behind the
// EmailSenderPort seam at P1. `owner_user_id` is the connecting user (D8). `address` is the tenant's OWN
// sending address (not prospect PII), kept in clear for display + per-workspace uniqueness.
export const mailboxIntegration = pgTable(
  "mailbox_integration",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    provider: varchar("provider", { length: 20 }).notNull(),
    address: citext("address").notNull(),
    sendingDomainId: uuid("sending_domain_id").references(() => sendingDomain.id, {
      onDelete: "set null",
    }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    oauthTokenEnc: bytea("oauth_token_enc"), // KMS-envelope ciphertext (D7) — OAuth token bundle
    smtpSecretEnc: bytea("smtp_secret_enc"), // KMS-envelope ciphertext (D7) — SMTP password
    lastError: varchar("last_error", { length: 500 }),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqWsAddress: uniqueIndex("uniq_mailbox_integration_ws_address").on(t.workspaceId, t.address),
    wsIdx: index("idx_mailbox_integration_ws").on(t.workspaceId, t.createdAt),
    providerEnum: check(
      "mailbox_integration_provider_enum",
      sql`${t.provider} IN ('google','microsoft','smtp','ses')`,
    ),
    statusEnum: check(
      "mailbox_integration_status_enum",
      sql`${t.status} IN ('pending','connected','error','disconnected')`,
    ),
  }),
);

// ── email_event — high-volume raw tracking-event firehose (04, 15 §A.2) ─────────────────────────────────
// Append-only. It FEEDS `activities` (the product timeline) and drives `outreach_log` status — it does NOT
// replace them (D11). Idempotent on `provider_event_id`. Workspace-scoped.
// NOTE: 15 §A.2 targets range-partitioning BY DAY for this table; shipped as a plain table at P0 and converted
// to a partitioned parent + daily partitions when ingestion goes live at P3 — mirrors the outreach_log /
// source_imports precedent. Do NOT silently drop the partitioning intent.
export const emailEvent = pgTable(
  "email_event",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    outreachLogId: uuid("outreach_log_id").references(() => outreachLog.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    messageId: varchar("message_id", { length: 255 }), // provider message id from the send
    eventType: varchar("event_type", { length: 20 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 255 }), // ingestion idempotency key
    isMppSuspected: boolean("is_mpp_suspected").notNull().default(false), // D6 — open inflated by Apple MPP
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => ({
    // Ingestion idempotency (15 §A.2): a duplicate provider event is a no-op. Partial — our own synthetic
    // 'sent'/'delivery' rows may carry no provider event id.
    uniqProviderEvent: uniqueIndex("uniq_email_event_provider_event_id")
      .on(t.providerEventId)
      .where(sql`${t.providerEventId} IS NOT NULL`),
    // workspace_id-leading composite so timeline/analytics reads stay index-backed under the RLS workspace
    // predicate (the contacts.ts convention for workspace-scoped tables).
    wsOccurredIdx: index("idx_email_event_ws_occurred").on(t.workspaceId, t.occurredAt),
    logIdx: index("idx_email_event_log")
      .on(t.outreachLogId)
      .where(sql`${t.outreachLogId} IS NOT NULL`),
    eventTypeEnum: check(
      "email_event_type_enum",
      sql`${t.eventType} IN ('delivery','open','click','bounce','complaint','unsubscribe')`,
    ),
  }),
);
