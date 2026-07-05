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
  type FastImportResult,
  type FileStore,
  bulkProcessChunk,
  continueChunkWindow,
  finalizeIfLastChunk,
  runBulkImport,
  runFastImport,
} from "@leadwolf/core";
import {
  type BulkImportDeadLetter,
  type BulkImportJobData,
  type BulkImportScope,
  type ImportFastJobData,
  bulkImportJobDataSchema,
  importFastJobDataSchema,
} from "@leadwolf/types";
import type { Job, Queue } from "bullmq";

// Single source of truth for the queue names + payload type lives in @leadwolf/types so this consumer and the
// apps/api producer never drift (and apps never import apps). Re-exported for register.ts (the composition root).
export { BULK_IMPORTS_QUEUE, BULK_IMPORTS_DLQ } from "@leadwolf/types";
export type { BulkImportJobData } from "@leadwolf/types";

/** The unified `bulk-imports` payload union (09 §1.1, S-I3): legacy drive/chunk + the v2 `fast` lane. The
 *  legacy discriminated union in bulkImport.ts stays byte-untouched; the fast kind lives in importV2.ts. */
export type UnifiedImportJobData = BulkImportJobData | ImportFastJobData;

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
  /**
   * Whether the COPY kinds (drive/chunk) may run — env.BULK_IMPORT_ENABLED at the composition root (S-Q1,
   * 09 §1.1). Since the worker is now ALSO constructed under IMPORT_V2_ENABLED (the fast lane), a stale copy
   * job arriving while the copy gate is off must FAIL LOUDLY (retry→DLQ; operator redrive after enabling —
   * replay is idempotent) rather than run a gated pipeline or silently consume the job. The fast kind is
   * never affected by this switch.
   */
  copyEnabled: boolean;
  /** Bounded rolling fan-out window K (S-Q2; env.IMPORT_CHUNK_WINDOW at the root). 0 = ∞ = enqueue-all. */
  chunkWindow: number;
  /**
   * S-Q2 deferred-lane transport for the fast kind: re-enqueue the SAME fast payload after the recheck
   * delay (rows travel in the payload — parking without transport would strand them). The composition root
   * adds it with the fast priority band + a `:r<n>`-suffixed jobId (a spent stable id would dedupe the
   * re-enqueue away).
   */
  requeueFastDeferred: (data: ImportFastJobData, nextDeferrals: number) => Promise<void>;
}

/** A copy-kind job claimed while BULK_IMPORT_ENABLED is off (see BulkImportProcessDeps.copyEnabled). */
export class CopyKindsDisabledError extends Error {
  constructor(kind: string) {
    super(
      `bulk-imports: refusing '${kind}' job — BULK_IMPORT_ENABLED is off (copy kinds gated; fast lane only)`,
    );
    this.name = "CopyKindsDisabledError";
  }
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
    }
  | FastImportResult;

/**
 * Build the bulk-imports processor with its injected deps. A `drive` job stages the file + fans out chunk jobs; a
 * `chunk` job merges one band, and — ONLY on a real completion (processed === true) — calls finalizeIfLastChunk so
 * completed_chunks is incremented exactly once. The dedup/firmographics/masterBackfill rollups fire ONLY when
 * finalize reports fireRollups (the LAST chunk that landed ≥1 contact), exactly once per job.
 */
export function makeProcessBulkImport(deps: BulkImportProcessDeps) {
  return async function processBulkImport(
    job: Job<UnifiedImportJobData>,
  ): Promise<BulkImportProcessResult> {
    // v2 FAST lane (S-I3, 09 §1.1): the durable dual-write wrapper around the UNCHANGED runImport. The fast
    // kind rides the IMPORT_V2 dual gate at the PRODUCER (a fast job only exists if the tenant's gate was on
    // at submit); the consumer never re-checks env so an in-flight job still terminalizes after a mid-flight
    // flip-off (15 §R-P1 rehearsal (a)). Rows travel in this payload — the Phase-A transport bound
    // (importV2.ts) — so the DLQ path below must never copy `input` into a record.
    if ((job.data as { kind?: string }).kind === "fast") {
      const fast = importFastJobDataSchema.parse(job.data);
      return runFastImport({
        scope: fast.scope,
        jobId: fast.jobId,
        input: fast.input,
        deferrals: fast.deferrals ?? 0,
        requeueDeferred: (nextDeferrals) => deps.requeueFastDeferred(fast, nextDeferrals),
      });
    }

    // Defense in depth: re-validate + narrow the queue payload (the producer is trusted, but the discriminated
    // union guards a malformed/stale job). bulkImportJobDataSchema narrows `kind` → drive | chunk.
    const data = bulkImportJobDataSchema.parse(job.data);

    // COPY kinds stay gated by BULK_IMPORT_ENABLED even though the worker itself now boots for the fast lane.
    if (!deps.copyEnabled) throw new CopyKindsDisabledError(data.kind);

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
      // Rolling-window continuation (S-Q2, 09 §2.2): a completed band refills the window with the next
      // pending band(s). Idempotent by stable chunk jobIds + terminal-skip; the reaper heals a lost enqueue.
      if (!finalized) {
        await continueChunkWindow({
          scope: data.scope,
          jobId: data.jobId,
          enqueueChunk: deps.enqueueChunk,
          window: deps.chunkWindow,
        });
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
  job: Job<UnifiedImportJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return; // retries remain — not dead yet
  // The fast payload CARRIES ROWS (Phase-A transport bound) — extract scope/ids ONLY; the record stays
  // PII-free like every dead letter (the rows die with the queue job, never copied anywhere).
  const isFast = (job.data as { kind?: string }).kind === "fast";
  const parsed = isFast
    ? importFastJobDataSchema.safeParse(job.data)
    : bulkImportJobDataSchema.safeParse(job.data);
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
