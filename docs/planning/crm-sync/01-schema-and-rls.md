# CRM Sync — Concrete Persistence Design (Schema + RLS), phase 1

> **Status:** Reviewable design **DRAFT**. This is the turnkey persistence layer for the nine
> CRM-sync tables of `docs/planning/crm-sync/00-enterprise-implementation-plan.md` (`§4` data model,
> `§7.1` RLS posture, `§4.10` provenance, `§4.11` enum/audit additions). **Code scope:** `@leadwolf/*`
> (product brand TruePoint). Every block below is copy-paste-ready against the repo's real idioms; each
> idiom it mirrors cites a `file:line` on `origin/main` / the CRM-sync branch.
>
> **This doc is intentionally NOT wired in.** It does **not** create `packages/db/src/schema/crm.ts`
> or `packages/db/src/rls/crm.sql`, does **not** touch the schema barrel (`schema/index.ts`), and does
> **not** add a migration to the journal. That keeps it from colliding with the in-flight data-mgmt
> migrations and from producing any `drizzle-kit` drift. It is schema **design** only.

---

## 0. Post-merge formalization (how this becomes real)

When the migration base is settled (see `§5`), the formalization is mechanical:

1. Create `packages/db/src/schema/crm.ts` from **Block A** verbatim.
2. Create `packages/db/src/rls/crm.sql` from **Block B** verbatim (auto-applied alphabetically after
   `contacts.sql`, so the shared `set_updated_at()` function already exists — `applyMigrations.ts:192-197`).
3. Add `export * from "./crm.ts";` to `packages/db/src/schema/index.ts` (the barrel — `schema/index.ts:1`).
4. Apply the **Block C** enum/audit additions (5 `audit_log.action` values + 2 `platformAuditAction`
   values) in their source-of-truth files.
5. Run `drizzle-kit generate` — it emits the table migration (`CREATE TABLE` + indexes + CHECKs) and the
   snapshot, **numbered after the settled base** (`§5`). `rls/crm.sql` is hand-authored (not generated),
   exactly like every existing `rls/*.sql`.

The migration model that makes the RLS write-wall work: `applyMigrations` runs phases
**[2/4] table migrations -> [3/4] every `rls/*.sql` (sorted) -> [4/4] the blanket
`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES ... TO leadwolf_app`** (`applyMigrations.ts:184-200`,
`GRANTS` at `:71-77`). Because the blanket GRANT runs **after** the policies and re-widens the app role,
isolation is **never** the grant — it is **`FORCE ROW LEVEL SECURITY` + the presence/absence of a
policy per command**. An append-only table is one that simply has **no `UPDATE`/`DELETE` policy** under
FORCE RLS (the `retention_runs` wall, `rls/retention.sql:36-47`).

---

## 1. The nine tables at a glance

All nine are **Layer-1 overlay**: two-tier `tenant_id` + `workspace_id` (both `NOT NULL`, FK
`onDelete: cascade`), `ENABLE` + `FORCE ROW LEVEL SECURITY`, the fail-closed workspace-GUC policy
(`rls/contacts.sql:31-33`). None is named `master_*` (the `^master_` catch-all `REVOKE` at
`applyMigrations.ts:125-129` would strip the app grant), so each correctly takes the blanket grant and
relies on FORCE RLS (`§7.1`).

| # | Table | Purpose | Write model |
|---|---|---|---|
| 4.1 | `crm_connections` | One connected CRM per (workspace, provider, account) + encrypted OAuth bundle | Full RLS (CRUD); privileged mutations app-gated + audited |
| 4.2 | `crm_record_links` | external-id <-> contact/account **1:1** map; the durable write-idempotency anchor | Full RLS (CRUD) |
| 4.3 | `crm_field_mappings` | per-(connection, object, field) direction / authority / transform | Full RLS (CRUD) |
| 4.4 | `crm_sync_state` | per-(connection, object, direction) watermark + backfill cursor (singleton) | Full RLS (CRUD; UPDATE every sync) |
| 4.5 | `crm_inbound_events` | raw inbound webhook/CDC firehose; redelivery dedupe wall | **APPEND-ONLY** (SELECT + INSERT) |
| 4.6 | `crm_sync_runs` | per-batch run ledger (the durable metric/FinOps store) | **APPEND + in-place progress** (SELECT + INSERT + UPDATE, no DELETE) |
| 4.7 | `crm_sync_conflicts` | human conflict-review queue (PII-masked) | Full RLS (CRUD) |
| 4.8 | `crm_sync_dead_letter` | PII-free poison-job DLQ | **APPEND-ONLY** for the app role (SELECT + INSERT); status mutated only on the staff/admin BYPASSRLS path |
| 4.9 | `crm_oauth_states` | short-lived PKCE/state CSRF handshake | Full RLS (CRUD) |

### 1.1 Two deliberate reconciliations with the plan prose (reconcile-and-cite)

The plan's `§4` prose predates the foundation enums in `packages/types/src/crm.ts`; this draft makes the
DB CHECKs **equal the type enums exactly** (the `§4.11` stated principle: *"closed CHECK enums, mirrored
in `@leadwolf/types`"*), which is also what keeps producer and consumer from drifting. Two values differ
from the prose and are aligned to the types on purpose:

- **`provider`** -> `('salesforce','hubspot')`, mirroring `crmProvider` (`crm.ts:26`). The `§4.1`
  prose CHECK additionally listed `'pipedrive'`, but the foundation enum does **not** include it
  (Pipedrive is the explicit fast-follow, `§1.3`). Adding it later is a one-line CHECK + enum edit when
  the adapter ships. Using the type's two values now is the correct closed wall.
- **`object_type`** -> the full `crmObjectType` `('contact','account','lead','deal')` (`crm.ts:30`),
  matching `crmFieldMappingSchema.objectType` (`crm.ts:91`). The prose narrowed it to
  `('contact','account')`; the four-value enum **reserves** `lead`/`deal` (`§1.3`: *"the
  `crm_object_type` enum reserves the values"*) while the app layer + the non-goals keep phase-1 writes
  to contacts/accounts only. The DB accepting a reserved value it is never handed is the standard
  reserve-the-enum posture.

Three columns are **not** type-enum mirrors and keep their plan-defined local domains (no `@leadwolf/types`
counterpart exists, by design):
- `crm_record_links.tp_entity_type` `('contact','account')` — *which TruePoint table* the link points at;
  TruePoint has only contacts + accounts as linkable entities (not the CRM-side `crmObjectType`).
- the **flow direction** on `crm_sync_state` / `crm_sync_runs` / `crm_sync_dead_letter`,
  `('inbound','outbound')` — the binary data-flow direction of a stream/run, distinct from the *per-field
  policy* `crmSyncDirection` (which adds `bidirectional`/`disabled`, and is used **only** by
  `crm_field_mappings.direction`, `crm.ts:34`).
- the lifecycle sets `link_status`, `backfill_status`, run `status`/`trigger`, conflict/DLQ `status`,
  `process_status` — plan-defined closed sets with no type-enum counterpart.

`crm_sync_runs.mode` uses the **full** `crmSyncMode` `('disabled','shadow','enforce')` (`crm.ts:38`),
matching both the type and the cited model `retention_runs.mode` (`rls`/schema use the same three values).

---

## Block A — `packages/db/src/schema/crm.ts` (the future Drizzle schema)

Modeled file-for-file on `schema/intel.ts` (the close shape: self-contained local helpers, the `bytea`
`customType`, `varchar + check()` closed enums, `index`/`uniqueIndex`) and `schema/contacts.ts` (the
`createdAt()`/`updatedAt()` helpers and the `(): AnyPgColumn =>` forward-FK thunk for a self/forward
reference). The encrypted-token columns mirror `mailbox_integration` (`schema/email.ts:106-112`):
`bytea` ciphertext for the secret bundle + **non-secret** refresh metadata kept in clear so the refresh
worker never has to decrypt.

```ts
// crm.ts — Drizzle schema for the CRM bidirectional-sync engine (crm-sync plan §4). Nine Layer-1 overlay
// tables (two-tier tenant_id + workspace_id), all ENABLE+FORCE RLS via rls/crm.sql. OAuth tokens are bytea
// ciphertext (CrmSecretStore versioned envelope), mirroring mailbox_integration (email.ts:106) — never RLS-
// protected, never in a DTO (the repository safeColumns projection omits them). Closed enums are varchar +
// CHECK whose values EQUAL the @leadwolf/types/crm.ts members exactly (no pgEnum in this repo). Three tables
// are APPEND-ONLY (crm_inbound_events, crm_sync_dead_letter; crm_sync_runs appends + mutates progress only).

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

// Shared column idioms (kept local per the self-contained-schema convention — intel.ts:24-33, contacts.ts:26-39).
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
// forward reference is safe (the same reason Drizzle FK thunks work for self-references, contacts.ts:155).
const connectionId = () =>
  uuid("connection_id")
    .notNull()
    .references(() => crmConnections.id, { onDelete: "cascade" });

// ── 4.1 crm_connections — one connected CRM per (workspace, provider, account) + encrypted token bundle.
// Clone of mailbox_integration (email.ts:93). owner_user_id is SOFT attribution (the connecting admin),
// NOT a per-row access wall — identical to contacts.owner_user_id (contacts.ts:113-117); privileged
// mutations (connect/disconnect, flip sync_mode -> enforce) are app-gated + audited, not a row predicate.
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
    // account id yet) never collide (the partial-unique idiom, salesnav.ts:50-52).
    uniqWsProviderAccount: uniqueIndex("uniq_crm_connections_ws_provider_account")
      .on(t.workspaceId, t.provider, t.externalAccountId)
      .where(sql`${t.externalAccountId} IS NOT NULL`),
    sweepIdx: index("idx_crm_connections_sweep").on(t.status, t.nextPollAt), // the sweep enumerates due conns
    providerEnum: check("crm_connections_provider_enum", sql`${t.provider} IN ('salesforce','hubspot')`),
    statusEnum: check(
      "crm_connections_status_enum",
      sql`${t.status} IN ('pending','connected','error','paused','disconnected')`,
    ),
    modeEnum: check("crm_connections_mode_enum", sql`${t.syncMode} IN ('disabled','shadow','enforce')`),
    envEnum: check("crm_connections_env_enum", sql`${t.environment} IN ('production','sandbox')`),
  }),
);

// ── 4.2 crm_record_links — external-id <-> contact/account 1:1 map; the REAL durable write-idempotency
// guard (not the convenience middleware). Analog of the overlay->master bridge (contacts.master_person_id,
// contacts.ts:112) + the external-id precedent sales_nav_links (salesnav.ts:21-58). Lead->Contact
// conversion re-points THIS row (UPDATE crm_object_type + crm_record_id); no new row, no broken link (§4.2).
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
    uniqCrm: uniqueIndex("uniq_crm_record_links_crm").on(t.connectionId, t.crmObjectType, t.crmRecordId),
    uniqContact: uniqueIndex("uniq_crm_record_links_contact")
      .on(t.connectionId, t.contactId)
      .where(sql`${t.contactId} IS NOT NULL`),
    uniqAccount: uniqueIndex("uniq_crm_record_links_account")
      .on(t.connectionId, t.accountId)
      .where(sql`${t.accountId} IS NOT NULL`),
    reconIdx: index("idx_crm_record_links_recon").on(t.connectionId, t.lastInboundModstamp), // reconcile scan
    typeEnum: check("crm_record_links_type_enum", sql`${t.tpEntityType} IN ('contact','account')`),
    statusEnum: check("crm_record_links_status_enum", sql`${t.linkStatus} IN ('linked','ambiguous','broken')`),
    exactlyOne: check("crm_record_links_exactly_one", sql`num_nonnulls(${t.contactId}, ${t.accountId}) = 1`),
  }),
);

// ── 4.3 crm_field_mappings — per-(connection, object, field) direction/authority/transform. Mirrors the
// crmFieldMappingSchema DTO (crm.ts:90-101). transform is a KEY into a closed code-side registry
// (crmTransform, crm.ts:63) — never executable code. A starter set is seeded in code at connect time.
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
    authorityEnum: check("crm_field_mappings_authority_enum", sql`${t.authority} IN ('crm','truepoint')`),
    transformEnum: check(
      "crm_field_mappings_transform_enum",
      sql`${t.transform} IN ('passthrough','phone_e164','lowercase','seniority_map','date_iso','picklist_map')`,
    ),
  }),
);

// ── 4.4 crm_sync_state — singleton watermark + backfill cursor per (connection, object, direction).
// Models master_companies.prov_hwm (the monotonic re-projection guard, masterGraph.ts). Inbound and
// outbound keep SEPARATE watermarks (loop prevention, §6.4). last_run_id forward-refs crm_sync_runs.
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
    // below) typed AnyPgColumn to break the circular type inference — the self/forward-FK idiom (contacts.ts:155).
    lastRunId: uuid("last_run_id").references((): AnyPgColumn => crmSyncRuns.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uniqStream: uniqueIndex("uniq_crm_sync_state_stream").on(t.connectionId, t.objectType, t.direction),
    objectTypeEnum: check(
      "crm_sync_state_object_type_enum",
      sql`${t.objectType} IN ('contact','account','lead','deal')`,
    ),
    directionEnum: check("crm_sync_state_direction_enum", sql`${t.direction} IN ('inbound','outbound')`),
    backfillStatusEnum: check(
      "crm_sync_state_backfill_status_enum",
      sql`${t.backfillStatus} IN ('pending','running','completed')`,
    ),
  }),
);

// ── 4.5 crm_inbound_events — raw inbound webhook/CDC firehose; the redelivered-webhook dedupe wall.
// APPEND-ONLY (rls/crm.sql gives SELECT + INSERT only — the retention_runs wall, rls/retention.sql:36-47).
// Ingested via onConflictDoNothing on (connection_id, provider_event_id). Payloads are deltas -> the
// worker ALWAYS re-fetches the canonical record before applying (§4.5). No updated_at (immutable).
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
    uniqEvent: uniqueIndex("uniq_crm_inbound_events_provider_event").on(t.connectionId, t.providerEventId),
    unprocessedIdx: index("idx_crm_inbound_events_unprocessed").on(t.connectionId, t.processStatus, t.receivedAt),
    providerEnum: check("crm_inbound_events_provider_enum", sql`${t.provider} IN ('salesforce','hubspot')`),
    objectTypeEnum: check(
      "crm_inbound_events_object_type_enum",
      sql`${t.objectType} IN ('contact','account','lead','deal')`,
    ),
    // process_status is a draft-proposed local domain (no @leadwolf/types counterpart) — adjust at formalization.
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
    // Recency reads stay index-backed under the RLS workspace predicate (the provider_calls perf pattern,
    // intel.ts:108): newest-first slice = backward index scan, not seq-scan + sort.
    wsCreatedIdx: index("idx_crm_sync_runs_ws_created").on(t.workspaceId, t.createdAt.desc()),
    connStartedIdx: index("idx_crm_sync_runs_conn_started").on(t.connectionId, t.startedAt.desc()),
    providerEnum: check("crm_sync_runs_provider_enum", sql`${t.provider} IN ('salesforce','hubspot')`),
    objectTypeEnum: check(
      "crm_sync_runs_object_type_enum",
      sql`${t.objectType} IN ('contact','account','lead','deal')`,
    ),
    directionEnum: check("crm_sync_runs_direction_enum", sql`${t.direction} IN ('inbound','outbound')`),
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
    recordLinkId: uuid("record_link_id").references(() => crmRecordLinks.id, { onDelete: "set null" }),
    objectType: varchar("object_type", { length: 20 }).notNull(),
    field: varchar("field", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    tpValue: text("tp_value"), // cleartext ONLY for non-PII scalars; masked diff for PII (§4.7)
    crmValue: text("crm_value"), // same masking rule
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    openIdx: index("idx_crm_sync_conflicts_open").on(t.workspaceId, t.status, t.createdAt.desc()), // review-queue read
    objectTypeEnum: check(
      "crm_sync_conflicts_object_type_enum",
      sql`${t.objectType} IN ('contact','account','lead','deal')`,
    ),
    statusEnum: check("crm_sync_conflicts_status_enum", sql`${t.status} IN ('open','resolved','ignored')`),
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

// ── 4.9 crm_oauth_states — short-lived PKCE/state CSRF handshake (analog of the single-use auth code,
// auth/flow.ts). code_verifier_enc is bytea ciphertext via CrmSecretStore (never RLS-protected, never a
// DTO). state is globally unique. ~10-min TTL row, consumed once (consumed_at) then ignored/expired.
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
    providerEnum: check("crm_oauth_states_provider_enum", sql`${t.provider} IN ('salesforce','hubspot')`),
    envEnum: check("crm_oauth_states_env_enum", sql`${t.environment} IN ('production','sandbox')`),
  }),
);
```

### Notes on Block A

- **No `pgEnum`.** The repo uses `varchar + check()` for every closed enum (`intel.ts:109-112`,
  `contacts.ts:268-269`, `email.ts:123-130`); `crm.ts` follows it. Every CHECK value list **equals** the
  corresponding `@leadwolf/types/crm.ts` member set (`§4` and `§1.1` above).
- **Encrypted columns are not RLS-protected.** `oauth_token_enc` and `code_verifier_enc` are guarded at
  the **repository** layer by a `safeColumns` projection that omits them (the `mailboxRepository` pattern),
  never read into a DTO, never logged — exactly the `mailbox_integration` discipline (`email.ts:106-107`,
  plan `§7.2`). The bytea envelope is `CrmSecretStore` ciphertext under a separate `CRM_SECRET_KEY`.
- **`updated_at`** exists only on the mutable tables (connections, record_links, field_mappings,
  sync_state). The append-only tables and the run ledger carry their own timestamps
  (`received_at`/`processed_at`, `started_at`/`finished_at`, `first_seen_at`/`last_seen_at`) and have **no**
  `updated_at` trigger. The `set_updated_at()` trigger is added per-mutable-table in Block B (it is the
  shared function from `rls/contacts.sql:9-14`).

---

## Block B — `packages/db/src/rls/crm.sql` (the future RLS policy file)

Hand-authored (never generated), idempotent (`DROP POLICY IF EXISTS` before `CREATE`), keyed off the
transaction-local GUC `app.current_workspace_id` set by `withTenantTx` under the **non-BYPASSRLS**
`leadwolf_app` role. `NULLIF(current_setting(..., true), '')` makes an unset/reset GUC read **nothing**
(fail-closed). Mutable tables get the single combined `USING + WITH CHECK` policy (all commands), mirroring
`rls/contacts.sql:31-33`. Append-only tables get **`FOR SELECT` + `FOR INSERT` only** (the `retention_runs`
wall, `rls/retention.sql:36-47`). The trailing `GRANT`s are **documentary / defense-in-depth** — the real
wall is FORCE RLS + policy presence, and the blanket `[4/4]` grant re-widens `leadwolf_app` afterwards
(`applyMigrations.ts:71-77`).

```sql
-- crm.sql — RLS for the CRM bidirectional-sync engine (crm-sync plan §4 / §7.1). All nine tables are
-- Layer-1 overlay, workspace-scoped under the app.current_workspace_id GUC; NULLIF(..., '') fails closed.
-- Applied AFTER the Drizzle migration creates the tables and AFTER rls/contacts.sql (alphabetical sort,
-- applyMigrations.ts:192-197), so the shared set_updated_at() function already exists. Idempotent — safe to
-- re-run every migrate. THE WRITE GUARANTEE is FORCE ROW LEVEL SECURITY + the per-command policy set, NOT
-- the GRANTs below (the [4/4] blanket grant runs after this file and re-widens leadwolf_app).

-- ── crm_connections — full workspace isolation (CRUD). owner_user_id is soft attribution (NOT a row
-- predicate); privileged mutations are app-gated + audited. The encrypted token is repo-layer safeColumns,
-- never RLS. ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE crm_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_connections_workspace_isolation ON crm_connections;
CREATE POLICY crm_connections_workspace_isolation ON crm_connections
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS crm_connections_set_updated_at ON crm_connections;
CREATE TRIGGER crm_connections_set_updated_at BEFORE UPDATE ON crm_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── crm_record_links — full workspace isolation (CRUD; re-pointed on Lead->Contact, deleted by the
-- outbound erase job after the CRM erase confirms — §7.6). ───────────────────────────────────────────────
ALTER TABLE crm_record_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_record_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_record_links_workspace_isolation ON crm_record_links;
CREATE POLICY crm_record_links_workspace_isolation ON crm_record_links
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS crm_record_links_set_updated_at ON crm_record_links;
CREATE TRIGGER crm_record_links_set_updated_at BEFORE UPDATE ON crm_record_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── crm_field_mappings — full workspace isolation (CRUD). ────────────────────────────────────────────────
ALTER TABLE crm_field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_field_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_field_mappings_workspace_isolation ON crm_field_mappings;
CREATE POLICY crm_field_mappings_workspace_isolation ON crm_field_mappings
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS crm_field_mappings_set_updated_at ON crm_field_mappings;
CREATE TRIGGER crm_field_mappings_set_updated_at BEFORE UPDATE ON crm_field_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── crm_sync_state — full workspace isolation (CRUD; UPDATE every sync to advance the watermark). ────────
ALTER TABLE crm_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sync_state_workspace_isolation ON crm_sync_state;
CREATE POLICY crm_sync_state_workspace_isolation ON crm_sync_state
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS crm_sync_state_set_updated_at ON crm_sync_state;
CREATE TRIGGER crm_sync_state_set_updated_at BEFORE UPDATE ON crm_sync_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── crm_inbound_events — APPEND-ONLY: SELECT + INSERT policy only. No UPDATE/DELETE policy exists, so under
-- FORCE RLS those commands are denied for leadwolf_app (the retention_runs wall, rls/retention.sql:36-47) —
-- the inbound firehose is immutable regardless of the blanket grant. ─────────────────────────────────────
ALTER TABLE crm_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_inbound_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_inbound_events_workspace_read ON crm_inbound_events;
CREATE POLICY crm_inbound_events_workspace_read ON crm_inbound_events FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS crm_inbound_events_workspace_insert ON crm_inbound_events;
CREATE POLICY crm_inbound_events_workspace_insert ON crm_inbound_events FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── crm_sync_runs — APPEND + IN-PLACE PROGRESS: SELECT + INSERT + UPDATE (running -> completed; counts
-- mutate), NO DELETE policy (immutable ledger, like import_jobs). ────────────────────────────────────────
ALTER TABLE crm_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sync_runs_workspace_read ON crm_sync_runs;
CREATE POLICY crm_sync_runs_workspace_read ON crm_sync_runs FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS crm_sync_runs_workspace_insert ON crm_sync_runs;
CREATE POLICY crm_sync_runs_workspace_insert ON crm_sync_runs FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS crm_sync_runs_workspace_update ON crm_sync_runs;
CREATE POLICY crm_sync_runs_workspace_update ON crm_sync_runs FOR UPDATE
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── crm_sync_conflicts — full workspace isolation (CRUD; status open -> resolved/ignored). ───────────────
ALTER TABLE crm_sync_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_conflicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sync_conflicts_workspace_isolation ON crm_sync_conflicts;
CREATE POLICY crm_sync_conflicts_workspace_isolation ON crm_sync_conflicts
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── crm_sync_dead_letter — APPEND-ONLY for the app role: SELECT + INSERT only (no UPDATE/DELETE policy ->
-- immutable for leadwolf_app under FORCE RLS). The status transitions (retry/resolve/ignore) on the staff
-- DLQ-replay console run on the owner/withPlatformTx (BYPASSRLS) connection, which the app-role policy wall
-- does not gate — the same separation audit_log/retention_runs use for privileged writes. ────────────────
ALTER TABLE crm_sync_dead_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_dead_letter FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sync_dead_letter_workspace_read ON crm_sync_dead_letter;
CREATE POLICY crm_sync_dead_letter_workspace_read ON crm_sync_dead_letter FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS crm_sync_dead_letter_workspace_insert ON crm_sync_dead_letter;
CREATE POLICY crm_sync_dead_letter_workspace_insert ON crm_sync_dead_letter FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── crm_oauth_states — full workspace isolation (CRUD; short-lived, consumed once). ──────────────────────
ALTER TABLE crm_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_oauth_states_workspace_isolation ON crm_oauth_states;
CREATE POLICY crm_oauth_states_workspace_isolation ON crm_oauth_states
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── Documentary / defense-in-depth grants. The real walls are the policies above; the [4/4] blanket grant
-- (applyMigrations.ts:71-77) runs after this file and re-widens leadwolf_app, so these state intent rather
-- than restrict on their own (the retention.sql:57-59 convention). Append-only tables list SELECT+INSERT;
-- the run ledger lists SELECT+INSERT+UPDATE; the rest list full DML. None is master_* so none is REVOKEd. ──
GRANT SELECT, INSERT, UPDATE, DELETE ON
  crm_connections, crm_record_links, crm_field_mappings, crm_sync_state, crm_sync_conflicts, crm_oauth_states
  TO leadwolf_app;
GRANT SELECT, INSERT, UPDATE ON crm_sync_runs TO leadwolf_app;
GRANT SELECT, INSERT ON crm_inbound_events, crm_sync_dead_letter TO leadwolf_app;
```

### Notes on Block B

- **No mutation-raising trigger** on the append-only tables. The plan models them on `retention_runs`,
  whose immutability is **policy-absence under FORCE RLS** (`rls/retention.sql:42-47`), not a trigger.
  (`audit_log` uses an extra trigger only because it is `ENABLE` without `FORCE` and wants to block
  *every* role, `rls/billing.sql:99-106`; the CRM tables are `FORCE`, so policy-absence is the wall and a
  trigger would also wrongly block the legitimate `crm_sync_runs` progress UPDATE / the admin DLQ path.)
- **Cross-workspace erasure** (DSAR fan-out reaching `crm_record_links`) runs on the `withPrivilegedTx`
  BYPASSRLS path (`leadwolf_admin`), which these per-workspace policies do not gate — exactly how the
  existing inward DSAR fan-out works (plan `§7.1` / `§7.6`).

---

## Block C — enum / audit additions (the formalization-step companions)

These are **not** in Block A/B (they live in other files) but **must land in the same migration/PR** so a
closed CHECK never rejects a value the code writes (`§4.11`).

### C.1 The closed CHECK enum value lists (source of truth = `packages/types/src/crm.ts`)

Every CHECK in Block A is a verbatim mirror of a `@leadwolf/types/crm.ts` enum (so the DB and the Zod
DTOs cannot drift):

| CHECK column(s) | Source enum (`crm.ts`) | Values |
|---|---|---|
| `*.provider` | `crmProvider` (`:26`) | `salesforce, hubspot` |
| `*.object_type` (mappings/state/events/runs/dlq) | `crmObjectType` (`:30`) | `contact, account, lead, deal` |
| `crm_field_mappings.direction` | `crmSyncDirection` (`:34`) | `inbound, outbound, bidirectional, disabled` |
| `*.mode` (connections sync_mode, runs mode) | `crmSyncMode` (`:38`) | `disabled, shadow, enforce` |
| `crm_connections.status` | `crmConnectionStatus` (`:42`) | `pending, connected, error, paused, disconnected` |
| `crm_field_mappings.authority` | `crmFieldAuthority` (`:46`) | `crm, truepoint` |
| `crm_connections.environment`, `crm_oauth_states.environment` | `crmEnvironment` (`:59`) | `production, sandbox` |
| `crm_field_mappings.transform` | `crmTransform` (`:63`) | `passthrough, phone_e164, lowercase, seniority_map, date_iso, picklist_map` |
| `crm_sync_dead_letter.error_class` | `crmErrorClass` (`:74`) | `rate_limited, auth, validation, conflict_unresolved, transform, not_found, provider_5xx, ssrf_blocked, suppressed, unknown` |

Local (non-type-enum) domains, defined in this draft: `tp_entity_type (contact, account)`; the binary
**flow** `direction (inbound, outbound)` on state/runs/dlq; `link_status (linked, ambiguous, broken)`;
`backfill_status (pending, running, completed)`; run `trigger (backfill, scheduled, webhook, manual,
replay, dsar)`; run `status (running, completed, partial, failed, cancelled)`; conflict/DLQ `status`;
`process_status (pending, processed, skipped, failed)` (draft-proposed). Reconciliation of `provider`
(drop `pipedrive`) and `object_type` (keep all four, reserve `lead`/`deal`) is explained in `§1.1`.

> **`CrmConflictResolution`** (`crm.ts:50`: `crm_wins, truepoint_wins, last_write_wins, manual_review`) is
> a **connection-level** arbitration default. The plan `§4` does not place it on a table column in phase 1
> (per-field `authority` + the `§6.1` ladder cover arbitration); if a `crm_connections.conflict_resolution`
> column is later wanted, its CHECK mirrors this enum verbatim.

### C.2 `audit_log.action` additions (tenant audit) — `§4.11`

Add **five** values in **both** the source-of-truth Zod enum `packages/types/src/billing.ts` `auditAction`
(`:49`) **and** its DB mirror CHECK `schema/billing.ts` `audit_log_action_enum` (`:187-209`):

```
'crm.connect', 'crm.disconnect', 'crm.sync', 'crm.mapping.update', 'crm.erase'
```

Every tenant sync write calls `writeAudit` in the same tx (the `deleteFanout` shape) — **IDs + provider
only, never the pushed PII or the token** (`§7.4`).

### C.3 `platformAuditAction` additions (staff audit) — `§4.11`

Add **two** values to `packages/types/src/platformAudit.ts` `platformAuditAction` (`:7-41`):

```
'crm_integration.enable', 'crm_budget.set'
```

These are staff-side enablement via `withPlatformTx` (super_admin-gated). Per the file's own note, the
`platform_audit_log` DB CHECK lands with the `apps/admin` track (ADR-0032); the type enum is the enforced
contract now.

### C.4 `source_imports.source_name` — **no change needed**

Inbound CRM records append a `source_imports` row for raw lineage (`§4.10`). The enum
`schema/contacts.ts` `source_imports_source_name_enum` (`:268-269`) **already** contains `'salesforce'` and
`'hubspot'`, so **no migration touches it** (confirmed; matches `§4.10`).

---

## 5. Deferred / open

- **Migration numbering waits for the settled base.** This draft is **schema-design only** — it adds no
  migration and no journal entry, so it cannot drift or collide. On this branch the latest applied
  migration is **`0028_outstanding_venom`** (`migrations/meta/_journal.json`), so the plan `§4`'s assumed
  `0027`/`0028` numbers are stale; the real CRM migration is numbered **after whatever base is merged
  first** (the data-mgmt `0025`/retention work and the email `0026-0028` series are in flight on other
  branches). The numbering and the actual `0NNN_crm_sync.sql` body are produced by `drizzle-kit generate`
  at formalization (`§0`), not here.
- **RLS isolation itests are part of formalization.** When `rls/crm.sql` is wired, it must ship the
  cross-workspace and cross-tenant negative tests the repo already practices (e.g. the recent
  `test(db): itest the admin cross-tenant platform reads`), proving an unscoped/foreign-workspace query
  reads nothing and the append-only tables reject UPDATE/DELETE for `leadwolf_app`.
- **KMS is the security-owned enable-gate (not this draft's scope).** The `bytea` envelope columns are the
  forward-compat seam; the real CMK-wrap of the DEK is **UNBUILT** and is the prerequisite before any
  production CRM token is stored (plan `§7.2` / `§11`). This persistence design is correct under either
  the dev-grade `sha256(env)` store or the future KMS store — the column shape does not change.
- **Reserved, not built in phase 1:** `lead`/`deal` object types (enum-reserved, `§1.3`); `pipedrive`
  provider (fast-follow); a `crm_connections.conflict_resolution` column (`C.1` note). Each is an additive
  CHECK/enum edit when its feature ships.

---

*This is a non-wired DRAFT: no `packages/db/src/schema/crm.ts`, no `packages/db/src/rls/crm.sql`, no edit
to `schema/index.ts`, and no migration/journal entry were created. Formalize per `§0`.*
