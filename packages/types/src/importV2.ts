// importV2.ts — the unified durable import pipeline contract (import-and-data-model-redesign 08; S-I1
// onward). Single source of truth shared by apps/api (the v2 verbs as they ship), apps/workers (the
// dual-write wrapper, S-I3), and apps/web (the wizard/history surfaces, doc 11) — so producer and consumer
// can never drift. EVERYTHING here is dark while the IMPORT_V2_ENABLED dual gate is off: the schemas
// describe the 0054 columns/states, which no shipped route or worker reads yet. The legacy 9-state
// transport contract stays in bulkImport.ts untouched (old clients keep the §2.4 compatibility mapping).

import { z } from "zod";
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
