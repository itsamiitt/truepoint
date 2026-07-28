// crm.ts — Drizzle schema for the CRM bidirectional-sync engine (crm-sync plan §4). Nine Layer-1 overlay
// tables (two-tier tenant_id + workspace_id), all ENABLE+FORCE RLS via rls/crm.sql. OAuth tokens are bytea
// ciphertext (CrmSecretStore versioned envelope), mirroring mailbox_integration (email.ts:106) — never RLS-
// protected, never in a DTO (the repository safeColumns projection omits them). Closed enums are varchar +
// CHECK whose values EQUAL the @leadwolf/types/crm.ts members exactly (no pgEnum in this repo). Three tables
// are APPEND-ONLY (crm_inbound_events, crm_sync_dead_letter; crm_sync_runs appends + mutates progress only).
//
// None of the nine is named master_* — the ^master_ catch-all REVOKE in applyMigrations would strip the app
// grant, so the name matters for correctness here, not just style.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { accounts, contacts } from "./contacts.ts";

// Shared column idioms (kept local per the self-contained-schema convention — intel.ts, contacts.ts).
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
// FK to the owning connection (8 of 9 tables); cascade so disconnecting a CRM purges its sync state.
// crmConnections is declared below — the thunk is lazy (called at query/migration build time), so the
// forward reference is safe (the same reason Drizzle FK thunks work for self-references).
const connectionId = () =>
  uuid("connection_id")
    .notNull()
    .references(() => crmConnections.id, { onDelete: "cascade" });

// ── 4.1 crm_connections — one connected CRM per (workspace, provider, account) + encrypted token bundle.
// Clone of mailbox_integration. owner_user_id is SOFT attribution (the connecting admin), NOT a per-row
// access wall — identical to contacts.owner_user_id; privileged mutations (connect/disconnect, flip
// sync_mode -> enforce) are app-gated + audited, not a row predicate.
export const crmConnections = pgTable(
  "crm_connections",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    provider: varchar("provider", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    syncMode: varchar("sync_mode", { length: 20 }).notNull().default("shadow"), // L3 dark-launch gate
    environment: varchar("environment", { length: 20 }).notNull().default("production"),
    externalAccountId: varchar("external_account_id", { length: 255 }), // SFDC org id / HubSpot hub id (non-secret)
    instanceUrl: varchar("instance_url", { length: 500 }), // SFDC API base host; null for HubSpot
    oauthTokenEnc: bytea("oauth_token_enc"), // CrmSecretStore versioned-envelope ciphertext (whole bundle)
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }), // NON-secret refresh-scheduler hint
    scopes: jsonb("scopes").notNull().default([]), // granted scopes (non-secret) for capability checks
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }), // sweep-eligibility cursor
    lastError: varchar("last_error", { length: 500 }),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // One live connection per (workspace, provider, external account); partial so pre-connect rows (no
    // account id yet) never collide.
    uniqWsProviderAccount: uniqueIndex("uniq_crm_connections_ws_provider_account")
      .on(t.workspaceId, t.provider, t.externalAccountId)
      .where(sql`${t.externalAccountId} IS NOT NULL`),
    sweepIdx: index("idx_crm_connections_sweep").on(t.status, t.nextPollAt), // the sweep enumerates due conns
    providerEnum: check(
      "crm_connections_provider_enum",
      sql`${t.provider} IN ('salesforce','hubspot')`,
    ),
    statusEnum: check(
      "crm_connections_status_enum",
      sql`${t.status} IN ('pending','connected','error','paused','disconnected')`,
    ),
    modeEnum: check(
      "crm_connections_mode_enum",
      sql`${t.syncMode} IN ('disabled','shadow','enforce')`,
    ),
    envEnum: check("crm_connections_env_enum", sql`${t.environment} IN ('production','sandbox')`),
  }),
);

// ── 4.2 crm_record_links — external-id <-> contact/account 1:1 map; the REAL durable write-idempotency
// guard (not the convenience middleware). Analog of the overlay->master bridge (contacts.master_person_id)
// + the external-id precedent sales_nav_links. Lead->Contact conversion re-points THIS row (UPDATE
// crm_object_type + crm_record_id); no new row, no broken link (§4.2).
export const crmRecordLinks = pgTable(
  "crm_record_links",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(), // denormalized for direct RLS on this highest-volume table
    connectionId: connectionId(),
    tpEntityType: varchar("tp_entity_type", { length: 20 }).notNull(), // which TP table: 'contact' | 'account'
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    crmObjectType: varchar("crm_object_type", { length: 40 }).notNull(), // raw CRM object ('Contact'|'contacts'|...)
    crmRecordId: varchar("crm_record_id", { length: 255 }).notNull(), // the CRM Record ID (hs_object_id / SFDC 18-char)
    externalKey: varchar("external_key", { length: 255 }), // the upsert key WE set on the CRM (= TruePoint UUID)
    lastSyncedHash: bytea("last_synced_hash"), // sha256(mapped field-set) -> content-hash no-op / echo guard
    lastInboundModstamp: timestamp("last_inbound_modstamp", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    linkStatus: varchar("link_status", { length: 20 }).notNull().default("linked"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // The two 1:1 idempotency walls — the actual durable guard:
    uniqCrm: uniqueIndex("uniq_crm_record_links_crm").on(
      t.connectionId,
      t.crmObjectType,
      t.crmRecordId,
    ),
    uniqContact: uniqueIndex("uniq_crm_record_links_contact")
      .on(t.connectionId, t.contactId)
      .where(sql`${t.contactId} IS NOT NULL`),
    uniqAccount: uniqueIndex("uniq_crm_record_links_account")
      .on(t.connectionId, t.accountId)
      .where(sql`${t.accountId} IS NOT NULL`),
    reconIdx: index("idx_crm_record_links_recon").on(t.connectionId, t.lastInboundModstamp), // reconcile scan
    typeEnum: check("crm_record_links_type_enum", sql`${t.tpEntityType} IN ('contact','account')`),
    statusEnum: check(
      "crm_record_links_status_enum",
      sql`${t.linkStatus} IN ('linked','ambiguous','broken')`,
    ),
    exactlyOne: check(
      "crm_record_links_exactly_one",
      sql`num_nonnulls(${t.contactId}, ${t.accountId}) = 1`,
    ),
  }),
);

// ── 4.3 crm_field_mappings — per-(connection, object, field) direction/authority/transform. Mirrors the
// crmFieldMappingSchema DTO. transform is a KEY into a closed code-side registry (crmTransform) — never
// executable code. A starter set is seeded in code at connect time.
export const crmFieldMappings = pgTable(
  "crm_field_mappings",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    connectionId: connectionId(),
    objectType: varchar("object_type", { length: 20 }).notNull(),
    tpField: varchar("tp_field", { length: 100 }).notNull(), // 'jobTitle' or a custom-field key 'cf:renewal_date'
    crmField: varchar("crm_field", { length: 255 }).notNull(), // 'Title' / 'My_Field__c' / 'jobtitle'
    direction: varchar("direction", { length: 20 }).notNull().default("inbound"), // conservative default = enrich-in
    authority: varchar("authority", { length: 20 }).notNull().default("crm"), // source-of-truth per field
    confThreshold: numeric("conf_threshold", { precision: 4, scale: 3 }), // overwrite an unpinned field only when conf > threshold
    transform: varchar("transform", { length: 40 }).notNull().default("passthrough"),
    transformConfig: jsonb("transform_config").notNull().default({}), // params for the named transform
    isRequired: boolean("is_required").notNull().default(false),
    isDedupKey: boolean("is_dedup_key").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqMapping: uniqueIndex("uniq_crm_field_mappings").on(
      t.connectionId,
      t.objectType,
      t.tpField,
      t.crmField,
    ),
    objectTypeEnum: check(
      "crm_field_mappings_object_type_enum",
      sql`${t.objectType} IN ('contact','account','lead','deal')`,
    ),
    directionEnum: check(
      "crm_field_mappings_direction_enum",
      sql`${t.direction} IN ('inbound','outbound','bidirectional','disabled')`,
    ),
    authorityEnum: check(
      "crm_field_mappings_authority_enum",
      sql`${t.authority} IN ('crm','truepoint')`,
    ),
    transformEnum: check(
      "crm_field_mappings_transform_enum",
      sql`${t.transform} IN ('passthrough','phone_e164','lowercase','seniority_map','date_iso','picklist_map')`,
    ),
  }),
);

// ── 4.4 crm_sync_state — singleton watermark + backfill cursor per (connection, object, direction).
// Models master_companies.prov_hwm (the monotonic re-projection guard). Inbound and outbound keep SEPARATE
// watermarks (loop prevention, §6.4). last_run_id forward-refs crm_sync_runs.
export const crmSyncState = pgTable(
  "crm_sync_state",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    connectionId: connectionId(),
    objectType: varchar("object_type", { length: 20 }).notNull(),
    direction: varchar("direction", { length: 20 }).notNull(), // binary flow direction: inbound | outbound
    watermark: timestamp("watermark", { withTimezone: true }), // max applied SystemModstamp / hs_lastmodifieddate
    replayId: varchar("replay_id", { length: 255 }), // SFDC CDC resume; null for HubSpot/poll
    backfillStatus: varchar("backfill_status", { length: 20 }).notNull().default("pending"),
    backfillCursor: varchar("backfill_cursor", { length: 512 }), // resumable page token / Bulk-API job id
    // SET NULL: a run row may be pruned without orphaning the watermark. Forward thunk (crmSyncRuns declared
    // below) typed AnyPgColumn to break the circular type inference — the self/forward-FK idiom.
    lastRunId: uuid("last_run_id").references((): AnyPgColumn => crmSyncRuns.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqStream: uniqueIndex("uniq_crm_sync_state_stream").on(
      t.connectionId,
      t.objectType,
      t.direction,
    ),
    objectTypeEnum: check(
      "crm_sync_state_object_type_enum",
      sql`${t.objectType} IN ('contact','account','lead','deal')`,
    ),
    directionEnum: check(
      "crm_sync_state_direction_enum",
      sql`${t.direction} IN ('inbound','outbound')`,
    ),
    backfillStatusEnum: check(
      "crm_sync_state_backfill_status_enum",
      sql`${t.backfillStatus} IN ('pending','running','completed')`,
    ),
  }),
);

// ── 4.5 crm_inbound_events — raw inbound webhook/CDC firehose; the redelivered-webhook dedupe wall.
// APPEND-ONLY (rls/crm.sql gives SELECT + INSERT only — the retention_runs wall). Ingested via
// onConflictDoNothing on (connection_id, provider_event_id). Payloads are deltas -> the worker ALWAYS
// re-fetches the canonical record before applying (§4.5). No updated_at (immutable).
export const crmInboundEvents = pgTable(
  "crm_inbound_events",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    connectionId: connectionId(),
    provider: varchar("provider", { length: 20 }).notNull(),
    objectType: varchar("object_type", { length: 20 }).notNull(),
    crmObjectType: varchar("crm_object_type", { length: 40 }).notNull(),
    crmRecordId: varchar("crm_record_id", { length: 255 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 255 }).notNull(), // {crmRecordId}:{replayId|modstamp}
    eventType: varchar("event_type", { length: 60 }),
    sourceTag: varchar("source_tag", { length: 120 }), // origin filter for loop prevention (§6.6)
    processStatus: varchar("process_status", { length: 20 }).notNull().default("pending"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    // The DB-layer idempotency wall for redelivered webhooks/CDC (onConflictDoNothing target).
    uniqEvent: uniqueIndex("uniq_crm_inbound_events_provider_event").on(
      t.connectionId,
      t.providerEventId,
    ),
    unprocessedIdx: index("idx_crm_inbound_events_unprocessed").on(
      t.connectionId,
      t.processStatus,
      t.receivedAt,
    ),
    providerEnum: check(
      "crm_inbound_events_provider_enum",
      sql`${t.provider} IN ('salesforce','hubspot')`,
    ),
    objectTypeEnum: check(
      "crm_inbound_events_object_type_enum",
      sql`${t.objectType} IN ('contact','account','lead','deal')`,
    ),
    processStatusEnum: check(
      "crm_inbound_events_process_status_enum",
      sql`${t.processStatus} IN ('pending','processed','skipped','failed')`,
    ),
  }),
);

// ── 4.6 crm_sync_runs — per-batch run ledger; the durable metric / FinOps store. Modeled on retention_runs
// (the append + mode-snapshot evidence pattern). APPEND + IN-PLACE PROGRESS: rls/crm.sql gives SELECT +
// INSERT + UPDATE (running -> completed; counts mutate), NO DELETE (like import_jobs). mode snapshots the
// connection's sync_mode at run time so a shadow "counted-but-didn't-write" run stays auditable.
export const crmSyncRuns = pgTable(
  "crm_sync_runs",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    connectionId: connectionId(),
    provider: varchar("provider", { length: 20 }).notNull(),
    objectType: varchar("object_type", { length: 20 }).notNull(),
    direction: varchar("direction", { length: 20 }).notNull(), // inbound | outbound
    trigger: varchar("trigger", { length: 20 }).notNull(),
    mode: varchar("mode", { length: 20 }).notNull(), // snapshot of connection.sync_mode at run time
    status: varchar("status", { length: 20 }).notNull().default("running"),
    recordsSeen: integer("records_seen").notNull().default(0),
    recordsCreated: integer("records_created").notNull().default(0),
    recordsUpdated: integer("records_updated").notNull().default(0),
    recordsMatched: integer("records_matched").notNull().default(0),
    recordsSkipped: integer("records_skipped").notNull().default(0),
    recordsConflicted: integer("records_conflicted").notNull().default(0),
    recordsFailed: integer("records_failed").notNull().default(0),
    apiCalls: integer("api_calls").notNull().default(0), // FinOps signal
    rateLimitedCt: integer("rate_limited_ct").notNull().default(0),
    rateLimitRemaining: integer("rate_limit_remaining"),
    watermarkBefore: timestamp("watermark_before", { withTimezone: true }),
    watermarkAfter: timestamp("watermark_after", { withTimezone: true }),
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    syncRunId: uuid("sync_run_id"), // correlation / poor-man's-trace id (not an FK)
    failedReason: text("failed_reason"), // PII-free
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    // Recency reads stay index-backed under the RLS workspace predicate (the provider_calls perf pattern):
    // newest-first slice = backward index scan, not seq-scan + sort.
    wsCreatedIdx: index("idx_crm_sync_runs_ws_created").on(t.workspaceId, t.createdAt.desc()),
    connStartedIdx: index("idx_crm_sync_runs_conn_started").on(t.connectionId, t.startedAt.desc()),
    providerEnum: check(
      "crm_sync_runs_provider_enum",
      sql`${t.provider} IN ('salesforce','hubspot')`,
    ),
    objectTypeEnum: check(
      "crm_sync_runs_object_type_enum",
      sql`${t.objectType} IN ('contact','account','lead','deal')`,
    ),
    directionEnum: check(
      "crm_sync_runs_direction_enum",
      sql`${t.direction} IN ('inbound','outbound')`,
    ),
    triggerEnum: check(
      "crm_sync_runs_trigger_enum",
      sql`${t.trigger} IN ('backfill','scheduled','webhook','manual','replay','dsar')`,
    ),
    modeEnum: check("crm_sync_runs_mode_enum", sql`${t.mode} IN ('disabled','shadow','enforce')`),
    statusEnum: check(
      "crm_sync_runs_status_enum",
      sql`${t.status} IN ('running','completed','partial','failed','cancelled')`,
    ),
  }),
);

// ── 4.7 crm_sync_conflicts — human review queue for a SUCCESSFUL sync needing arbitration (distinct from
// an error -> DLQ). SECURITY (§4.7): non-PII scalars store tp_value/crm_value in clear; PII fields
// (email/phone) store only a MASKED diff (last-4 / a `differs` flag) and reference the contact — the real
// value stays in contacts.email_enc. A review queue must not become a new cleartext-PII store.
export const crmSyncConflicts = pgTable(
  "crm_sync_conflicts",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    connectionId: connectionId(),
    recordLinkId: uuid("record_link_id").references(() => crmRecordLinks.id, {
      onDelete: "set null",
    }),
    objectType: varchar("object_type", { length: 20 }).notNull(),
    field: varchar("field", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    tpValue: text("tp_value"), // cleartext ONLY for non-PII scalars; masked diff for PII (§4.7)
    crmValue: text("crm_value"), // same masking rule
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    openIdx: index("idx_crm_sync_conflicts_open").on(t.workspaceId, t.status, t.createdAt.desc()), // review-queue read
    objectTypeEnum: check(
      "crm_sync_conflicts_object_type_enum",
      sql`${t.objectType} IN ('contact','account','lead','deal')`,
    ),
    statusEnum: check(
      "crm_sync_conflicts_status_enum",
      sql`${t.status} IN ('open','resolved','ignored')`,
    ),
  }),
);

// ── 4.8 crm_sync_dead_letter — PII-free poison-job DLQ, written only after BullMQ retries exhaust
// (deadLetterFailedImport pattern). APPEND-ONLY for the app role (rls/crm.sql: SELECT + INSERT only); the
// status transitions (open -> retrying/resolved/ignored) happen on the staff DLQ-replay console via the
// owner/withPlatformTx (BYPASSRLS) path, which the app-role policy wall does not gate (§7.1). error_detail
// is a PII-free reason (provider code/snippet) — NEVER a field value or token. tp_entity_id is an id only.
export const crmSyncDeadLetter = pgTable(
  "crm_sync_dead_letter",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    connectionId: connectionId(),
    runId: uuid("run_id").references(() => crmSyncRuns.id, { onDelete: "set null" }),
    queue: varchar("queue", { length: 40 }).notNull(), // the origin queue name (discriminator)
    direction: varchar("direction", { length: 20 }), // nullable: a sweep-level failure has no direction
    objectType: varchar("object_type", { length: 20 }),
    crmObjectType: varchar("crm_object_type", { length: 40 }),
    crmRecordId: varchar("crm_record_id", { length: 255 }), // opaque, aids replay
    tpEntityId: uuid("tp_entity_id"), // id only (no FK: the entity may be tombstoned)
    errorClass: varchar("error_class", { length: 30 }).notNull(),
    errorDetail: varchar("error_detail", { length: 1000 }), // PII-free reason; never field values or token
    attempts: integer("attempts").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => ({
    openIdx: index("idx_crm_sync_dead_letter_open").on(t.workspaceId, t.status, t.createdAt.desc()),
    errorClassEnum: check(
      "crm_sync_dead_letter_error_class_enum",
      sql`${t.errorClass} IN ('rate_limited','auth','validation','conflict_unresolved','transform','not_found','provider_5xx','ssrf_blocked','suppressed','unknown')`,
    ),
    statusEnum: check(
      "crm_sync_dead_letter_status_enum",
      sql`${t.status} IN ('open','retrying','resolved','ignored')`,
    ),
    directionEnum: check(
      "crm_sync_dead_letter_direction_enum",
      sql`${t.direction} IS NULL OR ${t.direction} IN ('inbound','outbound')`,
    ),
    objectTypeEnum: check(
      "crm_sync_dead_letter_object_type_enum",
      sql`${t.objectType} IS NULL OR ${t.objectType} IN ('contact','account','lead','deal')`,
    ),
  }),
);

// ── 4.9 crm_oauth_states — short-lived PKCE/state CSRF handshake (analog of the single-use auth code).
// code_verifier_enc is bytea ciphertext via CrmSecretStore (never RLS-protected, never a DTO). state is
// globally unique. ~10-min TTL row, consumed once (consumed_at) then ignored/expired.
export const crmOauthStates = pgTable(
  "crm_oauth_states",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    provider: varchar("provider", { length: 20 }).notNull(),
    state: varchar("state", { length: 255 }).notNull(),
    codeVerifierEnc: bytea("code_verifier_enc"), // CrmSecretStore ciphertext (PKCE verifier)
    redirectUri: varchar("redirect_uri", { length: 500 }),
    environment: varchar("environment", { length: 20 }).notNull().default("production"),
    scopes: jsonb("scopes").notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqState: uniqueIndex("uniq_crm_oauth_states_state").on(t.state), // single-use CSRF token
    providerEnum: check(
      "crm_oauth_states_provider_enum",
      sql`${t.provider} IN ('salesforce','hubspot')`,
    ),
    envEnum: check("crm_oauth_states_env_enum", sql`${t.environment} IN ('production','sandbox')`),
  }),
);
