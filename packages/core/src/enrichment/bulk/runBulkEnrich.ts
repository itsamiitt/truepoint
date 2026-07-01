// runBulkEnrich.ts — the DRIVE orchestrator for the bulk (existing-contact) re-enrich pipeline
// (prospect-database-platform I3 / audit A3/P08). The sibling of import/runBulkImport.ts, but for the LIVE
// bulk-enrich model: POST /contacts/bulk/enrich (core bulkEnrich) selects VISIBLE workspace contacts and records
// an enrichment_jobs control row whose `options.contactIds` IS the work-list (totalRows = its length). There is
// NO uploaded CSV and NO object store here — so, unlike bulk import, the drive plans bands over the stored row
// COUNT and never stages a file. It is FREE: chunking makes zero provider calls. The chunk handler (slice 3b)
// reads its band of contact ids and re-enriches each through the shipped enrichContact waterfall, under a per-run
// cap + the daily breaker. DECOUPLED FROM THE QUEUE: the caller injects `enqueueChunk`, so core never imports
// BullMQ/Redis. RESUMABLE: a re-driven job re-enqueues only its non-`completed` chunks; it never re-creates them.

import { type TenantScope, enrichmentJobRepository } from "@leadwolf/db";
import type { BulkEnrichmentScope } from "@leadwolf/types";

/** Chunk band size (~2k contacts per band). A target, not locked — slice 3b/GA may tune it. */
const CHUNK_ROWS = 2_000;

/** Inject the queue enqueue so core stays free of BullMQ/Redis — the worker passes the real producer. */
export type EnqueueEnrichChunk = (
  jobId: string,
  scope: BulkEnrichmentScope,
  chunkId: string,
) => Promise<void> | void;

export interface RunBulkEnrichInput {
  scope: BulkEnrichmentScope;
  jobId: string;
  enqueueChunk: EnqueueEnrichChunk;
}

export interface RunBulkEnrichResult {
  jobId: string;
  status: string;
  totalChunks: number;
  enqueuedChunks: number;
  resumed: boolean;
  /** true when the drive declined to chunk because the job had not passed the confirm gate (status ≠ running). */
  skipped?: boolean;
}

interface Band {
  start: number;
  end: number;
}

/** Plan ~`size`-row bands over the index range `[0, total)`. End is exclusive (the chunk handler slices the
 *  contact-id list with it as a half-open band). Returns [] for a zero-row job. */
function planBands(total: number, size: number): Band[] {
  const bands: Band[] = [];
  for (let start = 0; start < total; start += size) {
    bands.push({ start, end: Math.min(start + size, total) });
  }
  return bands;
}

/**
 * DRIVE: chunk a CONFIRMED bulk re-enrich job into row bands and fan out one `chunk` job per band. SPEND-SAFE
 * GUARD — only a job in `running` (i.e. one that has passed the slice-1b confirm gate) is ever chunked; a job that
 * has not been confirmed (queued/estimating/awaiting_confirmation) is left untouched (`skipped: true`), so no
 * downstream spend can be reached without a human first accepting the ceiling. Resumable: an already-chunked job
 * re-enqueues only its non-`completed` chunks. Chunk creation is ONE atomic batch, so a re-drive never sees a
 * partial set. Zero provider calls: banding is free.
 */
export async function runBulkEnrich(input: RunBulkEnrichInput): Promise<RunBulkEnrichResult> {
  const { scope, jobId, enqueueChunk } = input;
  const repoScope: TenantScope = scope;

  const job = await enrichmentJobRepository.getJob(repoScope, jobId);
  if (!job) throw new Error(`runBulkEnrich: job not found (${jobId})`);

  // CONFIRM GATE (defense in depth): only a confirmed run is chunked. Never advances a non-`running` job.
  if (job.status !== "running") {
    return {
      jobId,
      status: job.status,
      totalChunks: 0,
      enqueuedChunks: 0,
      resumed: false,
      skipped: true,
    };
  }

  // RESUME — chunks already exist: re-enqueue only the unfinished ones; never re-create (unique (job, chunkIndex)).
  const existing = await enrichmentJobRepository.listChunks(repoScope, jobId);
  if (existing.length > 0) {
    let enqueued = 0;
    for (const c of existing) {
      if (c.status === "completed") continue;
      await enqueueChunk(jobId, scope, c.id);
      enqueued += 1;
    }
    return { jobId, status: job.status, totalChunks: existing.length, enqueuedChunks: enqueued, resumed: true };
  }

  // Plan bands over the confirmed contact count (totalRows = options.contactIds.length, stored at submit).
  const bands = planBands(job.totalRows, CHUNK_ROWS);

  // Zero-row job: nothing to enrich — settle it so it never sits half-open in `running`.
  if (bands.length === 0) {
    await enrichmentJobRepository.updateJobStatus(repoScope, jobId, {
      status: "completed",
      completedAt: new Date(),
    });
    return { jobId, status: "completed", totalChunks: 0, enqueuedChunks: 0, resumed: false };
  }

  // Create every band in ONE atomic batch, THEN enqueue after commit so a worker never races a not-yet-visible chunk.
  const chunkIds = await enrichmentJobRepository.createChunks(
    repoScope,
    bands.map((b, i) => ({ jobId, chunkIndex: i, rowStart: b.start, rowEnd: b.end })),
  );
  let enqueued = 0;
  for (const id of chunkIds) {
    await enqueueChunk(jobId, scope, id);
    enqueued += 1;
  }

  return { jobId, status: "running", totalChunks: bands.length, enqueuedChunks: enqueued, resumed: false };
}
