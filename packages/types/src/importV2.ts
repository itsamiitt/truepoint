// importV2.ts — the unified durable import pipeline contract (import-and-data-model-redesign 08; S-I1
// onward). Single source of truth shared by apps/api (the v2 verbs as they ship), apps/workers (the
// dual-write wrapper, S-I3), and apps/web (the wizard/history surfaces, doc 11) — so producer and consumer
// can never drift. EVERYTHING here is dark while the IMPORT_V2_ENABLED dual gate is off: the schemas
// describe the 0054 columns/states, which no shipped route or worker reads yet. The legacy 9-state
// transport contract stays in bulkImport.ts untouched (old clients keep the §2.4 compatibility mapping).

import { z } from "zod";
import { bulkImportScopeSchema } from "./bulkImport.ts";
import { columnMappingSchema, conflictPolicy, importTargetSchema, sourceName } from "./contacts.ts";
import { importMergeMode } from "./importPolicy.ts";

// ── Rollout gate ─────────────────────────────────────────────────────────────────────────────────────────
/** Per-tenant feature-flag key for the unified durable import pipeline (default false → fail-closed to the
 *  shipped behavior). The TWO-LAYER gate: the global env.IMPORT_V2_ENABLED kill-switch must be on AND this
 *  per-tenant flag enabled before any import surface changes (S-I3's dual-write onward). Mirrors
 *  BULK_IMPORT_FLAG_KEY (bulkImport.ts) — the shared key lives here so api/workers/web can never drift. */
export const IMPORT_V2_FLAG_KEY = "import_v2_enabled";

// ── Vocabulary (mirrors the 0054 import_jobs CHECKs) ─────────────────────────────────────────────────────
/** Server-side routing verdict (08 §1, S-I5): 'fast' = inline row engine; 'copy' = COPY-staging chunk
 *  pipeline. The SERVER decides at commit/one-shot; the client never picks a pipeline. Absent/null on a
 *  job = legacy row created before routing shipped. */
export const importProcessingMode = z.enum(["fast", "copy"]);
export type ImportProcessingMode = z.infer<typeof importProcessingMode>;

/** The 12-state unified job vocabulary (08 §2.1): the shipped 9 states + `draft` (upload landed,
 *  mapping/preview iterating — excluded from history by default), `uploading` (presigned-multipart bytes in
 *  flight, Phase B only), `deferred` (accepted, concurrency cap reached — the visible-backpressure state).
 *  Terminals are unchanged: completed | partial | failed | cancelled. Old clients never see the three new
 *  states (08 §2.4 legacy mapping); bulkImport.ts's 9-state enum stays the legacy transport contract. */
export const importJobStatusV2 = z.enum([
  "uploading",
  "draft",
  "queued",
  "deferred",
  "validating",
  "staged",
  "running",
  "paused",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
export type ImportJobStatusV2 = z.infer<typeof importJobStatusV2>;

/** The 08 §5.1 strategy block a job (and, per S-I2, a template) carries: the merge-mode triad + the
 *  orthogonal preserve-populated switch. Re-exported from importPolicy.ts (the workspace-default home) so
 *  there is exactly one triad definition. */
export const importStrategySchema = z.object({
  mergeMode: importMergeMode,
  preservePopulated: z.boolean(),
});
export type ImportStrategy = z.infer<typeof importStrategySchema>;

// ── Preview projection (the 0054 `preview_summary` jsonb; written by S-I8, cached on the draft row) ──────
/** Per-column feedback block (08 §4): parse-failure count, dominant reject code, sample LINE NUMBERS —
 *  never row values (non-PII by construction). */
export const importPreviewColumnFeedbackSchema = z.object({
  column: z.string(),
  parseFailures: z.number().int().nonnegative(),
  dominantRejectCode: z.string().nullable(),
  sampleLines: z.array(z.number().int().nonnegative()),
});
export type ImportPreviewColumnFeedback = z.infer<typeof importPreviewColumnFeedbackSchema>;

/** The non-PII full-pass projection (08 §4): counts + histogram ONLY — row values never persist on the
 *  control row (sample rows are recomputed per request). Cached as `preview_summary` so re-renders don't
 *  re-scan the stored draft file. */
export const importPreviewSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  wouldCreate: z.number().int().nonnegative(),
  wouldUpdate: z.number().int().nonnegative(),
  duplicateInFile: z.number().int().nonnegative(),
  /** Reject-code → count histogram (the shipped rejectLabel discipline: labels, never values). */
  rejectHistogram: z.record(z.string(), z.number().int().nonnegative()),
  perColumn: z.array(importPreviewColumnFeedbackSchema),
});
export type ImportPreviewSummary = z.infer<typeof importPreviewSummarySchema>;

// ── Unified-queue transport (09 §1, S-I3/S-Q1) ───────────────────────────────────────────────────────────
/** Priority bands on the unified `bulk-imports` queue (09 §1.1; BullMQ: LOWER number = served first): fast
 *  jobs jump every waiting copy chunk; copy drives outrank copy chunks so a new job's staging starts before
 *  a whale's tail bands. Retry-child jobs inherit their mode's band (08 §6.3). Within a band, FIFO. */
export const IMPORT_QUEUE_PRIORITY = {
  fast: 1,
  copyDrive: 5,
  copyChunk: 10,
} as const;

// ── Outbox topics (09 §6, S-Q3/S-Q4) — the worker_outbox `topic` values an import's terminal tx publishes
// (ADR-0027; imports become the outbox's first consumer beyond bulk-enrich). Payloads PII-free by contract.
// Live here so the packages/core producer and the workers-side relay publishers can never drift — the
// BULK_ENRICHMENT_DRIVE_TOPIC precedent.
/** Terminal-transition NOTIFY intent (09 §6.3, S-Q4). The publisher looks the recipient (creator) + copy up
 *  from the durable row, so the payload stays minimal + PII-free; the insert is idempotent (jobId+status). */
export const IMPORT_NOTIFY_TOPIC = "import.notify";
/** Terminal ROLLUP intent (09 §6.2, S-Q3). The publisher fans out the idempotent per-workspace dedup /
 *  firmographics / master-backfill rollups — replacing the best-effort completed-handler enqueues (G06). */
export const IMPORT_ROLLUPS_TOPIC = "import.rollups";
/** Commit→drive intent (09 §6.4) — RESERVED. The atomic commit⇒drive move for the copy path / Phase-B fast
 *  ({jobId, scope}); the Phase-A fast lane keeps its direct enqueue because rows ride the payload and cannot
 *  enter the PII-free outbox (09 §6.4 — "Fast-mode Phase A keeps its legacy direct enqueue"). Not wired yet. */
export const IMPORT_DRIVE_TOPIC = "import.drive";

/** import.notify worker_outbox payload (09 §6.3). PII-free — ids + scope + the terminal status only. */
export const importNotifyPayloadSchema = z.object({
  jobId: z.string().uuid(),
  scope: bulkImportScopeSchema,
  terminalStatus: z.enum(["completed", "partial", "failed", "cancelled"]),
});
export type ImportNotifyPayload = z.infer<typeof importNotifyPayloadSchema>;

/** import.rollups worker_outbox payload (09 §6.2). PII-free — the workspace scope only. */
export const importRollupsPayloadSchema = z.object({ scope: bulkImportScopeSchema });
export type ImportRollupsPayload = z.infer<typeof importRollupsPayloadSchema>;

/** The fast-mode job's import input, as carried on the queue (Phase A, 08 §1.2): the RunImportInput fields
 *  minus `scope` (the envelope carries it). ROWS TRAVEL IN THE PAYLOAD — the deliberate Phase-A transport
 *  bound (the disk FileStore cannot be load-bearing multi-instance until G07, 08 §1.2; 12 §2.4), exactly as
 *  the legacy `imports` queue does today. This is the ONE sanctioned exception to 09 §1.2's PII-free-payload
 *  rule and it retires at Phase B, when the payload slims to `{jobId, scope}`. */
export const importFastInputSchema = z.object({
  importedByUserId: z.string().uuid().optional(),
  sourceName: sourceName,
  sourceFile: z.string().max(255).optional(),
  mapping: columnMappingSchema,
  conflictPolicy: conflictPolicy.optional(),
  /** The 08 §5 strategy triad (S-I6): the server-resolved merge_mode + preserve_populated. When present it
   *  SUPERSEDES `conflictPolicy` in the engine; absent (legacy/gate-off) ⇒ conflictPolicy maps onto the triad
   *  (byte-identical internal path). */
  strategy: importStrategySchema.optional(),
  /** The parsed CSV/XLSX rows, keyed by trimmed header (core's RawRow). */
  rows: z.array(z.record(z.string(), z.string())),
  target: importTargetSchema.optional(),
});
export type ImportFastInput = z.infer<typeof importFastInputSchema>;

// ── v2 tenant-surface DTOs (08 §7, S-I4): the durable list/detail read model. Non-PII by construction —
// counts + statuses + codes + histogram labels only; never a row value (the shipped rejectLabel discipline).
/** The seven-plus-total accounting buckets of a job (09 §4 identity: created+matched+duplicate+skipped+
 *  rejected+deduped+unprocessed = total). Mirrors the `rows_*` columns straight through. */
export const importJobCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  deduped: z.number().int().nonnegative(),
  unprocessed: z.number().int().nonnegative(),
});
export type ImportJobCounts = z.infer<typeof importJobCountsSchema>;

/** Creator attribution (10 §2.1): the userId only in Phase 1 — the display-name join lands with the S-U2
 *  history UI (the attribution surface). `null` = system/automation job (elevated-only under scoping). */
export const importJobCreatedBySchema = z.object({ userId: z.string().uuid().nullable() });

/** One row of `GET /imports` (08 §7). Strict-from-birth v2 shape (10 §5 row 1) — no legacy compatibility to
 *  preserve on the list, so it carries the real 12-state vocabulary + derived progress + counts. */
export const importJobListItemSchema = z.object({
  jobId: z.string().uuid(),
  status: importJobStatusV2,
  mode: importProcessingMode.nullable(),
  sourceName: sourceName,
  sourceFilename: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** deriveImportProgress (09 §4.1's ONE fn) — poll and the future SSE can never disagree. */
  percent: z.number().min(0).max(1),
  stage: z.string(),
  counts: importJobCountsSchema,
  createdBy: importJobCreatedBySchema,
  parentJobId: z.string().uuid().nullable(),
});
export type ImportJobListItem = z.infer<typeof importJobListItemSchema>;

/** `GET /imports` response — the visible page + an opaque keyset cursor (house contract; null = last page). */
export const importJobListResponseSchema = z.object({
  jobs: z.array(importJobListItemSchema),
  nextCursor: z.string().nullable(),
});
export type ImportJobListResponse = z.infer<typeof importJobListResponseSchema>;

/** The additive v2 members `GET /imports/:id` layers ON TOP OF the legacy poll response (08 §2.4 window):
 *  old clients keep reading `status`/`progress`/`summary` byte-for-byte; new clients read `statusV2` + these.
 *  `addedToList` is deliberately ABSENT — the non-PII control row never persists the list-membership tally,
 *  so gate-on cannot report it honestly (deriving it from counters would be a lie); it returns with the S-I7
 *  artifact/receipt work, not fabricated here (drift logged in 16). */
export const importJobDetailV2Schema = z.object({
  statusV2: importJobStatusV2,
  mode: importProcessingMode.nullable(),
  sourceFilename: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  percent: z.number().min(0).max(1),
  stage: z.string(),
  counts: importJobCountsSchema,
  createdBy: importJobCreatedBySchema,
  parentJobId: z.string().uuid().nullable(),
  mergeMode: importMergeMode,
  preservePopulated: z.boolean(),
  rejectHistogram: z.record(z.string(), z.number().int().nonnegative()),
  previewSummary: importPreviewSummarySchema.nullable(),
});
export type ImportJobDetailV2 = z.infer<typeof importJobDetailV2Schema>;

/** The `fast` job kind on the unified `bulk-imports` queue (09 §1.1: a fast import is a drive that skips
 *  staging and completes its single chunk inline). `jobId` = the durable import_jobs.id — the BullMQ job is
 *  NAMED BY it (`import-fast:<jobId>`), so a re-publish dedupes at the queue and the consumer's terminal-skip
 *  makes any replay a no-op. Lives here (not bulkImport.ts) so the legacy 9-state transport contract stays
 *  byte-untouched; the worker accepts the union of both. */
export const importFastJobDataSchema = z.object({
  kind: z.literal("fast"),
  jobId: z.string().uuid(),
  scope: bulkImportScopeSchema,
  input: importFastInputSchema,
  /** How many times this job has been re-enqueued by the deferred/cap loop (S-Q2). Absent = 0. */
  deferrals: z.number().int().nonnegative().optional(),
});
export type ImportFastJobData = z.infer<typeof importFastJobDataSchema>;
