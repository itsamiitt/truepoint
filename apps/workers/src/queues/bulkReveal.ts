// bulkReveal.ts — the `bulk-reveal` queue processor + dead-letter routing for the async bulk-reveal money path
// (reveal-experience Phase 3, ADR-0029/0036). The sibling of bulkEnrichment.ts, same drive→chunk shape. DARK
// until BULK_REVEAL_ENABLED is on: the apps/api producer enqueues nothing while the flag is off, so this consumer
// never runs in prod. A `drive` job chunks a CONFIRMED (`running`) job's contacts into bands + fans out `chunk`
// jobs; a `chunk` reveals its band THROUGH the gated revealContact in `lease` settle-mode and, on the last band,
// writes the revealed CSV + finalizes with a release. Nothing spends until BULK_REVEAL_ENABLED is on AND a job
// has been confirmed (the lease reserved the ceiling).

import {
  type BulkProcessRevealChunkInput,
  type EmailVerifierPort,
  type EnqueueRevealChunk,
  type PhoneVerifierPort,
  bulkProcessRevealChunk,
  runBulkRevealDrive,
} from "@leadwolf/core";
import type { FileStore } from "@leadwolf/core";
import {
  type BulkRevealDeadLetter,
  type BulkRevealJobData,
  bulkRevealJobDataSchema,
} from "@leadwolf/types";
import type { Job, Queue } from "bullmq";

export { BULK_REVEAL_QUEUE, BULK_REVEAL_DLQ } from "@leadwolf/types";
export type { BulkRevealJobData } from "@leadwolf/types";

/** Deps the composition root injects so core never imports BullMQ/Redis or a file-store SDK directly. */
export interface BulkRevealProcessDeps {
  /** Fan out one `chunk` job per band onto the bulk-reveal queue (the drive phase calls this per band). */
  enqueueChunk: EnqueueRevealChunk;
  /** The object store the finalize step writes the revealed CSV through. */
  fileStore: FileStore;
  /** The dedicated verifiers the reveal path grades with (config-gated; default pass-through / E.164 floor). */
  verifier?: EmailVerifierPort;
  phoneVerifier?: PhoneVerifierPort;
}

export type BulkRevealProcessResult =
  | { kind: "drive"; jobId: string; bands: number; skipped: boolean }
  | { kind: "chunk"; jobId: string; processed: number; finalized: boolean };

/** Build the bulk-reveal processor with its injected deps (mirrors makeProcessBulkEnrichment). */
export function makeProcessBulkReveal(deps: BulkRevealProcessDeps) {
  return async function processBulkReveal(
    job: Job<BulkRevealJobData>,
  ): Promise<BulkRevealProcessResult> {
    // Defense in depth: re-validate + narrow the payload (drive | chunk); the producer is trusted, but a
    // malformed/stale job must not crash the worker.
    const data = bulkRevealJobDataSchema.parse(job.data);

    if (data.kind === "drive") {
      const r = await runBulkRevealDrive({
        scope: data.scope,
        jobId: data.jobId,
        enqueueChunk: deps.enqueueChunk,
      });
      return { kind: "drive", jobId: data.jobId, bands: r.bands, skipped: r.skipped ?? false };
    }

    const chunkInput: BulkProcessRevealChunkInput = {
      scope: data.scope,
      jobId: data.jobId,
      rowStart: data.rowStart,
      rowEnd: data.rowEnd,
      verifier: deps.verifier,
      phoneVerifier: deps.phoneVerifier,
      fileStore: deps.fileStore,
    };
    const r = await bulkProcessRevealChunk(chunkInput);
    return { kind: "chunk", jobId: data.jobId, processed: r.processed, finalized: r.finalized };
  };
}

/**
 * Route a bulk-reveal job that EXHAUSTED its retries to the DLQ as a PII-FREE record (job id + kind + reason).
 * No-op while attempts remain. Wire into worker.on("failed"). Mirrors deadLetterFailedBulkEnrichment.
 */
export async function deadLetterFailedBulkReveal(
  deadLetterQueue: Queue<BulkRevealDeadLetter>,
  job: Job<BulkRevealJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return;
  const parsed = bulkRevealJobDataSchema.safeParse(job.data);
  if (!parsed.success) return;
  const record: BulkRevealDeadLetter = {
    jobId: parsed.data.jobId,
    kind: parsed.data.kind,
    reason: err.message,
    failedAt: new Date().toISOString(),
  };
  await deadLetterQueue.add("dead-letter", record);
}
