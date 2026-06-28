// bulkImports.ts — the `bulk-imports` queue processor + dead-letter routing for the bulk COPY-staging import
// (15-bulk-import-design, backlog #2, phase 6). The big-file sibling of imports.ts: it runs the SAME packages/core
// pipeline the design ships (runBulkImport / bulkProcessChunk / finalizeIfLastChunk — one implementation, two
// transports, 16 §3.2) and follows enrichment's drive→chunk fan-out shape (a `drive` job stages the upload +
// fans out `chunk` jobs; each `chunk` merges one staged band). Core stays free of BullMQ/Redis: the composition
// root (register.ts) injects the FileStore, the `enqueueChunk` producer, and the rollups hook. DARK until
// BULK_IMPORT_ENABLED is on — the apps/api producer enqueues nothing while the flag is off, so this consumer
// never runs in prod until the COPY spike + a prod object store land.

import {
  type EnqueueChunk,
  type FileStore,
  bulkProcessChunk,
  finalizeIfLastChunk,
  runBulkImport,
} from "@leadwolf/core";
import {
  type BulkImportDeadLetter,
  type BulkImportJobData,
  type BulkImportScope,
  bulkImportJobDataSchema,
} from "@leadwolf/types";
import type { Job, Queue } from "bullmq";

// Single source of truth for the queue names + payload type lives in @leadwolf/types so this consumer and the
// apps/api producer never drift (and apps never import apps). Re-exported for register.ts (the composition root).
export { BULK_IMPORTS_QUEUE, BULK_IMPORTS_DLQ } from "@leadwolf/types";
export type { BulkImportJobData } from "@leadwolf/types";

/** The dependencies the composition root injects so core never imports BullMQ/Redis/an object store directly. */
export interface BulkImportProcessDeps {
  /** The object store the drive phase stages the upload + rejected-rows artifact through (dev: diskFileStore). */
  fileStore: FileStore;
  /** Fan out one `chunk` job per staged band onto the bulk queue (the drive phase calls this per band). */
  enqueueChunk: EnqueueChunk;
  /**
   * Fire the per-workspace dedup / firmographics / masterBackfill rollups ONCE — the SAME idempotent rollups the
   * sync import kicks on completion. Called only on the LAST chunk's finalize (fireRollups === true). Best-effort
   * inside the injected fn: a rollup-enqueue failure must never fail the chunk job.
   */
  fireRollups: (scope: BulkImportScope) => void | Promise<void>;
}

/** A non-PII summary of what a single bulk-import job step did (for per-queue observability; never the rows). */
export type BulkImportProcessResult =
  | {
      kind: "drive";
      jobId: string;
      status: string;
      totalChunks: number;
      enqueuedChunks: number;
      resumed: boolean;
    }
  | {
      kind: "chunk";
      processed: boolean;
      created: number;
      matched: number;
      duplicate: number;
      finalized: boolean;
      firedRollups: boolean;
    };

/**
 * Build the bulk-imports processor with its injected deps. A `drive` job stages the file + fans out chunk jobs; a
 * `chunk` job merges one band, and — ONLY on a real completion (processed === true) — calls finalizeIfLastChunk so
 * completed_chunks is incremented exactly once. The dedup/firmographics/masterBackfill rollups fire ONLY when
 * finalize reports fireRollups (the LAST chunk that landed ≥1 contact), exactly once per job.
 */
export function makeProcessBulkImport(deps: BulkImportProcessDeps) {
  return async function processBulkImport(
    job: Job<BulkImportJobData>,
  ): Promise<BulkImportProcessResult> {
    // Defense in depth: re-validate + narrow the queue payload (the producer is trusted, but the discriminated
    // union guards a malformed/stale job). bulkImportJobDataSchema narrows `kind` → drive | chunk.
    const data = bulkImportJobDataSchema.parse(job.data);

    if (data.kind === "drive") {
      const r = await runBulkImport({
        scope: data.scope,
        jobId: data.jobId,
        fileStore: deps.fileStore,
        enqueueChunk: deps.enqueueChunk,
      });
      return {
        kind: "drive",
        jobId: r.jobId,
        status: r.status,
        totalChunks: r.totalChunks,
        enqueuedChunks: r.enqueuedChunks,
        resumed: r.resumed,
      };
    }

    const r = await bulkProcessChunk({
      scope: data.scope,
      jobId: data.jobId,
      chunkId: data.chunkId,
    });
    let finalized = false;
    let firedRollups = false;
    // finalizeIfLastChunk ONLY after a real completion so the completed-chunk counter advances exactly once; an
    // idempotent skip (already-`completed` chunk, processed === false) must NOT increment it.
    if (r.processed) {
      const f = await finalizeIfLastChunk({ scope: data.scope, jobId: data.jobId });
      finalized = f.finalized;
      // Rollups fire ONLY on the last chunk's finalize, ONCE per job — the same trigger the sync import uses.
      if (f.fireRollups) {
        await deps.fireRollups(data.scope);
        firedRollups = true;
      }
    }
    return {
      kind: "chunk",
      processed: r.processed,
      created: r.created,
      matched: r.matched,
      duplicate: r.duplicate,
      finalized,
      firedRollups,
    };
  };
}

/**
 * Route a bulk-import job that has EXHAUSTED its retries to the dead-letter queue as a PII-FREE record (scope +
 * job id + kind + reason only — never the staged rows, which hold un-encrypted PII; the queue payload itself is
 * already PII-free). No-op while attempts remain (BullMQ will retry). Wire this into worker.on("failed").
 * Mirrors deadLetterFailedImport (imports.ts).
 */
export async function deadLetterFailedBulkImport(
  deadLetterQueue: Queue<BulkImportDeadLetter>,
  job: Job<BulkImportJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return; // retries remain — not dead yet
  const parsed = bulkImportJobDataSchema.safeParse(job.data);
  if (!parsed.success) return; // unparseable payload — nothing safe (or useful) to record
  const { kind, jobId, scope } = parsed.data;
  const record: BulkImportDeadLetter = {
    jobId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    // The queue payload is PII-FREE and carries no source filename; ops correlate to the upload via jobId (the
    // import_jobs PK). A DB read is intentionally avoided here so the terminal failure path stays dependency-light
    // and never itself throws.
    sourceName: "",
    kind,
    reason: err.message,
  };
  await deadLetterQueue.add("dead-letter", record);
}
