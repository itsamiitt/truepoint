// bulkEnrichment.ts — the `bulk-enrichment` queue processor + dead-letter routing for the bulk (existing-contact)
// re-enrich money path (prospect-database-platform I3 / audit A3/P08). The sibling of enrichment.ts, following
// bulkImports.ts's drive→chunk shape (one implementation shape, two pipelines — 16 §3.2). DARK until
// BULK_ENRICHMENT_ENABLED is on: the apps/api producer enqueues nothing while the flag is off, so this consumer
// never runs in prod. The real `drive` (runBulkEnrich — chunk a CONFIRMED job's contact selection into bands,
// FREE/zero provider calls, slice 3a) and the real `chunk` (bulkProcessEnrichChunk — re-enrich the band via the
// shipped enrichContact, braked by the per-run cap = the confirmed ceiling AND the inherited daily breaker, slice
// 3b) are both wired here. Nothing spends until BULK_ENRICHMENT_ENABLED is on AND a job has passed the confirm gate.

import {
  type EnqueueEnrichChunk,
  type EnrichmentProvider,
  bulkProcessEnrichChunk,
  runBulkEnrich,
} from "@leadwolf/core";
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

/** The dependencies the composition root injects so core never imports BullMQ/Redis or a vendor SDK directly. */
export interface BulkEnrichmentProcessDeps {
  /** Fan out one `chunk` job per band onto the bulk-enrichment queue (the drive phase calls this per band). */
  enqueueChunk: EnqueueEnrichChunk;
  /** The vendor adapters (defaultProviders) the chunk phase feeds to enrichContact — mirrors processEnrichment. */
  providers: EnrichmentProvider[];
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
      processedRows: number;
      matched: number;
      enriched: number;
      charged: number;
      costMicros: number;
      /** true when a brake (per-run cap OR the daily breaker) stopped the run before the band was fully processed. */
      braked: boolean;
    };

/**
 * Build the bulk-enrichment processor with its injected deps (mirrors makeProcessBulkImport). A `drive` job chunks
 * a CONFIRMED (`running`) job into row bands + fans out `chunk` jobs — FREE, zero provider calls (runBulkEnrich
 * guards on `running`, so an unconfirmed job is never chunked). A `chunk` job re-enriches its band of contact ids
 * through the shipped enrichContact waterfall (bulkProcessEnrichChunk), braked by the per-run cap (the confirmed
 * ceiling) AND the inherited daily breaker — this is the only bulk step that spends, and it spends nothing until
 * BULK_ENRICHMENT_ENABLED is on and a job has been confirmed.
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

    const r = await bulkProcessEnrichChunk({
      scope: data.scope,
      jobId: data.jobId,
      chunkId: data.chunkId,
      providers: deps.providers,
    });
    return {
      kind: "chunk",
      jobId: data.jobId,
      processed: r.processed,
      processedRows: r.processedRows,
      matched: r.matched,
      enriched: r.enriched,
      charged: r.charged,
      costMicros: r.costMicros,
      braked: r.braked,
    };
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
