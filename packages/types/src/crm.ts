// crm.ts — the shared CRM-sync contracts: closed Zod enums, BullMQ queue names, job-payload DTOs, the
// per-field mapping config, and the flag/env/provenance-src constants. Single source of truth shared by
// apps/api (producers), apps/workers (consumers), packages/core (the port + planners), and packages/web
// (the health UI), so producer and consumer can never drift — and so apps never import apps. Mirrors the
// queue-contract idiom of bulkEnrichment.ts EXACTLY: queue names first, then closed enums, then the DTOs.
// Validation lives here; logic does not. Grounded in docs/planning/crm-sync §3.2 / §4.11 / §10.5.

import { z } from "zod";

// ── Queue names (the §3.2 topology; shared producer/consumer, like BULK_ENRICHMENT_QUEUE) ────────────────────
/** Leader-locked scheduler → fans out pull/reconcile jobs (repeatable 60s delta + 24h reconcile). */
export const CRM_SYNC_SWEEP_QUEUE = "crm-sync-sweep";
/** Initial bulk load on connect, discriminated `drive`→`page` (one-shot per connection). */
export const CRM_SYNC_BACKFILL_QUEUE = "crm-sync-backfill";
/** Incremental CRM→TruePoint delta by watermark (enqueued from the sweep). */
export const CRM_SYNC_PULL_QUEUE = "crm-sync-pull";
/** Webhook/CDC hint → re-fetch canonical → apply (enqueued from the public inbound route). */
export const CRM_SYNC_INBOUND_QUEUE = "crm-sync-inbound";
/** TruePoint→CRM outbound upsert (metered, rate-budgeted), from the change event-emitter fan-out. */
export const CRM_SYNC_PUSH_QUEUE = "crm-sync-push";
/** PII-free dead-letter for all CRM queues (the `queue` discriminator names the origin). */
export const CRM_SYNC_DLQ = "crm-sync-dlq";

// ── Closed enums (mirror the §4.11 CHECK enums; the DB rejects unknown values) ───────────────────────────────
/** The CRM vendors phase-1 ships adapters for. Salesforce is the deferred fast-follow; HubSpot is first. */
export const crmProvider = z.enum(["salesforce", "hubspot"]);
export type CrmProvider = z.infer<typeof crmProvider>;

/** The CRM object kinds the connector can address (contacts/accounts in phase 1; lead/deal reserved). */
export const crmObjectType = z.enum(["contact", "account", "lead", "deal"]);
export type CrmObjectType = z.infer<typeof crmObjectType>;

/** Per-field flow direction (`crm_field_mappings.direction`); default is the conservative enrich-in. */
export const crmSyncDirection = z.enum(["inbound", "outbound", "bidirectional", "disabled"]);
export type CrmSyncDirection = z.infer<typeof crmSyncDirection>;

/** The L3 dark-launch gate on a connection — mirrors retention_policies.mode. Nothing leaves until enforce. */
export const crmSyncMode = z.enum(["disabled", "shadow", "enforce"]);
export type CrmSyncMode = z.infer<typeof crmSyncMode>;

/** Connection lifecycle (`crm_connections.status`). */
export const crmConnectionStatus = z.enum(["pending", "connected", "error", "paused", "disconnected"]);
export type CrmConnectionStatus = z.infer<typeof crmConnectionStatus>;

/** Per-field source-of-truth (`crm_field_mappings.authority`); unset → the §6.1 LWW tiebreak applies. */
export const crmFieldAuthority = z.enum(["crm", "truepoint"]);
export type CrmFieldAuthority = z.infer<typeof crmFieldAuthority>;

/** Connection-level default arbitration strategy when authority is unset (the §6.1 conflict ladder). */
export const crmConflictResolution = z.enum([
  "crm_wins",
  "truepoint_wins",
  "last_write_wins",
  "manual_review",
]);
export type CrmConflictResolution = z.infer<typeof crmConflictResolution>;

/** Connection environment (prod vs vendor sandbox). */
export const crmEnvironment = z.enum(["production", "sandbox"]);
export type CrmEnvironment = z.infer<typeof crmEnvironment>;

/** The closed code-side transform registry key (`crm_field_mappings.transform`) — never executable code. */
export const crmTransform = z.enum([
  "passthrough",
  "phone_e164",
  "lowercase",
  "seniority_map",
  "date_iso",
  "picklist_map",
]);
export type CrmTransform = z.infer<typeof crmTransform>;

/** PII-free poison-job error taxonomy (`crm_sync_dead_letter.error_class`, §4.8). */
export const crmErrorClass = z.enum([
  "rate_limited",
  "auth",
  "validation",
  "conflict_unresolved",
  "transform",
  "not_found",
  "provider_5xx",
  "ssrf_blocked",
  "suppressed",
  "unknown",
]);
export type CrmErrorClass = z.infer<typeof crmErrorClass>;

// ── Per-field mapping config (`crm_field_mappings`, §4.3 — our field ↔ crm field, direction/authority) ────────
/** One mapping row: a TP column/custom-field path ↔ a CRM API field, with per-field direction/authority. */
export const crmFieldMappingSchema = z.object({
  objectType: crmObjectType,
  tpField: z.string().min(1).max(100), // a column path ('jobTitle') or a custom-field key ('cf:renewal_date')
  crmField: z.string().min(1).max(255), // the CRM API field name ('jobtitle' / 'Title' / 'My_Field__c')
  direction: crmSyncDirection.default("inbound"),
  authority: crmFieldAuthority.optional(), // unset → LWW tiebreak among non-authoritative fields (§6.1)
  confThreshold: z.number().min(0).max(1).optional(), // enrichment overwrites only when conf > threshold
  transform: crmTransform.default("passthrough"),
  isDedupKey: z.boolean().optional(),
  enabled: z.boolean().default(true),
});
export type CrmFieldMapping = z.infer<typeof crmFieldMappingSchema>;

// ── Job payloads (every job re-enters withTenantTx via `scope`; partition key is the connection, §3.2) ────────
/** The two-tier tenancy scope carried by every CRM job so the worker can re-enter `withTenantTx`. */
export const crmJobScopeSchema = z.object({
  tenantId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type CrmJobScope = z.infer<typeof crmJobScopeSchema>;

const crmJobBase = {
  scope: crmJobScopeSchema,
  connectionId: z.string().uuid(),
  provider: crmProvider,
};

/** crm-sync-sweep: leader-locked tick (global; no per-connection scope) selecting due connections. */
export const crmSweepJobSchema = z.object({ kind: z.enum(["delta", "reconcile"]) });
export type CrmSweepJob = z.infer<typeof crmSweepJobSchema>;

/** crm-sync-pull: incremental CRM→TP delta by watermark for one (connection, object). */
export const crmPullJobSchema = z.object({
  ...crmJobBase,
  objectType: crmObjectType,
  sinceWatermark: z.string().optional(),
});
export type CrmPullJob = z.infer<typeof crmPullJobSchema>;

/** crm-sync-inbound: a webhook/CDC hint to re-fetch + apply one canonical record (the payload is lossy). */
export const crmInboundJobSchema = z.object({
  ...crmJobBase,
  objectType: crmObjectType,
  crmRecordId: z.string().min(1),
  providerEventId: z.string().min(1),
  sourceTag: z.string().optional(), // origin filter for loop prevention (§6.6)
});
export type CrmInboundJob = z.infer<typeof crmInboundJobSchema>;

/** crm-sync-push: TP→CRM outbound upsert of one TP entity (content-hash short-circuits no-ops, §6.4). */
export const crmPushJobSchema = z.object({
  ...crmJobBase,
  objectType: crmObjectType,
  tpEntityId: z.string().uuid(),
  changeSeq: z.number().int().nonnegative(),
  contentHash: z.string().optional(),
  idempotencyKey: z.string().min(1),
});
export type CrmPushJob = z.infer<typeof crmPushJobSchema>;

/** crm-sync-backfill: discriminated `drive` (plan the run) → `page` (resume a cursor), per §3.3. */
export const crmBackfillJobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drive"), ...crmJobBase, objectType: crmObjectType }),
  z.object({
    kind: z.literal("page"),
    ...crmJobBase,
    objectType: crmObjectType,
    runId: z.string().uuid(),
    cursor: z.string().optional(),
  }),
]);
export type CrmBackfillJob = z.infer<typeof crmBackfillJobSchema>;

/** crm-sync-dlq: the PII-free dead-letter DTO written after BullMQ retries exhaust (§4.8). */
export const crmDeadLetterSchema = z.object({
  scope: crmJobScopeSchema,
  connectionId: z.string().uuid(),
  queue: z.string().min(1), // the origin queue name (discriminator)
  provider: crmProvider,
  objectType: crmObjectType,
  crmRecordId: z.string().optional(),
  tpEntityId: z.string().uuid().optional(),
  errorClass: crmErrorClass,
  errorDetail: z.string().max(1000).optional(), // PII-free reason (provider code/snippet); never field values
  attempts: z.number().int().nonnegative(),
});
export type CrmDeadLetter = z.infer<typeof crmDeadLetterSchema>;

// ── Flag / env / provenance-src constants (§10.5) ────────────────────────────────────────────────────────────
/** The L2 per-tenant feature-flag key (DB feature_flags row). Mirrors the *_FLAG_KEY idiom. */
export const CRM_SYNC_FLAG_KEY = "crm_sync_enabled";
/** The L1 environment-gate variable NAME (read in @leadwolf/config); absent → the whole engine is dark. */
export const CRM_SYNC_ENABLED_ENV = "CRM_SYNC_ENABLED";

/** Platform-level provenance `src` labels (§4.10) — a CRM is just another `src`, never a workspace id. */
export const CRM_SRC_SALESFORCE = "crm:salesforce";
export const CRM_SRC_HUBSPOT = "crm:hubspot";
/** The provenance `src` label for a provider — the per-field echo guard reads `src.startsWith(crmSrcFor(p))`. */
export function crmSrcFor(provider: CrmProvider): string {
  return `crm:${provider}`;
}
