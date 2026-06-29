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
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { contacts } from "./contacts.ts";
import { outreachLog, outreachSequences } from "./outreach.ts";

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
    // ── OAuth token lifecycle (M12 P1) — non-secret metadata kept in clear so the refresh worker can act
    // WITHOUT decrypting the bundle. The access+refresh tokens themselves stay in oauth_token_enc (D7).
    oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }), // proactive-refresh cursor
    oauthScopes: text("oauth_scopes").array(), // the granted scopes (display + downgrade detection)
    providerAccountId: varchar("provider_account_id", { length: 255 }), // Gmail emailAddress / Graph user id
    reauthRequired: boolean("reauth_required").notNull().default(false), // invalid_grant → "Reconnect" UX
    reauthReason: varchar("reauth_reason", { length: 120 }),
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
      // M12 P3 reconciliation (doc-04 §2 vs doc-09): `reply`/`auto_reply` make an inbound reply representable
      // in the firehose (the reply auto-pauses the sequence; an auto_reply/OOO never counts as a human reply).
      sql`${t.eventType} IN ('delivery','open','click','bounce','complaint','unsubscribe','reply','auto_reply')`,
    ),
  }),
);

// ── email_template — reusable, versioned, render-safe templates (M12 P2, 01, 09; email-planning/13 P2) ───
// Genuinely-new (D11): externalises what is today inline in outreach_steps.subject/body. Workspace-scoped +
// OWNER-scoped (D8): visible to its owner + (when `shared`) the workspace. The current_version_id points at
// the latest email_template_version; versions are immutable + append-only so a sent step can pin one.
export const emailTemplate = pgTable(
  "email_template",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    name: varchar("name", { length: 255 }).notNull(),
    channel: varchar("channel", { length: 20 }).notNull().default("email"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    shared: boolean("shared").notNull().default(false), // false = owner-only (D8); true = workspace-shared
    currentVersionId: uuid("current_version_id"), // cache pointer to the latest version (app-maintained, no FK)
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqWsName: uniqueIndex("uniq_email_template_ws_name").on(t.workspaceId, t.name),
    wsOwnerIdx: index("idx_email_template_ws_owner").on(t.workspaceId, t.ownerUserId),
    channelEnum: check("email_template_channel_enum", sql`${t.channel} IN ('email','linkedin')`),
    statusEnum: check("email_template_status_enum", sql`${t.status} IN ('active','archived')`),
  }),
);

// ── email_template_version — the immutable, append-only content of a template at a point in time ─────────
export const emailTemplateVersion = pgTable(
  "email_template_version",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => emailTemplate.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    subject: varchar("subject", { length: 255 }),
    body: text("body").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqTemplateVersion: uniqueIndex("uniq_email_template_version").on(t.templateId, t.version),
  }),
);

// ── oauth_connect_state — short-lived CSRF + PKCE handshake store for the mailbox OAuth redirect (M12 P1) ──
// When a user clicks "Connect" we mint a high-entropy `state_token` (echoed by the provider) bound to the
// originating tenant/workspace/user, and stash the PKCE verifier ENCRYPTED (secretStore). The session-less
// callback resolves the row by `state_token`, exchanges the code, and is consumed-once (`consumed_at`).
// RLS is ENABLE (not FORCE): the START insert runs as leadwolf_app under the tenant GUC, but the session-less
// callback reads by the secret token on the OWNER connection (RLS-exempt as table owner — the
// platform_audit_log pattern), which a FORCE policy would wrongly block. Rows are TTL-swept (`expires_at`).
export const oauthConnectState = pgTable(
  "oauth_connect_state",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 20 }).notNull(),
    stateToken: varchar("state_token", { length: 80 }).notNull(),
    pkceVerifierEnc: bytea("pkce_verifier_enc").notNull(), // secretStore ciphertext — never in clear/logs
    redirectAfter: varchar("redirect_after", { length: 500 }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => ({
    uniqStateToken: uniqueIndex("uniq_oauth_connect_state_token").on(t.stateToken),
    tenantIdx: index("idx_oauth_connect_state_tenant").on(t.tenantId, t.createdAt),
    providerEnum: check(
      "oauth_connect_state_provider_enum",
      sql`${t.provider} IN ('google','microsoft')`,
    ),
  }),
);

// ── email_thread — a conversation in the unified inbox (M12 P3; net-new, D11) ────────────────────────────
// WORKSPACE-scoped + OWNER-scoped (D8 — the strictest inbox surface; owner-scope is an app filter ON TOP of
// RLS). Groups inbound + outbound email_messages by the provider thread (Gmail threadId / Graph
// conversationId) and ties them to the contact + the originating sequence, so a confirmed reply can auto-pause
// the enrollment (outreach_log.last_reply_at). Reply bodies live on email_message, never here.
export const emailThread = pgTable(
  "email_thread",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    mailboxIntegrationId: uuid("mailbox_integration_id").references(() => mailboxIntegration.id, {
      onDelete: "set null",
    }),
    sequenceId: uuid("sequence_id").references(() => outreachSequences.id, {
      onDelete: "set null",
    }),
    providerThreadId: varchar("provider_thread_id", { length: 255 }), // Gmail threadId / Graph conversationId
    subjectNormalized: varchar("subject_normalized", { length: 255 }),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // Inbox list read: newest-active first under the workspace RLS predicate.
    wsLastMsgIdx: index("idx_email_thread_ws_last_message").on(t.workspaceId, t.lastMessageAt),
    ownerIdx: index("idx_email_thread_ws_owner").on(t.workspaceId, t.ownerUserId),
    // Dedup a provider thread within a mailbox so sync attaches messages to ONE thread.
    uniqProviderThread: uniqueIndex("uniq_email_thread_provider")
      .on(t.mailboxIntegrationId, t.providerThreadId)
      .where(sql`${t.providerThreadId} IS NOT NULL`),
    statusEnum: check("email_thread_status_enum", sql`${t.status} IN ('open','snoozed','done')`),
  }),
);

// ── email_message — one message in a thread (M12 P1 outbound / P3 inbound; net-new, D11) ─────────────────
// The per-message record + the per-send Message-ID store reply threading needs. ADDITIVE — does NOT replace
// outreach_log / sendStep (D11): an outbound row links back via outreach_log_id and carries the rfc822
// Message-ID we set on the send (the key a reply's In-Reply-To/References matches). The body is ENCRYPTED at
// rest (PII — masked by role, retention/DSAR-governed, D7). Deduped on (mailbox, provider_message_id) so a
// re-delivered provider notification is a no-op.
export const emailMessage = pgTable(
  "email_message",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => emailThread.id, { onDelete: "cascade" }),
    mailboxIntegrationId: uuid("mailbox_integration_id").references(() => mailboxIntegration.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    outreachLogId: uuid("outreach_log_id").references(() => outreachLog.id, {
      onDelete: "set null",
    }),
    direction: varchar("direction", { length: 10 }).notNull(),
    providerMessageId: varchar("provider_message_id", { length: 255 }), // Gmail message id / Graph id
    rfc822MessageId: varchar("rfc822_message_id", { length: 998 }), // the RFC 5322 Message-ID — threading key
    inReplyTo: varchar("in_reply_to", { length: 998 }),
    referenceIds: text("reference_ids").array(), // the References-header Message-ID chain (oldest→newest)
    subject: varchar("subject", { length: 255 }),
    snippet: varchar("snippet", { length: 280 }), // short preview for the inbox list
    fromAddr: citext("from_addr").notNull(),
    toAddrs: text("to_addrs").array(),
    bodyEnc: bytea("body_enc"), // KMS-envelope ciphertext (PII) — masked by role, retention/DSAR-governed (D7)
    isAutoReply: boolean("is_auto_reply").notNull().default(false),
    classification: varchar("classification", { length: 20 }).notNull().default("unknown"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    threadIdx: index("idx_email_message_thread").on(t.threadId, t.occurredAt),
    wsOccurredIdx: index("idx_email_message_ws_occurred").on(t.workspaceId, t.occurredAt),
    // Reply threading: resolve our outbound Message-ID from a reply's In-Reply-To/References (workspace-scoped).
    rfcIdx: index("idx_email_message_rfc822")
      .on(t.workspaceId, t.rfc822MessageId)
      .where(sql`${t.rfc822MessageId} IS NOT NULL`),
    // Ingestion dedup: a provider message is stored at most once per mailbox.
    uniqProviderMessage: uniqueIndex("uniq_email_message_provider")
      .on(t.mailboxIntegrationId, t.providerMessageId)
      .where(sql`${t.providerMessageId} IS NOT NULL`),
    directionEnum: check(
      "email_message_direction_enum",
      sql`${t.direction} IN ('inbound','outbound')`,
    ),
    classificationEnum: check(
      "email_message_classification_enum",
      sql`${t.classification} IN ('human','auto_reply','ooo','bounce','unknown')`,
    ),
  }),
);
