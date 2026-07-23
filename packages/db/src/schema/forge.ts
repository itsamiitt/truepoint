// forge.ts — the TruePoint Forge data plane, isolated in a dedicated `forge` Postgres SCHEMA (ADR-0047, nested
// migration decision). Owned by the least-privilege `leadwolf_forge` role (applyMigrations); it cannot reach
// the tenant overlay — the firewall is a schema+role boundary now that Forge is same-repo. The four medallion
// layers: raw_captures (bronze) → parsed_records (silver) → verified_records (gold) → sync into the master
// graph in-process. Hand-authored migration 0054 (drizzle-kit generate is forbidden). Re-homed from @forge/db.
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const forgeSchema = pgSchema("forge");
const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

// ── bronze ──────────────────────────────────────────────────────────────────────────────────────────
export const rawCaptures = forgeSchema.table(
  "raw_captures",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    source: text("source").notNull(),
    endpoint: text("endpoint").notNull(),
    schemaVersion: text("schema_version").notNull(),
    contentHash: text("content_hash").notNull(),
    contentType: text("content_type").notNull().default("application/json"),
    capturedByUserId: uuid("captured_by_user_id"),
    targetTenantId: uuid("target_tenant_id").notNull(),
    targetWorkspaceId: uuid("target_workspace_id"),
    consentSnapshot: jsonb("consent_snapshot").notNull().default({}),
    payloadInline: text("payload_inline"),
    payloadRef: text("payload_ref"),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    isGzipped: boolean("is_gzipped").notNull().default(false),
    status: text("status").notNull().default("landed"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Per-tenant dedup (P-01.12) — a GLOBAL content_hash unique was a cross-tenant existence oracle + poisoning
    // vector (tenant A's capture would silently dedupe tenant B's identical one). Scope the uniqueness to tenant.
    uniqTenantContentHash: uniqueIndex("uniq_raw_captures_tenant_content_hash").on(
      t.targetTenantId,
      t.contentHash,
    ),
    ingestedAtIdx: index("idx_raw_captures_ingested_at").on(t.ingestedAt),
    onePayload: check(
      "raw_captures_one_payload",
      sql`(${t.payloadInline} IS NOT NULL) <> (${t.payloadRef} IS NOT NULL)`,
    ),
    statusEnum: check("raw_captures_status", sql`${t.status} IN ('landed','parsed','erased')`),
  }),
);

export const captureBatches = forgeSchema.table(
  "capture_batches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("received"),
    acceptedCount: integer("accepted_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    rejectHistogram: jsonb("reject_histogram").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqIdempotency: uniqueIndex("uniq_capture_batches_idempotency_key").on(t.idempotencyKey),
  }),
);

// ── versioned parser registry + silver ────────────────────────────────────────────────────────────────
export const parsers = forgeSchema.table(
  "parsers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    source: text("source").notNull(),
    endpoint: text("endpoint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqSourceEndpoint: uniqueIndex("uniq_parsers_source_endpoint").on(t.source, t.endpoint),
  }),
);

export const parserVersions = forgeSchema.table(
  "parser_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    parserId: uuid("parser_id")
      .notNull()
      .references(() => parsers.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    status: text("status").notNull().default("draft"),
    outputSchema: jsonb("output_schema").notNull().default({}),
    compatibility: text("compatibility"),
    goldenFixtureRef: text("golden_fixture_ref"),
    supersedesVersionId: uuid("supersedes_version_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneActive: uniqueIndex("uniq_parser_versions_one_active")
      .on(t.parserId)
      .where(sql`${t.status} = 'active'`),
  }),
);

export const parsedRecords = forgeSchema.table(
  "parsed_records",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    rawCaptureId: uuid("raw_capture_id")
      .notNull()
      .references(() => rawCaptures.id, { onDelete: "cascade" }),
    parserVersionId: uuid("parser_version_id")
      .notNull()
      .references(() => parserVersions.id),
    entityKind: text("entity_kind").notNull().default("person"),
    fields: jsonb("fields").notNull().default([]),
    fieldProvenance: jsonb("field_provenance").notNull().default([]),
    parseStatus: text("parse_status").notNull(),
    parseErrors: jsonb("parse_errors").notNull().default([]),
    blockKey: text("block_key"),
    emailBlindIndex: text("email_blind_index"),
    phoneBlindIndex: text("phone_blind_index"),
    superseded: boolean("superseded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqCaptureVersion: uniqueIndex("uniq_parsed_records_capture_version").on(
      t.rawCaptureId,
      t.parserVersionId,
    ),
  }),
);

export const extractionRuns = forgeSchema.table(
  "extraction_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    jobId: text("job_id").notNull(),
    targetTenantId: uuid("target_tenant_id"),
    task: text("task").notNull().default("extract"),
    model: text("model").notNull(),
    outcome: text("outcome").notNull(),
    usedRepair: boolean("used_repair").notNull().default(false),
    extractSchemaVersion: text("extract_schema_version"),
    groundingCoverage: numeric("grounding_coverage", { precision: 4, scale: 3 }),
    judgeScore: numeric("judge_score", { precision: 4, scale: 3 }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedTokens: integer("cached_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    driftIdx: index("idx_extraction_runs_drift").on(t.extractSchemaVersion, t.model),
  }),
);

// The AI-extract stage (S2) OUTPUT — the per-field candidates {value, confidence, band, grounded} that were
// previously DISCARDED (P-01.2). Idempotent on (raw_capture_id, path); same PII posture as parsed_records.fields
// (non-channel profile fields; channel PII stays blind-index-only; encryption-at-rest is the F2 security task).
export const extractionCandidates = forgeSchema.table(
  "extraction_candidates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    rawCaptureId: uuid("raw_capture_id")
      .notNull()
      .references(() => rawCaptures.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    value: jsonb("value"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    band: text("band").notNull(),
    grounded: boolean("grounded").notNull(),
    extractSchemaVersion: text("extract_schema_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqCapturePath: uniqueIndex("uniq_extraction_candidates_capture_path").on(
      t.rawCaptureId,
      t.path,
    ),
  }),
);

// ── gold + sync ledger ────────────────────────────────────────────────────────────────────────────────
export const verifiedRecords = forgeSchema.table(
  "verified_records",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    contentHash: text("content_hash").notNull(),
    entityKind: text("entity_kind").notNull(),
    fields: jsonb("fields").notNull().default({}),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    reviewStatus: text("review_status").notNull().default("verified"),
    emailBlindIndex: text("email_blind_index"),
    emailEnc: bytea("email_enc"),
    phoneBlindIndex: text("phone_blind_index"),
    phoneEnc: bytea("phone_enc"),
    isSuppressed: boolean("is_suppressed").notNull().default(false),
    version: integer("version").notNull().default(1),
    approvedByUserId: uuid("approved_by_user_id"),
    approvalRequestId: uuid("approval_request_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqContentHash: uniqueIndex("uniq_verified_records_content_hash").on(t.contentHash),
  }),
);

export const verifiedRecordEvents = forgeSchema.table("verified_record_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  verifiedId: uuid("verified_id")
    .notNull()
    .references(() => verifiedRecords.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  version: integer("version").notNull().default(1),
  winningSource: text("winning_source"),
  sourceRecordRef: text("source_record_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const syncState = forgeSchema.table(
  "sync_state",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    entityKind: text("entity_kind").notNull(),
    verifiedId: uuid("verified_id").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqEntity: uniqueIndex("uniq_sync_state_entity").on(t.entityKind, t.verifiedId),
  }),
);

export const syncOutbox = forgeSchema.table(
  "sync_outbox",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventType: text("event_type").notNull(),
    aggregateKind: text("aggregate_kind").notNull().default("verified_person"),
    forgeId: uuid("forge_id"),
    version: integer("version").notNull().default(1),
    contentHash: text("content_hash").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (t) => ({
    pendingIdx: index("idx_sync_outbox_pending").on(t.status, t.availableAt),
  }),
);

export const masterIdMap = forgeSchema.table(
  "master_id_map",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    forgeId: uuid("forge_id").notNull(),
    masterId: uuid("master_id"),
    entityKind: text("entity_kind").notNull(),
    contentHash: text("content_hash").notNull(),
    syncedVersion: integer("synced_version").notNull().default(0),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqForge: uniqueIndex("uniq_master_id_map_forge").on(t.forgeId),
  }),
);

// ── maker-checker governance ──────────────────────────────────────────────────────────────────────────
export const approvalRequests = forgeSchema.table(
  "approval_requests",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    opClass: text("op_class").notNull(),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    decidedByUserId: uuid("decided_by_user_id"),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").notNull().default({}),
    // The verify stage's idempotency key (P-01.10) — the gold candidate's content_hash. A partial unique keeps
    // at-most-one PENDING request per (op_class, subject_ref) so a redelivered verify converges.
    subjectRef: text("subject_ref"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (t) => ({
    uniqPendingSubject: uniqueIndex("uniq_approval_requests_pending_subject")
      .on(t.opClass, t.subjectRef)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export const reviewTasks = forgeSchema.table(
  "review_tasks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    taskType: text("task_type").notNull(),
    subjectRef: text("subject_ref").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    priority: integer("priority").notNull().default(0),
    status: text("status").notNull().default("open"),
    assigneeUserId: uuid("assignee_user_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    isHoneypot: boolean("is_honeypot").notNull().default(false),
    resolution: text("resolution"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    rankIdx: index("idx_review_tasks_rank").on(t.status, t.priority),
    slaIdx: index("idx_review_tasks_sla").on(t.slaDueAt),
    // at-most-one OPEN task per (subject, type) — the verify-stage idempotency key (P-01.16).
    oneOpen: uniqueIndex("uniq_review_tasks_one_open")
      .on(t.subjectRef, t.taskType)
      .where(sql`${t.status} = 'open'`),
  }),
);

// Drifted/unparseable captures (P-01.8) — the parse quarantine lane, previously console.warn'd and lost.
export const quarantine = forgeSchema.table(
  "quarantine",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    rawCaptureId: uuid("raw_capture_id")
      .notNull()
      .references(() => rawCaptures.id, { onDelete: "cascade" }),
    route: text("route").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqCaptureRoute: uniqueIndex("uniq_quarantine_capture_route").on(t.rawCaptureId, t.route),
  }),
);

export const forgeAuditLog = forgeSchema.table(
  "forge_audit_log",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    action: text("action").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    payload: jsonb("payload").notNull().default({}),
    prevHash: text("prev_hash").notNull(),
    rowHash: text("row_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    rowHashIdx: index("idx_forge_audit_row_hash").on(t.rowHash),
  }),
);

// ── Forge-owned entity resolution ─────────────────────────────────────────────────────────────────────
export const matchCandidates = forgeSchema.table(
  "match_candidates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    leftRef: uuid("left_ref").notNull(),
    rightRef: uuid("right_ref").notNull(),
    blockKey: text("block_key").notNull(),
    matchWeight: numeric("match_weight", { precision: 8, scale: 4 }),
    disposition: text("disposition"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    blockIdx: index("idx_match_candidates_block").on(t.blockKey),
  }),
);

export const matchLinks = forgeSchema.table(
  "match_links",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    entityType: text("entity_type").notNull(),
    clusterId: uuid("cluster_id").notNull(),
    sourceRef: uuid("source_ref").notNull(),
    matchProbability: numeric("match_probability", { precision: 4, scale: 3 }),
    matchWeight: numeric("match_weight", { precision: 8, scale: 4 }),
    matchMethod: text("match_method").notNull().default("fellegi_sunter"),
    isDuplicateOf: uuid("is_duplicate_of"),
    reviewStatus: text("review_status").notNull().default("auto"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clusterIdx: index("idx_match_links_cluster").on(t.entityType, t.clusterId),
  }),
);

export const mergeLog = forgeSchema.table("merge_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  clusterId: uuid("cluster_id").notNull(),
  decision: text("decision").notNull(),
  survivorship: jsonb("survivorship").notNull().default({}),
  matchWeight: numeric("match_weight", { precision: 8, scale: 4 }),
  decidedByUserId: uuid("decided_by_user_id"),
  reason: text("reason"),
  reversesMergeId: uuid("reverses_merge_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
