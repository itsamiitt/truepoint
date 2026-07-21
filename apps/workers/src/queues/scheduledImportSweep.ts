// scheduledImportSweep.ts — the P5 SCHEDULED-IMPORT sweep (import-and-data-model-redesign 08 §9 · 14 Phase 5).
// The leader-locked tick that FIRES due schedules: each due row re-imports its STORED source object by creating
// an ORDINARY `import_jobs` row (08 §9: "creates an ordinary import_jobs row — same trio, same machine") on the
// UNIFIED fast lane — the schedule never re-implements the engine. Composes the house sweep idiom EXACTLY
// (withLeaderLock + owner-connection due census + per-schedule RLS-scoped tenant tx + the pure decision core in
// @leadwolf/core + incrementImportCounter/setImportGauge — the importArtifactSweep / importReaperSweep shape).
//
// FIRE ORDERING (the S-I3 idempotency-first precedent, 09 §7 row 2). Per due schedule, in ONE tenant tx:
//   1. getByIdForUpdate — lock the row so a concurrent update/delete/disable serializes.
//   2. re-check enabled && next_run_at ≤ now — a raced PATCH/DELETE since the census ⇒ SKIP (nothing fired).
//   3. per-tenant flag (isScheduledImportsEnabled, in-tx) — tenant flipped OFF ⇒ SKIP: neither disabled nor
//      advanced (a re-flip resumes from the same cadence anchor; the row stays due and is cheaply re-skipped).
//   4. grant re-eval (evaluateScheduleFireGrant over the LIVE role + policy) — a creator who lost the right to
//      import (demoted/policy-tightened/deleted → null role) ⇒ disableForGrantLoss + idempotent notify + SKIP.
//      A schedule can never keep firing as a departed/ungranted user (08 §9 / 10 §2).
//   5. FIRE: read the stored object, decode/parse, route (fast pair ONLY in v1 — an over-fast-pair or a
//      parse/missing-object failure is a FIRE FAILURE: recordFailure advances next_run_at so a broken schedule
//      never hot-loops, and auto-disables at maxFailures with a notify). Then decideFastAdmission (BEFORE
//      create, so the admission verdict is the create status — one write, not two), createJob (idempotency-
//      keyed by (scheduleId, window) so a double-fire collapses onto ONE job), advanceAfterFire — ALL in the
//      SAME tx. The BullMQ enqueue happens AFTER commit (rows ride the Phase-A payload and cannot enter the
//      PII-free outbox — 09 §6.4): a shed/crash between commit and enqueue leaves a `queued` fast row the reaper
//      TERMINALIZES as an orphan (Phase-A fast is rows-in-payload, unrecoverable) — the next cadence tick fires
//      a fresh window, so the schedule self-heals forward rather than double-firing the same window.
//
// COPY-MODE SCHEDULED FIRES ARE DEFERRED (v1 = fast pair only): an over-threshold source is treated as a fire
// failure with a clear reason, not silently routed to copy (the copy drive's scheduled path is future work —
// doc-16 drift row). All INERT while SCHEDULED_IMPORTS_ENABLED is off (the sweep is never constructed) or the
// per-tenant flag is off (step 3 skips) — the dual gate.

import { env } from "@leadwolf/config";
import {
  type FileStore,
  computeNextRunAt,
  decideFastAdmission,
  decideImportRouting,
  decodeAdmittedCsv,
  deriveScheduleIdempotencyKey,
  evaluateScheduleFireGrant,
  isScheduledImportsEnabled,
  isXlsxFile,
  parseImportFile,
} from "@leadwolf/core";
import {
  type ScheduledImportRow,
  type Tx,
  importJobRepository,
  importPolicyRepository,
  notificationRepository,
  scheduledImportRepository,
  withTenantTx,
  workspaceRepository,
} from "@leadwolf/db";
import {
  DEFAULT_IMPORT_POLICY,
  type ImportFastInput,
  type ImportMergeMode,
  type ScheduleCadence,
  type SourceName,
  type WhoCanImport,
} from "@leadwolf/types";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";
import { incrementImportCounter, setImportGauge } from "../metrics.ts";

export const SCHEDULED_IMPORT_SWEEP_QUEUE = "scheduled-import-sweep";
const LEADER_KEY = "leader:scheduled_import_sweep";
const LEADER_TTL_MS = 5 * 60_000;
// Bound the due census per tick; the remainder rides the next tick (the set only shrinks as fires advance).
const MAX_DUE_PER_SWEEP = 200;

export type ScheduledImportSweepJobData = Record<string, never>;

/** The BullMQ enqueue for a fired fast job — injected so the sweep never constructs a queue handle itself
 *  (register.ts wires it to the SAME `bulk-imports` queue the commit verb enqueues onto). */
export interface ScheduledImportSweepDeps {
  /** The SAME env-selected store the api's schedule-create wrote the source object through (register.ts
   *  composes one per boot — api and workers select identically, so the sweep reads the right backend). */
  fileStore: FileStore;
  /** Enqueue the fired fast job on the unified queue: stable id `import-fast:<jobId>` (re-publish dedupes),
   *  fast priority, and the deferred re-check delay when admission parked it `deferred`. */
  enqueueFastImport: (
    jobId: string,
    scope: { tenantId: string; workspaceId: string },
    input: ImportFastInput,
    admission: "queued" | "deferred",
  ) => Promise<void>;
  /** N consecutive fire-time failures that auto-disable a schedule (env.SCHEDULED_IMPORT_MAX_CONSECUTIVE_FAILURES). */
  maxFailures: number;
}

/** The outcome of firing (or declining to fire) one due schedule — drives the sweep's counters. The `enqueue`
 *  payload rides `fired` ONLY when a job was actually created (a double-fire collapse advances but enqueues
 *  nothing). */
type FireOutcome =
  | { kind: "skipped" } // raced (deleted/updated/no-longer-due) OR tenant flag off — nothing touched
  | { kind: "grant_disabled" } // creator lost the grant ⇒ schedule disabled + notified
  | { kind: "failed" } // missing object / parse failure / over-fast-pair ⇒ recordFailure (+ maybe disabled)
  | {
      kind: "fired";
      enqueue?: {
        jobId: string;
        input: ImportFastInput;
        admission: "queued" | "deferred";
        scope: { tenantId: string; workspaceId: string };
      };
    };

/** Buffer a stored source object into one contiguous byte array (bounded: v1 fires the FAST pair only, so the
 *  object is ≤ the fast-path byte ceiling by construction — an over-threshold source becomes a fire failure). */
async function bufferObject(fileStore: FileStore, key: string): Promise<Uint8Array> {
  const stream = await fileStore.getObjectStream(key);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Insert the creator's "scheduled import disabled" in-app notification IDEMPOTENTLY (dedup by the
 *  (scheduled_import, id) entity — a redelivery/second sweep tick no-ops). Uses the `system` notification type:
 *  the closed vocabulary has no dedicated `scheduled_import_disabled` value (doc-16 drift row). A schedule with
 *  a deleted creator (null) has nobody to notify — skipped. Runs in the caller's tenant tx (RLS WITH CHECK). */
async function notifyScheduleDisabled(
  tx: Tx,
  row: ScheduledImportRow,
  reason: "grant_lost" | "max_failures",
): Promise<void> {
  if (!row.createdByUserId) return;
  const already = await notificationRepository.existsForEntity(
    tx,
    row.workspaceId,
    row.createdByUserId,
    "system",
    "scheduled_import",
    row.id,
  );
  if (already) return;
  const body =
    reason === "grant_lost"
      ? `Your scheduled import "${row.name}" was turned off because your permission to import in this workspace was removed.`
      : `Your scheduled import "${row.name}" was turned off after repeated failures — check the source file, then re-enable it.`;
  await notificationRepository.create(tx, {
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    userId: row.createdByUserId,
    type: "system",
    title: "Scheduled import disabled",
    body,
    entityType: "scheduled_import",
    entityId: row.id,
  });
}

/** Fire (or decline to fire) ONE due schedule, entirely inside one RLS-scoped tenant tx. Returns the outcome +
 *  (on a real fire) the after-commit enqueue payload. NEVER throws for an expected fire failure (missing object /
 *  parse / over-pair) — those are recorded as failures; only an unexpected error propagates to the sweep's
 *  per-schedule try/catch. */
async function fireOneSchedule(
  scope: { tenantId: string; workspaceId: string },
  scheduleId: string,
  now: Date,
  deps: ScheduledImportSweepDeps,
): Promise<FireOutcome> {
  return withTenantTx(scope, async (tx): Promise<FireOutcome> => {
    const row = await scheduledImportRepository.getByIdForUpdate(tx, scheduleId);
    // Deleted since the census, or a raced update flipped it off / pushed next_run_at forward ⇒ SKIP.
    if (!row) return { kind: "skipped" };
    if (!row.enabled || row.nextRunAt.getTime() > now.getTime()) return { kind: "skipped" };

    // Per-tenant flag (the dual gate's in-tx half): a tenant flipped OFF neither disables nor advances the
    // schedule — the row stays due and is cheaply re-skipped each tick until the flag is re-flipped on.
    if (!(await isScheduledImportsEnabled(tx, scope.tenantId))) return { kind: "skipped" };

    // Grant re-eval AS the creator, against the LIVE role + policy (08 §9). A null creator (SET NULL on delete)
    // or a demoted/policy-gated role is a hard loss ⇒ disable + notify (never fire as a departed/ungranted user).
    // getRoleForUser opens its own scoped read; the sweep is leader-locked + serial, so the nested acquisition
    // is bounded (one extra pooled connection at a time).
    const role = row.createdByUserId
      ? await workspaceRepository.getRoleForUser(
          scope.tenantId,
          scope.workspaceId,
          row.createdByUserId,
        )
      : null;
    const policy = await importPolicyRepository.getInTx(tx);
    const whoCanImport: WhoCanImport = policy?.whoCanImport ?? DEFAULT_IMPORT_POLICY.whoCanImport;
    if (evaluateScheduleFireGrant(role, whoCanImport) !== "ok") {
      await scheduledImportRepository.disableForGrantLoss(tx, scheduleId);
      await notifyScheduleDisabled(tx, row, "grant_lost");
      return { kind: "grant_disabled" };
    }

    // The next due instant (missed windows skipped, never backfilled) — computed ONCE, reused by both the
    // failure-advance and the success-advance so a fire and its recovery land on the same cadence grid.
    const cadence = row.cadence as ScheduleCadence;
    const nextRunAt = computeNextRunAt(row.nextRunAt, cadence, now);
    const filename = row.sourceFilename ?? row.sourceObjectKey;

    // Read + decode + parse + route the stored object, then FIRE. A missing/undecodable object, a parse
    // failure, OR an over-fast-pair source (copy-mode scheduled fires are DEFERRED in v1 — doc-16 drift) is a
    // FIRE FAILURE: recordFailure advances next_run_at (no hot-loop) and auto-disables at the threshold with a
    // notify. commitFire rides the same try: an unexpected write error poisons the tenant tx, so recordFailure
    // in the catch just re-throws to the sweep's outer catch (the whole tx rolls back — nothing committed,
    // re-fired next tick, the idempotency key collapsing any partial).
    try {
      const buffer = await bufferObject(deps.fileStore, row.sourceObjectKey);
      const content = isXlsxFile(filename) ? buffer : decodeAdmittedCsv(buffer);
      const parsed = parseImportFile(content, filename);
      // copyEngaged:false ⇒ decideImportRouting THROWS ImportTooLargeError on an over-pair source (v1 fires
      // fast only), which lands here as a fire failure with a clear reason.
      decideImportRouting({
        fileName: filename,
        byteSize: buffer.byteLength,
        rowCount: parsed.rows.length,
        rowCeiling: env.BULK_IMPORT_THRESHOLD_ROWS,
        copyEngaged: false,
      });
      return await commitFire(tx, {
        row,
        scope,
        now,
        nextRunAt,
        rows: parsed.rows,
        fileSize: buffer.byteLength,
        policy,
      });
    } catch (err) {
      const res = await scheduledImportRepository.recordFailure(tx, scheduleId, {
        nextRunAt,
        maxFailures: deps.maxFailures,
      });
      if (res.disabled) await notifyScheduleDisabled(tx, row, "max_failures");
      log.warn("scheduled-import sweep: fire failed", {
        scheduleId,
        workspaceId: scope.workspaceId,
        consecutiveFailures: res.consecutiveFailures,
        disabled: res.disabled,
        reason: err instanceof Error ? err.message : String(err),
      });
      return { kind: "failed" };
    }
  });
}

/** The success half of a fire (extracted so the failure path can early-return without it). admission BEFORE
 *  create — the verdict is the create status (one write, not two, mirroring the commit verb) — then create +
 *  advance in the SAME tx. Returns the after-commit enqueue payload only when a NEW job was created (a double-
 *  fire within the window collapses onto the existing job: still advance, but enqueue nothing). */
async function commitFire(
  tx: Tx,
  args: {
    row: ScheduledImportRow;
    scope: { tenantId: string; workspaceId: string };
    now: Date;
    nextRunAt: Date;
    rows: ImportFastInput["rows"];
    fileSize: number;
    policy: { defaultMergeMode: ImportMergeMode; defaultPreservePopulated: boolean } | null;
  },
): Promise<FireOutcome> {
  const { row, scope, now, nextRunAt, rows, fileSize, policy } = args;

  // Resolve the strategy the same way the create verb does: the row's pinned pair wins, each field falling
  // back to the workspace import_policy default (null on the row = inherit). Persisted on the job so history
  // reflects HOW it merged, AND carried in the fast input so the engine uses it verbatim.
  const mergeMode = (row.mergeMode ??
    policy?.defaultMergeMode ??
    DEFAULT_IMPORT_POLICY.defaultMergeMode) as ImportMergeMode;
  const preservePopulated =
    row.preservePopulated ?? policy?.defaultPreservePopulated ?? DEFAULT_IMPORT_POLICY.defaultPreservePopulated;

  const idempotencyKey = deriveScheduleIdempotencyKey(row.id, row.nextRunAt);
  // Admission BEFORE create so the verdict IS the create status (the commit-verb precedent — no second write).
  const admission = await decideFastAdmission(tx, scope.workspaceId);

  const created = await importJobRepository.createJob(tx, {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    // Attribution = the schedule's creator (the grant executed AS them; the completion notify then reaches
    // them). NOTE the 08 §9 schema comment pins a fired job's created_by to NULL/system — this fire-seam spec
    // sets the creator instead so the import-complete notification lands; the schedule pointer still rides
    // options.scheduleId (doc-16 drift row records the attribution choice).
    createdByUserId: row.createdByUserId,
    status: admission,
    sourceFile: row.sourceObjectKey,
    sourceName: row.sourceName,
    fileSize,
    idempotencyKey,
    columnMapping: (row.mapping ?? {}) as Record<string, unknown>,
    targetListId: row.targetListId,
    sourceFilename: row.sourceFilename,
    mergeMode,
    preservePopulated,
    processingMode: "fast",
    options: { ...((row.options as Record<string, unknown> | null) ?? {}), scheduleId: row.id },
  });

  // Advance the schedule (stamp last_run_at + last_job_id, reset the failure state) in the SAME tx as the
  // create — a crash before commit leaves the schedule due (re-fired next tick, the idempotency key collapsing
  // any partial); after commit the enqueue is best-effort (see the header's ordering note).
  await scheduledImportRepository.advanceAfterFire(tx, row.id, {
    nextRunAt,
    lastRunAt: now,
    lastJobId: created.id,
  });

  if (!created.created) {
    // Double-fire within the same window (two ticks / a retried tick) collapsed onto the existing job by the
    // (workspace_id, idempotency_key) partial unique — skip the enqueue (the first fire already transported it).
    return { kind: "fired" };
  }

  const input: ImportFastInput = {
    importedByUserId: row.createdByUserId ?? undefined,
    sourceName: row.sourceName as SourceName,
    sourceFile: row.sourceFilename ?? undefined,
    mapping: (row.mapping ?? {}) as ImportFastInput["mapping"],
    strategy: { mergeMode, preservePopulated },
    rows,
    target: row.targetListId ? { listId: row.targetListId } : undefined,
  };
  return { kind: "fired", enqueue: { jobId: created.id, input, admission, scope } };
}

/**
 * Build the sweep processor. Leader-locked; enumerates due schedules on the owner connection, fires each in its
 * own tenant tx, and enqueues the fired fast jobs AFTER their tx commits. Best-effort per schedule — one
 * schedule's failure never aborts the sweep (a still-due row is re-examined next tick). Publishes the P5
 * counters/gauge (§K runbook family `leadwolf_import_scheduled_*`).
 */
export function makeProcessScheduledImportSweep(redis: IORedis, deps: ScheduledImportSweepDeps) {
  return async function processScheduledImportSweep(
    _job: Job<ScheduledImportSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const now = new Date();
      const due = await scheduledImportRepository.listDueSchedules(now, MAX_DUE_PER_SWEEP);
      setImportGauge("scheduled_due", due.length);
      let fired = 0;
      let skipped = 0;
      let grantDisabled = 0;
      let failed = 0;

      for (const d of due) {
        const scope = { tenantId: d.tenantId, workspaceId: d.workspaceId };
        try {
          const outcome = await fireOneSchedule(scope, d.id, now, deps);
          if (outcome.kind === "skipped") {
            skipped += 1;
          } else if (outcome.kind === "grant_disabled") {
            grantDisabled += 1;
            log.warn("scheduled-import sweep: disabled schedule for grant loss", {
              scheduleId: d.id,
              workspaceId: d.workspaceId,
            });
          } else if (outcome.kind === "failed") {
            failed += 1;
          } else {
            fired += 1;
            // Enqueue AFTER commit (rows ride the Phase-A payload — cannot enter the PII-free outbox). A shed
            // here leaves a `queued` fast row the reaper terminalizes as an orphan; the next tick fires anew.
            if (outcome.enqueue) {
              await deps.enqueueFastImport(
                outcome.enqueue.jobId,
                outcome.enqueue.scope,
                outcome.enqueue.input,
                outcome.enqueue.admission,
              );
            }
            log.info("scheduled-import sweep: fired schedule", {
              scheduleId: d.id,
              workspaceId: d.workspaceId,
              jobId: outcome.enqueue?.jobId,
              admission: outcome.enqueue?.admission ?? "collapsed",
            });
          }
        } catch (e) {
          failed += 1;
          log.error("scheduled-import sweep: schedule tick failed", {
            scheduleId: d.id,
            workspaceId: d.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (fired > 0) incrementImportCounter("scheduled_fired_total", fired);
      if (skipped > 0) incrementImportCounter("scheduled_skipped_total", skipped);
      if (grantDisabled > 0) incrementImportCounter("scheduled_grant_disabled_total", grantDisabled);
      if (failed > 0) incrementImportCounter("scheduled_failed_total", failed);
      if (fired > 0 || grantDisabled > 0 || failed > 0) {
        log.info("scheduled-import sweep: tick complete", {
          due: due.length,
          fired,
          skipped,
          grantDisabled,
          failed,
        });
      }
    });
  };
}
