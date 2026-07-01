// bulkEnrichment.ts — the `bulk-enrichment` queue processor + dead-letter routing for the bulk (existing-contact)
// re-enrich money path (prospect-database-platform I3 / audit A3/P08). The sibling of enrichment.ts, following
// bulkImports.ts's drive→chunk shape (one implementation shape, two pipelines — 16 §3.2). DARK until
// BULK_ENRICHMENT_ENABLED is on: the apps/api producer enqueues nothing while the flag is off, so this consumer
// never runs in prod. SLICE 3a wires the real `drive` (runBulkEnrich — chunk a CONFIRMED job's contact selection
// into bands, FREE/zero provider calls); the `chunk` body is still a NO-OP STUB (validates + returns, ZERO spend).
// The real match-first/reuse-first spend + the maxProviderCostMicros per-run cap + the daily budget breaker land
// in slice 3b, which will only ever process CONFIRMED `running` jobs.

import { type EnqueueEnrichChunk, runBulkEnrich } from "@leadwolf/core";
import {
  type BulkEnrichmentDeadLetter,
  type BulkEnrichmentJobData,
  bulkEnrichmentJobDataSchema,
} from "@leadwolf/types";
import type { Job, Queue } from "bullmq";

// Single source of truth for the queue names + payload type lives in @leadwolf/types so this consumer and the
// apps/api producer never drift (and apps never import apps). Re-exported for register.ts (the composition root).
export { BULK_ENRICHMENT_QUEUE, BULK_ENRICHMENT_DLQ } from "@leadwolf/types";
export type { BulkEnrichmentJobData } from "@leadwolf/types";

/** The dependencies the composition root injects so core never imports BullMQ/Redis directly (mirror bulkImports). */
export interface BulkEnrichmentProcessDeps {
  /** Fan out one `chunk` job per band onto the bulk-enrichment queue (the drive phase calls this per band). */
  enqueueChunk: EnqueueEnrichChunk;
}

/** A non-PII summary of what a single bulk-enrich job step did (per-queue observability; never the rows). */
export type BulkEnrichmentProcessResult =
  | {
      kind: "drive";
      jobId: string;
      status: string;
      totalChunks: number;
      enqueuedChunks: number;
      resumed: boolean;
      /** true when the drive declined a not-yet-confirmed job (status ≠ running) — no chunks, no spend. */
      skipped: boolean;
    }
  | {
      kind: "chunk";
      jobId: string;
      processed: boolean;
      /** SLICE 3a: always true — the chunk body is still a no-op stub. Removed when slice 3b lands. */
      stub: boolean;
    };

/**
 * Build the bulk-enrichment processor with its injected deps (mirrors makeProcessBulkImport). A `drive` job chunks
 * a CONFIRMED (`running`) job into row bands + fans out `chunk` jobs — FREE, zero provider calls (runBulkEnrich
 * guards on `running`, so an unconfirmed job is never chunked). A `chunk` job will re-enrich its band of contact
 * ids through the shipped enrichContact waterfall under a per-run cap + the daily breaker — that SPENDING body is
 * SLICE 3b; here it is still a NO-OP STUB (validates + returns, ZERO spend) so the queue is wired end-to-end while
 * the feature is dark.
 */
export function makeProcessBulkEnrichment(deps: BulkEnrichmentProcessDeps) {
  return async function processBulkEnrichment(
    job: Job<BulkEnrichmentJobData>,
  ): Promise<BulkEnrichmentProcessResult> {
    // Defense in depth: re-validate + narrow the queue payload (drive | chunk) — the producer is trusted, but a
    // malformed/stale job must not crash the worker.
    const data = bulkEnrichmentJobDataSchema.parse(job.data);

    if (data.kind === "drive") {
      const r = await runBulkEnrich({
        scope: data.scope,
        jobId: data.jobId,
        enqueueChunk: deps.enqueueChunk,
      });
      return {
        kind: "drive",
        jobId: r.jobId,
        status: r.status,
        totalChunks: r.totalChunks,
        enqueuedChunks: r.enqueuedChunks,
        resumed: r.resumed,
        skipped: r.skipped ?? false,
      };
    }

    // SLICE 3b fills this in: read the band of contact ids (options.contactIds[rowStart:rowEnd]) + re-enrich each
    // via enrichContact under the per-run cap + daily breaker. Until then it is inert — no provider call, no spend.
    return { kind: "chunk", jobId: data.jobId, processed: false, stub: true };
  };
}

/**
 * Route a bulk-enrich job that EXHAUSTED its retries to the dead-letter queue as a PII-FREE record (scope + job id
 * + kind + reason only — never the rows; the queue payload is already PII-free). No-op while attempts remain
 * (BullMQ will retry). Wire this into worker.on("failed"). Mirrors deadLetterFailedBulkImport (bulkImports.ts).
 */
export async function deadLetterFailedBulkEnrichment(
  deadLetterQueue: Queue<BulkEnrichmentDeadLetter>,
  job: Job<BulkEnrichmentJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return; // retries remain — not dead yet
  const parsed = bulkEnrichmentJobDataSchema.safeParse(job.data);
  if (!parsed.success) return; // unparseable payload — nothing safe (or useful) to record
  const { kind, jobId, scope } = parsed.data;
  const record: BulkEnrichmentDeadLetter = {
    jobId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    kind,
    reason: err.message,
  };
  await deadLetterQueue.add("dead-letter", record);
}
