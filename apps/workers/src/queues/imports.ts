// imports.ts — the `imports` queue processor + dead-letter routing. It reports coarse progress, runs the SAME
// packages/core import pipeline apps/api uses (one implementation, two transports — 16 §3.2), and treats a
// wholly-failed import (zero rows imported) as a job-level failure so BullMQ retries it and, once attempts are
// exhausted, the job is dead-lettered. Per-row data errors that still net progress are surfaced via the
// returned summary, not by failing the job.

import { type RunImportInput, runImport } from "@leadwolf/core";
import type { ImportDeadLetter, ImportProgress, ImportSummary } from "@leadwolf/types";
import type { Job, Queue } from "bullmq";

// Single source of truth for the queue names lives in @leadwolf/types so this consumer and the apps/api
// producer never drift (and apps never import apps). Re-exported for register.ts (the composition root).
export { IMPORTS_QUEUE, IMPORTS_DLQ } from "@leadwolf/types";

/** The job payload IS a RunImportInput (rows already parsed before enqueue). */
export type ImportJobData = RunImportInput;

/**
 * A job-level import failure: zero rows imported. Throwing it (instead of returning the summary) lets BullMQ
 * retry the job and, once attempts are exhausted, route it to the dead-letter queue.
 */
export class ImportFailedError extends Error {
  readonly summary: ImportSummary;
  constructor(summary: ImportSummary) {
    super(
      `Import made no progress: 0/${summary.total} rows imported (${summary.errors.length} errored).`,
    );
    this.name = "ImportFailedError";
    this.summary = summary;
  }
}

export async function processImport(job: Job<ImportJobData>): Promise<ImportSummary> {
  const total = job.data.rows.length;
  const start: ImportProgress = {
    total,
    processed: 0,
    created: 0,
    matched: 0,
    skipped: 0,
    failed: 0,
  };
  await job.updateProgress(start);

  const summary = await runImport(job.data);

  const done: ImportProgress = {
    total: summary.total,
    processed: summary.total,
    created: summary.created,
    matched: summary.matched,
    skipped: summary.skipped,
    failed: summary.errors.length,
  };
  await job.updateProgress(done);

  // A wholly-failed import (nothing created/matched/skipped) is retryable at the job level — a transient
  // outage that fails every row should retry, not silently "complete" with zero imported. Partial success
  // returns normally and its per-row errors travel in summary.errors.
  if (summary.total > 0 && summary.created + summary.matched + summary.skipped === 0) {
    throw new ImportFailedError(summary);
  }
  return summary;
}

/**
 * Route an import job that has EXHAUSTED its retries to the dead-letter queue as a PII-FREE record (scope +
 * provenance + reason only — never the raw rows, which hold un-encrypted PII). No-op while attempts remain
 * (BullMQ will retry). Wire this into worker.on("failed").
 */
export async function deadLetterFailedImport(
  deadLetterQueue: Queue<ImportDeadLetter>,
  job: Job<ImportJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return; // retries remain — not dead yet
  const { scope, sourceName, sourceFile, importedByUserId } = job.data;
  const record: ImportDeadLetter = {
    originalJobId: String(job.id),
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    sourceName,
    sourceFile: sourceFile ?? null,
    importedByUserId: importedByUserId ?? null,
    failedReason: err.message,
    attemptsMade: job.attemptsMade,
  };
  await deadLetterQueue.add("dead-letter", record);
}
