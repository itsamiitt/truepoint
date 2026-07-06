// scheduledImports.ts — the per-workspace SCHEDULED IMPORT contract (import-and-data-model-redesign 08 §9
// "Scheduled imports" · 14 Phase 5 · 15 §M-SEQ's open P5 band). A schedule re-runs an import DEFINITION
// (source template: mapping + strategy + a STORED source object) on a cadence; its tick "creates an ordinary
// `import_jobs` row — same trio, same machine" (08 §9 verbatim), submitted through the EXISTING durable
// pipeline (submitCopyImport). The schedule NEVER re-implements the engine. Single source of truth shared by
// apps/api (the CRUD verbs) and apps/workers (the leader-locked sweep) so the two surfaces can never drift.
//
// SOURCE MODEL (08 §9 pins two branches: "cron + a connected source OR a re-uploaded template file"). This
// v1 ships ONLY the STORED-OBJECT branch (the "re-uploaded template file"): a schedule re-imports a source
// object already in the FileStore. The "connected source" / remote-URL branch is DEFERRED — it takes URLs
// and credentials and is bound by 13 §8's SSRF forward-guard (deny-by-default egress, allowlist, the shipped
// `ssrfGuard` reuse), which is acceptance criteria to be met when that branch is picked up. Nothing here
// fetches an outbound URL, so this v1 opens NO SSRF surface (recorded in doc 16).
//
// CADENCE MODEL. 08 §9 says "cron"; this v1 ships an INTERVAL ENUM (hourly/daily/weekly) rather than a cron
// parser (no dependency, pure + unit-testable cadence math). The column is an enum so a cron string can be
// added later without a rename (drift-logged in doc 16). Everything is UNREAD/INERT while the
// SCHEDULED_IMPORTS_ENABLED env kill-switch + the per-tenant `scheduled_imports_enabled` flag are off.

import { z } from "zod";
import { columnMappingSchema, sourceName } from "./contacts.ts";
import { importMergeMode } from "./importPolicy.ts";

// ── Dual-gate flag key (mirrors IMPORT_V2_FLAG_KEY / BULK_IMPORT_FLAG_KEY — the shared key lives here so
//    api/workers can never drift on the string). Seeded off in migration 0063; fail-closed. ────────────────
export const SCHEDULED_IMPORTS_FLAG_KEY = "scheduled_imports_enabled";

// ── Caps (13 §7 abuse posture: bound automation fan-out). A per-workspace ceiling on schedule ROWS enforced
//    by the create verb → 422 when exceeded. A config knob later; the constant is the shared floor. ────────
export const MAX_SCHEDULES_PER_WORKSPACE = 25;

/** N consecutive fire-time failures auto-disable a schedule (08 §9-adjacent uniformity: a broken schedule
 *  turns itself off rather than firing forever). Also the env default; the constant is the shared contract. */
export const SCHEDULE_MAX_CONSECUTIVE_FAILURES = 5;

// ── Cadence vocabulary (interval enum; the pure cadence math lives in @leadwolf/core, unit-tested) ─────────
export const scheduleCadence = z.enum(["hourly", "daily", "weekly"]);
export type ScheduleCadence = z.infer<typeof scheduleCadence>;

/** Interval minutes per cadence — the ONE mapping the cadence math keys on (kept beside the enum so a new
 *  cadence can never forget its interval). */
export const CADENCE_INTERVAL_MINUTES: Record<ScheduleCadence, number> = {
  hourly: 60,
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
};

/** Why a schedule was auto-disabled (null on a live or manually-disabled schedule). Non-PII. */
export const scheduleDisabledReason = z.enum(["grant_lost", "max_failures"]);
export type ScheduleDisabledReason = z.infer<typeof scheduleDisabledReason>;

// ── Create/update DTOs (the API edge validates these; the workspace/tenant/creator come from the VERIFIED
//    token, never the body — 16 §7). `sourceObjectKey` names an object already in the FileStore. ───────────
export const createScheduledImportSchema = z.object({
  /** Display name (workspace-unique, case-insensitive — the update target). */
  name: z.string().trim().min(1).max(120),
  /** The provider enum recorded on every fired job (import_jobs.source_name). */
  sourceName: sourceName,
  /** The stored source object to re-import each fire (the "re-uploaded template file" branch). */
  sourceObjectKey: z.string().min(1).max(512),
  /** Untrusted display filename (rides source_filename only). */
  sourceFilename: z.string().min(1).max(255).optional(),
  /** The column mapping replayed each fire (canonical field → source header). */
  mapping: columnMappingSchema,
  /** The 08 §5 strategy pair for the fired job (defaults mirror the policy defaults). */
  mergeMode: importMergeMode.optional(),
  preservePopulated: z.boolean().optional(),
  /** Optional list-membership target for every fired job. */
  targetListId: z.string().uuid().nullable().optional(),
  /** Parse/import options (countryHint, delimiter…), same shape as import_jobs.options. */
  options: z.record(z.string(), z.unknown()).optional(),
  /** The fire cadence. */
  cadence: scheduleCadence,
  /** Start enabled? Default true. */
  enabled: z.boolean().optional(),
});
export type CreateScheduledImport = z.infer<typeof createScheduledImportSchema>;

/** PATCH body — every field optional so one knob flips without resending the definition. `sourceObjectKey`
 *  is intentionally NOT updatable (a schedule points at one stored object for its life; re-point by
 *  recreating — keeps provenance honest and avoids a dangling-object race). */
export const updateScheduledImportSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    mapping: columnMappingSchema,
    mergeMode: importMergeMode,
    preservePopulated: z.boolean(),
    targetListId: z.string().uuid().nullable(),
    options: z.record(z.string(), z.unknown()),
    cadence: scheduleCadence,
    /** Enabling a disabled schedule clears its disabled_reason + failure counter (a fresh start). */
    enabled: z.boolean(),
  })
  .partial();
export type UpdateScheduledImport = z.infer<typeof updateScheduledImportSchema>;

// ── The read shape (non-PII by construction: names/counts/timestamps/keys — never row values) ──────────────
export const scheduledImportSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sourceName: sourceName,
  sourceObjectKey: z.string(),
  sourceFilename: z.string().nullable(),
  mapping: columnMappingSchema,
  mergeMode: importMergeMode.nullable(),
  preservePopulated: z.boolean().nullable(),
  targetListId: z.string().uuid().nullable(),
  cadence: scheduleCadence,
  enabled: z.boolean(),
  disabledReason: scheduleDisabledReason.nullable(),
  consecutiveFailures: z.number().int(),
  nextRunAt: z.string().datetime({ offset: true }),
  lastRunAt: z.string().datetime({ offset: true }).nullable(),
  lastJobId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ScheduledImport = z.infer<typeof scheduledImportSchema>;

export const scheduledImportListSchema = z.object({
  schedules: z.array(scheduledImportSchema),
});
export type ScheduledImportList = z.infer<typeof scheduledImportListSchema>;
