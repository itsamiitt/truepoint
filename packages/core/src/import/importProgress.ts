// importProgress.ts — S-Q6: the counter-delta cadence contract + THE one progress-derivation function
// (import-redesign 09 §4). Truth is the `import_jobs` row — status + the eight atomic `rows_*` counters +
// completed/total chunks (never BullMQ job.progress, never a read-modify-write); everything user-facing
// derives from it HERE, in one place, so the poll response, the (dark) SSE payloads, and the staff console
// can never disagree about what "43%" or "chunk 3 of 12" means (09 §4.1, §9.3 rule 3).
//
// Cadence (09 §4.2) — the WRITE-side contract the executors must honor, pinned as constants so tests can
// assert it instead of re-deriving it:
//   • copy chunk: ONE counter-delta UPDATE per merge batch (~IMPORT_PROGRESS_BATCH_ROWS rows), committed
//     inside the batch's tx ⇒ a 10k chunk writes ≤ IMPORT_PROGRESS_MAX_DELTAS_PER_CHUNK single-row UPDATEs;
//     job-row writers ≤ the chunk window K ⇒ negligible lock contention (doc 12 carries the envelope).
//   • fast: one delta per batch or per IMPORT_PROGRESS_MIN_INTERVAL_MS, whichever first — Phase A's
//     wrapper applies exactly ONE delta set, committed with the terminal tx (a failed attempt contributes
//     nothing; 09 §3's chunk rule), which trivially satisfies the bound.
//   • progress granularity is batch-level BY CHOICE — smoother displays interpolate client-side (doc 11),
//     never by writing more.

/** Rows per merge batch — one atomic counter-delta UPDATE commits with each batch's tx (09 §4.2). */
export const IMPORT_PROGRESS_BATCH_ROWS = 500;

/** Upper bound on job-row delta UPDATEs a single ~10k-row chunk may write (09 §4.2's "≤ 20"). */
export const IMPORT_PROGRESS_MAX_DELTAS_PER_CHUNK = 20;

/** Fast-lane delta floor AND the producer-side throttle window for the (dark) `import.job.progress` SSE
 *  event — one outbox row per window, never per batch, so event volume stays O(duration) (09 §4.4). */
export const IMPORT_PROGRESS_MIN_INTERVAL_MS = 2_000;

/** The structural slice of an import_jobs row the derivation needs (db rows and DTOs both satisfy it). */
export interface ImportProgressSource {
  status: string;
  rowsTotal: number;
  rowsCreated: number;
  rowsMatched: number;
  rowsDuplicate: number;
  rowsSkipped: number;
  rowsRejected: number;
  rowsDeduped: number;
  rowsUnprocessed: number;
  completedChunks: number;
  totalChunks: number;
}

export interface DerivedImportProgress {
  /** 0..1. Terminal ⇒ 1 by definition ("done is job-level"); pre-run states ⇒ 0. */
  percent: number;
  /** The 08 §2 state verbatim, except `running` ⇒ "chunk i of n" (09 §4.1) — one vocabulary, three
   *  renderings: the API returns the raw enum alongside; customer copy maps per 09 §9.2; staff sees both. */
  stage: string;
  /** Rows accounted for so far — the sum of ALL outcome buckets (the accounting-identity view: at a
   *  terminal this EQUALS rowsTotal or the identity is violated, which is an S1, not a display bug). */
  processedRows: number;
}

const TERMINAL_STATES = new Set(["completed", "partial", "failed", "cancelled"]);

/**
 * Derive user-facing progress from durable truth. Pure and total: any status yields a sane result (an
 * unknown future state degrades to its raw name + counter ratio, never a throw — the poll must ALWAYS
 * answer, 09 §4.3). Fast mode is the plain rows ratio; copy mode's row counters only advance with each
 * band's commit tx, so the same ratio IS the chunk-weighted blend of 09 §4.1 (completed bands + the
 * current band's committed batches) — one formula, two modes, no divergence.
 */
export function deriveImportProgress(job: ImportProgressSource): DerivedImportProgress {
  const processedRows =
    job.rowsCreated +
    job.rowsMatched +
    job.rowsDuplicate +
    job.rowsSkipped +
    job.rowsRejected +
    job.rowsDeduped +
    job.rowsUnprocessed;

  let percent: number;
  if (TERMINAL_STATES.has(job.status)) {
    percent = 1;
  } else if (job.rowsTotal > 0) {
    percent = Math.min(1, processedRows / job.rowsTotal);
  } else if (job.totalChunks > 0) {
    // Copy mode before the stage tx recorded rows_total (or a zero-row edge): fall back to band ratio.
    percent = Math.min(1, job.completedChunks / job.totalChunks);
  } else {
    percent = 0;
  }

  const stage =
    job.status === "running" && job.totalChunks > 0
      ? `chunk ${Math.min(job.completedChunks + 1, job.totalChunks)} of ${job.totalChunks}`
      : job.status;

  return { percent, stage, processedRows };
}
