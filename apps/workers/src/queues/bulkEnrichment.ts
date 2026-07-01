// bulkEnrichment.ts — the `bulk-enrichment` queue processor + dead-letter routing for the bulk CSV enrichment
// money path (prospect-database-platform I3 / audit A3/P08). The big-file sibling of enrichment.ts, following
// bulkImports.ts's drive→chunk shape (one implementation shape, two pipelines — 16 §3.2). DARK until
// BULK_ENRICHMENT_ENABLED is on: the apps/api producer enqueues nothing while the flag is off, so this consumer
// never runs in prod. SLICE 2 ships a NO-OP STUB — it validates the payload and returns WITHOUT touching the DB or
// any provider (ZERO spend). The real match-first/reuse-first/provider-spend logic + the maxProviderCostMicros
// per-run cap + the daily budget breaker land in slice 3, which will only ever process CONFIRMED `running` jobs.

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

/** A non-PII summary of what a single bulk-enrich job step did (per-queue observability; never the rows). */
export interface BulkEnrichmentProcessResult {
  kind: string;
  jobId: string;
  /** SLICE 2: always true — the processor is a no-op stub that spends nothing. Removed when slice 3 lands. */
  stub: boolean;
}

/**
 * SLICE-2 STUB processor. Validates + narrows the queue payload (defense in depth — the producer is trusted, but a
 * malformed/stale job must not crash the worker) and returns WITHOUT doing any work: no DB write, no chunk fan-out,
 * no provider call, so ZERO credits are spent. This exists only so the queue + DLQ can be wired end-to-end (and CI
 * can prove the dark pipeline is inert). Slice 3 replaces the body with the real chunked, spend-capped,
 * budget-broken enrichment that processes ONLY confirmed `running` jobs — and converts this to the injected
 * make*(deps) form (providers, FileStore, enqueueChunk, budget breaker), mirroring makeProcessBulkImport.
 */
export async function processBulkEnrichment(
  job: Job<BulkEnrichmentJobData>,
): Promise<BulkEnrichmentProcessResult> {
  const data = bulkEnrichmentJobDataSchema.parse(job.data);
  // Intentionally inert (slice 2): no repository write, no provider waterfall, no spend. Slice 3 fills this in.
  return { kind: data.kind, jobId: data.jobId, stub: true };
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
