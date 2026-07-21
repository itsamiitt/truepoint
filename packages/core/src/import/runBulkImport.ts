// runBulkImport.ts — the DRIVE orchestrator + the finalize hook for the bulk COPY-staging import (15-bulk-import-
// design §2, backlog #2, phase 5). DRIVE stages the file then plans + fans out chunk jobs; FINALIZE runs after the
// LAST chunk to flip the job terminal and clean up. Both are DEAD CODE until phase-6 wires apps/workers to them.
//
// DECOUPLED FROM THE QUEUE: the caller injects `enqueueChunk` (jobId, scope, chunkId), so core never imports
// BullMQ/Redis (the worker provides the real enqueue; a test passes a collector). WATERMARK-RESUMABLE: a re-driven
// job whose staging is already done re-enqueues only its non-`completed` chunks — it never re-stages (which would
// double-load the staging table).

import {
  type ImportJobRow,
  importJobRepository,
  importStagingRepository,
  withTenantTx,
} from "@leadwolf/db";
import type { BulkImportScope, BulkImportJobStatus } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";
import { assertListInWorkspace } from "../prospect/lists.ts";
import type { MalwareScannerPort } from "../security/malwareScanner.ts";
import type { FileStore } from "../storage/fileStore.ts";
import { type BulkStageResult, bulkStage } from "./bulkStage.ts";
import { rejectedRowsToCsv } from "./rejectedRowsCsv.ts";

/** Chunk band size (~10k rows by source_row_num). A target, not locked (15 §6) — phase-6 may tune it. */
const CHUNK_ROWS = 10_000;

/** Inject the queue enqueue so core stays free of BullMQ/Redis — the worker passes the real producer. */
export type EnqueueChunk = (
  jobId: string,
  scope: BulkImportScope,
  chunkId: string,
) => Promise<void> | void;

export interface RunBulkImportInput {
  scope: BulkImportScope;
  jobId: string;
  fileStore: FileStore;
  enqueueChunk: EnqueueChunk;
  /**
   * Bounded rolling fan-out window K (import-redesign 09 §2.2, S-Q2): the drive enqueues only the first
   * `min(K, bands)` chunk jobs; each completed chunk enqueues the next pending band
   * (continueChunkWindow) — a self-perpetuating window, reaper-healable from the chunk rows (DB is truth).
   * Also dodges addBulk-style degradation above ~1k jobs. 0/undefined = ∞ sentinel = legacy enqueue-all.
   */
  chunkWindow?: number;
  /**
   * S-S2 wire point 2 (G08, import-redesign 13 §2.2): the drive re-checks `av_scan_status ∈ {clean}` BEFORE
   * parse/staging — "promote-to-staging re-checks the gate". Injected by the worker (core stays vendor-free;
   * the api's admission seam is wire point 1). Absent or the stub (`real: false`) ⇒ today's behavior,
   * byte-identical (records stay 'skipped'/'pending'). With a REAL scanner: a not-yet-clean job's stored
   * object is scanned now — `infected` ⇒ the `failed` terminal (av_infected; NO quarantine state — 08 §2.1's
   * machine has none) with the object left in place but unreachable (no tenant download path reads a source
   * object; S-S7's lifecycle bounds it); `error` ⇒ THROW (fail-closed into the normal retry budget → DLQ —
   * a scanner outage delays imports, it never admits an unscanned file).
   */
  malwareScanner?: MalwareScannerPort;
}

/** Resolve the effective fan-out count under the window (0/undefined = ∞ sentinel = enqueue all). */
export function chunkWindowLimit(window: number | undefined, totalPending: number): number {
  if (!window || window <= 0) return totalPending;
  return Math.min(window, totalPending);
}

export interface RunBulkImportResult {
  jobId: string;
  status: BulkImportJobStatus;
  totalChunks: number;
  enqueuedChunks: number;
  resumed: boolean;
  /** Present on a fresh drive (absent on a resume) — the stage counters + the rejected-rows artifact source. */
  stage?: BulkStageResult;
  /** S-S2: true when the drive-time AV re-check found the object infected and wrote the failed terminal —
   *  the worker meters + operator-notifies on it (13 §9.2: an infected verdict is the control WORKING). */
  infected?: boolean;
}

export interface FinalizeIfLastChunkInput {
  scope: BulkImportScope;
  jobId: string;
  /** Reserved for signature parity with the design's finalize step. The rejected-rows artifact is written by the
   *  DRIVE phase (runBulkImport) — finalize cannot reconstruct it (rejected rows are never staged nor laddered
   *  into import_job_rows), so this is currently unused here. */
  fileStore?: FileStore;
}

export interface FinalizeResult {
  /** true only on the LAST chunk's call (the one that drove completed_chunks === total_chunks). */
  finalized: boolean;
  /** true when finalize ran AND the job landed ≥1 contact — the phase-6 worker fires the dedup / firmographics /
   *  masterBackfill rollups ONCE on this signal. */
  fireRollups: boolean;
}

interface Band {
  start: number;
  end: number;
}

/** Plan ~`size`-row bands over the source_row_num range `[0, total)`. End is exclusive (readChunkBand uses it as a
 *  half-open band). Returns [] for an empty (header-only) file. */
function planBands(total: number, size: number): Band[] {
  const bands: Band[] = [];
  for (let start = 0; start < total; start += size) {
    bands.push({ start, end: Math.min(start + size, total) });
  }
  return bands;
}

/**
 * DRIVE: stage the uploaded file, write the rejected-rows artifact, plan the chunk bands, and fan out one chunk
 * job per band. The target list (if any) is validated up-front (trust boundary; list-plan D4 — the client id is
 * never trusted). Resumable: an already-staged job re-enqueues only its non-`completed` chunks.
 */
export async function runBulkImport(input: RunBulkImportInput): Promise<RunBulkImportResult> {
  const { scope, jobId, fileStore, enqueueChunk, chunkWindow, malwareScanner } = input;

  const job: ImportJobRow | null = await withTenantTx(scope, (tx) =>
    importJobRepository.getJobSystem(tx, jobId),
  );
  if (!job) throw new Error(`runBulkImport: job not found (${jobId})`);

  // RESUME — staging already done + chunks exist: re-enqueue only the unfinished chunks (windowed — the
  // continuation refills as they complete); never re-stage.
  const existingChunks = await withTenantTx(scope, (tx) => importJobRepository.listChunks(tx, jobId));
  if (job.stagingTable && existingChunks.length > 0) {
    const pending = existingChunks.filter((c) => c.status !== "completed");
    const limit = chunkWindowLimit(chunkWindow, pending.length);
    let enqueued = 0;
    for (const c of pending.slice(0, limit)) {
      await enqueueChunk(jobId, scope, c.id);
      enqueued += 1;
    }
    return {
      jobId,
      status: job.status as BulkImportJobStatus,
      totalChunks: existingChunks.length,
      enqueuedChunks: enqueued,
      resumed: true,
    };
  }

  // Trust boundary: a foreign/absent target list fails the whole import BEFORE any chunk runs (list-plan D4).
  if (job.targetListId) {
    await assertListInWorkspace({
      scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
      listId: job.targetListId,
    });
  }

  await withTenantTx(scope, (tx) =>
    importJobRepository.updateJobStatus(tx, jobId, { status: "validating", startedAt: new Date() }),
  );

  // ── S-S2 wire point 2 (G08, 13 §2.2): the AV gate, re-checked BEFORE parse/staging. Scan STRICTLY
  // precedes parse — bulkStage (the CSV parser) is itself attack surface (13 §1.4), so nothing below runs
  // until the verdict is in. Already-'clean' (upload-time verdict) skips the re-scan; 'infected' on the row
  // is a defensive terminal (should have been refused at admission); otherwise a REAL scanner scans the
  // stored object now. Stub/absent ⇒ proceed exactly as today (dark, byte-identical).
  if (job.avScanStatus !== "clean") {
    const failInfected = async (signature?: string): Promise<RunBulkImportResult> => {
      await withTenantTx(scope, async (tx) => {
        await importJobRepository.updateJobStatus(tx, jobId, {
          status: "failed",
          avScanStatus: "infected",
          // The STABLE code, never the filename or raw scanner output (13 §2.2); the signature name is
          // non-PII and aids the quarantine-review runbook, carried only when the engine issued one.
          failedReason: signature ? `av_infected:${signature}` : "av_infected",
          completedAt: new Date(),
        });
        // In-tx audit of the infected terminal (13 §2.2/§2.3, 08 §7 discipline) — the action entered the
        // audit CHECK with 0057 (ruling M1's P2 train; closes the doc-16 2026-07-05 deferral). Actor is
        // null = system (the drive acts for the job, not a user); facets are NON-PII by construction: the
        // job id + the engine's signature LABEL only — never the filename, never raw scanner output.
        await writeAudit(tx, {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          actorUserId: null,
          action: "import.av_infected",
          entityType: "import_job",
          entityId: jobId,
          metadata: signature ? { signature } : {},
        });
      });
      return { jobId, status: "failed", totalChunks: 0, enqueuedChunks: 0, resumed: false, infected: true };
    };
    if (job.avScanStatus === "infected") return failInfected();
    if (malwareScanner?.real) {
      const verdict = await malwareScanner.scan(await fileStore.getObjectStream(job.sourceFile));
      if (verdict.verdict === "infected") return failInfected(verdict.signature);
      if (verdict.verdict === "clean") {
        // Record the cleared gate (the repository's documented avScanStatus rider) — status stays
        // 'validating' (this is the same phase, not a transition).
        await withTenantTx(scope, (tx) =>
          importJobRepository.updateJobStatus(tx, jobId, {
            status: "validating",
            avScanStatus: "clean",
          }),
        );
      } else {
        // 'error'/'skipped' from a REAL engine ⇒ FAIL-CLOSED: throw into the normal retry budget (09 §3);
        // exhaustion dead-letters the drive (operator redrive after the scanner recovers is idempotent —
        // staging never started). Never parse an unscanned object.
        throw new Error("bulk-import: malware scan unavailable — failing closed (av_unavailable)");
      }
    }
  }

  const stagingTable = importStagingRepository.stagingTableName(jobId);
  await importStagingRepository.createStagingTable(jobId, scope.workspaceId);

  const stage = await bulkStage({ scope, job, fileStore });

  // Rejected-rows artifact — written HERE: only the drive phase holds the rejected rows in memory (finalize
  // cannot reconstruct them). Best-effort: a write failure must never fail the import. (The job-row link is
  // deferred to phase-6 — importJobRepository has no rejected_artifact_key setter yet; the key is deterministic.)
  if (stage.rejectedRows.length > 0) {
    try {
      await fileStore.putArtifact(
        `imports/${jobId}/rejected-rows.csv`,
        Buffer.from(rejectedRowsToCsv(stage.rejectedRows), "utf8"),
      );
    } catch (err) {
      console.error("[bulk-import] failed to write rejected-rows artifact", err);
    }
  }

  const bands = planBands(stage.total, CHUNK_ROWS);

  // Record stage accounting + the `staged` transition (counters are atomic deltas onto the zeroed columns).
  await withTenantTx(scope, async (tx) => {
    await importJobRepository.updateJobStatus(tx, jobId, {
      status: "staged",
      stagingTable,
      totalChunks: bands.length,
      rejectHistogram: stage.rejectHistogram,
    });
    await importJobRepository.updateJobProgress(tx, jobId, {
      rowsTotal: stage.total,
      rowsRejected: stage.rejected,
      rowsDeduped: stage.dedupedInFile,
    });
  });

  // Zero data rows (header-only file): no chunk will ever fire finalize → finalize inline + drop staging.
  if (bands.length === 0) {
    const status: BulkImportJobStatus = stage.rejected > 0 ? "partial" : "completed";
    await withTenantTx(scope, (tx) =>
      importJobRepository.updateJobStatus(tx, jobId, { status, completedAt: new Date() }),
    );
    await importStagingRepository
      .dropStagingTable(jobId)
      .catch((err) => console.error("[bulk-import] failed to drop staging table", err));
    return { jobId, status, totalChunks: 0, enqueuedChunks: 0, resumed: false, stage };
  }

  // Create every chunk band in ONE tx, then enqueue AFTER commit so a worker never races a not-yet-visible chunk.
  const chunkIds: string[] = [];
  await withTenantTx(scope, async (tx) => {
    for (let i = 0; i < bands.length; i += 1) {
      const id = await importJobRepository.createChunk(tx, {
        jobId,
        chunkIndex: i,
        rowStart: bands[i]!.start,
        rowEnd: bands[i]!.end,
      });
      chunkIds.push(id);
    }
  });
  // Bounded rolling fan-out (S-Q2): only the first K bands enter the queue; each completion enqueues the
  // next pending band (continueChunkWindow in the worker). K=0/undefined keeps the legacy enqueue-all.
  const limit = chunkWindowLimit(chunkWindow, chunkIds.length);
  let enqueued = 0;
  for (const id of chunkIds.slice(0, limit)) {
    await enqueueChunk(jobId, scope, id);
    enqueued += 1;
  }

  return {
    jobId,
    status: "staged",
    totalChunks: bands.length,
    enqueuedChunks: enqueued,
    resumed: false,
    stage,
  };
}

/**
 * The window CONTINUATION (09 §2.2, S-Q2): after a chunk completes (and did not finalize the job), enqueue
 * the lowest-indexed still-pending chunks up to the window. Over-enqueueing is harmless BY CONSTRUCTION:
 * the stable `import-chunk:<chunkId>` jobId dedupes at the queue and the chunk processor's terminal-skip
 * discards a re-delivered completed band — so a crashed continuation is healed by the reaper (S-Q5) and a
 * duplicate continuation is a no-op. Cheap: one chunk-list read per completion.
 */
export async function continueChunkWindow(args: {
  scope: BulkImportScope;
  jobId: string;
  enqueueChunk: EnqueueChunk;
  window: number;
}): Promise<number> {
  const { scope, jobId, enqueueChunk, window } = args;
  if (!window || window <= 0) return 0; // ∞ sentinel: the drive enqueued everything already
  const chunks = await withTenantTx(scope, (tx) => importJobRepository.listChunks(tx, jobId));
  const pending = chunks.filter((c) => c.status === "queued");
  let enqueued = 0;
  for (const c of pending.slice(0, window)) {
    await enqueueChunk(jobId, scope, c.id);
    enqueued += 1;
  }
  return enqueued;
}

/**
 * FINALIZE: atomically `completed_chunks += 1` and, when that reaches `total_chunks`, flip the job terminal
 * (`completed`, or `partial` if any rows were rejected/unprocessed), then best-effort DROP the staging table.
 * Returns `{ finalized, fireRollups }` so the phase-6 worker fires the dedup/firmographics/masterBackfill rollups
 * exactly ONCE. The caller MUST invoke this only after a real chunk completion (bulkProcessChunk `processed===true`)
 * so the increment happens once per chunk.
 */
export async function finalizeIfLastChunk(
  input: FinalizeIfLastChunkInput,
): Promise<FinalizeResult> {
  const { scope, jobId } = input;

  const outcome = await withTenantTx(scope, async (tx) => {
    const tally = await importJobRepository.incrementCompletedChunks(tx, jobId);
    if (tally.completedChunks < tally.totalChunks) return { last: false, fireRollups: false };
    const job = await importJobRepository.getJobSystem(tx, jobId);
    const rejected = job?.rowsRejected ?? 0;
    const unprocessed = job?.rowsUnprocessed ?? 0;
    const landed = (job?.rowsCreated ?? 0) + (job?.rowsMatched ?? 0);
    const status: BulkImportJobStatus = rejected > 0 || unprocessed > 0 ? "partial" : "completed";
    await importJobRepository.updateJobStatus(tx, jobId, { status, completedAt: new Date() });
    return { last: true, fireRollups: landed > 0 };
  });

  if (!outcome.last) return { finalized: false, fireRollups: false };

  // Best-effort cleanup: dropping the staging table must NEVER fail the job (it is non-RLS, UNLOGGED, transient).
  await importStagingRepository
    .dropStagingTable(jobId)
    .catch((err) => console.error("[bulk-import] failed to drop staging table on finalize", err));

  return { finalized: true, fireRollups: outcome.fireRollups };
}
