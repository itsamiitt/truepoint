// runFastImport.ts — the S-I3 fast-path dual-write wrapper (import-and-data-model-redesign 08 §1.2 Phase A,
// 09 §1.1): drives ONE fast-mode import through the durable `import_jobs` state machine AROUND the UNCHANGED
// `runImport` engine. The wrapper owns exactly three things — state transitions (queued→validating→running→
// completed|partial|failed), the single real `import_job_chunks` row (uniform accounting, 08 §1.1), and the
// terminal tx that translates runImport's summary into ATOMIC counter deltas + the rejected-rows ledger —
// and NOTHING about how a row lands (mapping/dedup/encrypt/merge stay byte-identical to the legacy path;
// one implementation, two transports). G03 closes here: the poll endpoint reads the durable row this
// wrapper maintains, never `Job.getState()`.
//
// Idempotency & retry posture (09 §3 chunk row, applied to the fast kind):
//   • counter deltas + ledger + completed-chunk increment commit ONCE, in the SAME terminal tx as the
//     status flip — a failed attempt contributes NOTHING (a re-run's per-row effects are already no-ops via
//     source_imports.content_hash, so the re-run's summary is the truthful tally);
//   • a replay of an already-terminal job is a TERMINAL-SKIP no-op (stable BullMQ jobId dedupes most
//     replays at the queue; this guard catches the rest);
//   • zero-progress (total > 0, nothing landed) THROWS FastImportFailedError — mirroring the legacy
//     consumer's ImportFailedError semantics byte-for-byte — so BullMQ retries and, on exhaustion, the
//     worker's failed-hook calls markFastImportFailed to write the honest `failed` terminal.

import { env } from "@leadwolf/config";
import {
  importJobRepository,
  withTenantTx,
  type ImportJobProgressDelta,
  type ImportJobRowInsert,
} from "@leadwolf/db";
import type { ImportFastInput, ImportSummary } from "@leadwolf/types";
import { ACTIVE_IMPORT_STATUSES } from "./importFairness.ts";
import { runImport, type RunImportInput } from "./runImport.ts";

export interface RunFastImportInput {
  scope: { tenantId: string; workspaceId: string };
  /** The durable import_jobs.id (the public jobId — one job identity for both modes, 08 §1.1). */
  jobId: string;
  input: ImportFastInput;
  /** How many times the deferred lane has already re-enqueued this job (S-Q2; payload `deferrals`). */
  deferrals?: number;
  /**
   * S-Q2 deferred-lane transport (Phase A): when a claim finds the job `deferred` AND the workspace still
   * at its cap, the wrapper calls this to re-enqueue the SAME payload after env.IMPORT_DEFER_RECHECK_DELAY_MS
   * (rows travel in the payload, so parking without transport would strand them — importV2.ts). Injected by
   * the worker so core never touches BullMQ. Absent ⇒ the cap re-check is skipped and a deferred claim
   * promotes unconditionally (test/tooling convenience; the worker always injects it).
   */
  requeueDeferred?: (nextDeferrals: number) => Promise<void>;
}

/** Non-PII result for per-queue observability (mirrors BulkImportProcessResult's discipline). */
export interface FastImportResult {
  kind: "fast";
  jobId: string;
  /** The terminal status written (or the pre-existing one on a terminal-skip replay). */
  status: string;
  /** false on a terminal-skip replay — the completed-handler must NOT re-fire rollups/notifications. */
  finalized: boolean;
  /** true when the claim found the workspace at its cap and re-enqueued instead of running (S-Q2). */
  deferred?: boolean;
  created: number;
  matched: number;
  duplicate: number;
  skipped: number;
  rejected: number;
  total: number;
  /** ≥1 row landed (created/matched/skipped/duplicate resolved to a workspace contact) — the rollup trigger. */
  landed: boolean;
  /** Mirrors runImport's addedToList tally for the completed-notification copy (not persisted — see S-I4). */
  addedToList: number;
}

/** A wholly-failed fast import (zero rows landed out of >0): thrown so BullMQ retries and, once attempts are
 *  exhausted, the worker's failed-hook writes the `failed` terminal via markFastImportFailed. Mirrors the
 *  legacy consumer's ImportFailedError (imports.ts) — the retry semantics are byte-identical by design. */
export class FastImportFailedError extends Error {
  readonly summary: ImportSummary;
  constructor(summary: ImportSummary) {
    super(
      `Fast import made no progress: 0/${summary.total} rows imported (${summary.errors.length} errored).`,
    );
    this.name = "FastImportFailedError";
    this.summary = summary;
  }
}

const TERMINAL = new Set(["completed", "partial", "failed", "cancelled"]);

/**
 * Execute one fast-mode import against its durable job row. The engine call in the middle is the UNCHANGED
 * `runImport` (its own per-row withTenantTx transactions); everything around it is short, single-purpose
 * transactions on the control plane. Safe to replay: terminal-skip + once-only terminal accounting.
 */
export async function runFastImport(args: RunFastImportInput): Promise<FastImportResult> {
  const { scope, jobId, input } = args;
  const total = input.rows.length;

  // ── Claim: terminal-skip guard + the S-Q2 cap re-check + queued→validating (+ the single chunk row) ────
  const claim = await withTenantTx(scope, async (tx) => {
    const job = await importJobRepository.getJobSystem(tx, jobId);
    if (!job) throw new Error(`runFastImport: durable job row not found (${jobId})`);
    if (TERMINAL.has(job.status)) {
      // Replay of a settled job (at-least-once transport): a no-op, never a second effect.
      return { skip: true as const, status: job.status };
    }
    // Deferred lane (09 §2.2, S-Q2): the commit verb parked this job at the workspace cap. Re-check the
    // census at claim: still at cap ⇒ re-enqueue after the recheck delay (outside this tx) and exit without
    // touching the row (the leader-locked sweep is the DB-truth promoter; this loop is the Phase-A
    // transport). Below cap ⇒ promote and run — deferred→queued→validating collapses into this claim tx
    // (the sweep's flip and this claim converge; the pinned-status UPDATE in the sweep makes racing safe).
    if (job.status === "deferred" && args.requeueDeferred) {
      const cap = env.IMPORT_WORKSPACE_JOB_CAP;
      if (cap > 0) {
        const active = await importJobRepository.countJobsByStatuses(tx, scope.workspaceId, [
          ...ACTIVE_IMPORT_STATUSES,
        ]);
        if (active >= cap) return { skip: true as const, status: "deferred", defer: true as const };
      }
    }
    await importJobRepository.updateJobStatus(tx, jobId, {
      status: "validating",
      startedAt: job.startedAt ?? new Date(),
      totalChunks: 1,
    });
    // Exactly ONE real chunk row (uniform accounting, 08 §1.1). A retry attempt reuses the existing row —
    // the (job_id, chunk_index) unique is the idempotency backstop; `attempts` counts the re-claims.
    const chunks = await importJobRepository.listChunks(tx, jobId);
    const chunk = chunks.find((c) => c.chunkIndex === 0) ?? null;
    let chunkId: string;
    if (chunk) {
      chunkId = chunk.id;
      await importJobRepository.updateChunk(tx, chunkId, {
        status: "running",
        incrementAttempts: true,
      });
    } else {
      chunkId = await importJobRepository.createChunk(tx, {
        jobId,
        chunkIndex: 0,
        rowStart: 0,
        rowEnd: total, // half-open band, planBands convention
        status: "running",
      });
    }
    // A chunk already `completed` with a non-terminal job = a crash between the chunk tx and nothing (they
    // commit together below), so this cannot normally occur; guard anyway so accounting never double-applies.
    return { skip: false as const, chunkId, chunkDone: chunk?.status === "completed" };
  });
  if (claim.skip) {
    const stillDeferred = "defer" in claim && claim.defer === true;
    if (stillDeferred && args.requeueDeferred) {
      // Outside the tx: the payload re-enqueues itself with the recheck delay (rows must not be lost).
      await args.requeueDeferred((args.deferrals ?? 0) + 1);
    }
    return {
      kind: "fast",
      jobId,
      status: claim.status,
      finalized: false,
      deferred: stillDeferred,
      created: 0,
      matched: 0,
      duplicate: 0,
      skipped: 0,
      rejected: 0,
      total,
      landed: false,
      addedToList: 0,
    };
  }

  await withTenantTx(scope, (tx) =>
    importJobRepository.updateJobStatus(tx, jobId, { status: "running" }),
  );

  // ── The UNCHANGED engine (05 §3): per-row txs, ladder dedup, provenance — byte-identical to legacy. ────
  const runInput: RunImportInput = {
    scope,
    importedByUserId: input.importedByUserId,
    sourceName: input.sourceName,
    sourceFile: input.sourceFile,
    mapping: input.mapping,
    conflictPolicy: input.conflictPolicy,
    rows: input.rows,
    target: input.target,
  };
  const summary = await runImport(runInput);

  // Zero-progress = a job-level failure that must RETRY, not silently complete (legacy semantics preserved).
  // The durable row stays `running`; the failed-hook writes the terminal on exhaustion.
  const landedCount = summary.created + summary.matched + summary.skipped + summary.duplicates;
  if (summary.total > 0 && landedCount === 0) throw new FastImportFailedError(summary);

  // ── Terminal tx: deltas + ledger + chunk completion + status flip commit TOGETHER, exactly once. ───────
  const status = summary.rejected > 0 ? "partial" : "completed";
  await withTenantTx(scope, async (tx) => {
    const job = await importJobRepository.getJobSystem(tx, jobId);
    // Cancel/terminal wins (08 §2.1 legality; the full FOR UPDATE guard is S-I4's cancel verb work): if the
    // job settled while the engine ran, never overwrite the terminal — committed rows stay (stop-remainder).
    if (!job || TERMINAL.has(job.status)) return;
    if (!claim.chunkDone) {
      const delta: ImportJobProgressDelta = {
        rowsTotal: summary.total,
        rowsCreated: summary.created,
        rowsMatched: summary.matched,
        rowsDuplicate: summary.duplicates,
        rowsSkipped: summary.skipped,
        rowsRejected: summary.rejected,
      };
      await importJobRepository.updateJobProgress(tx, jobId, delta);
      // Rejected-rows ledger (08 §6.1): one import_job_rows entry per rejected INPUT LINE — summary
      // .rejectedRows may carry >1 reason per row (one per offending field), so dedupe by row index with
      // the PRIMARY (first) reason, mirroring summary.errors. Landed rows' per-row outcomes are NOT
      // derivable from the summary (runImport reports them in aggregate only) — their ledger coverage
      // arrives with the artifact step (S-I7); counters carry the truth meanwhile.
      const byRow = new Map<number, (typeof summary.rejectedRows)[number]>();
      for (const r of summary.rejectedRows) {
        if (!byRow.has(r.row)) byRow.set(r.row, r);
      }
      const ledger: ImportJobRowInsert[] = [...byRow.values()].map((r) => ({
        jobId,
        chunkId: claim.chunkId,
        rowIndex: r.row,
        workspaceId: scope.workspaceId,
        input: r.raw,
        outcome: "rejected",
        rejectReason: r.reason,
      }));
      await importJobRepository.insertJobRows(tx, ledger);
      await importJobRepository.updateChunk(tx, claim.chunkId, {
        status: "completed",
        processedRows: summary.total,
        completedAt: new Date(),
      });
      await importJobRepository.incrementCompletedChunks(tx, jobId);
    }
    await importJobRepository.updateJobStatus(tx, jobId, {
      status,
      completedAt: new Date(),
      rejectHistogram: summary.rejectHistogram,
    });
  });

  return {
    kind: "fast",
    jobId,
    status,
    finalized: true,
    created: summary.created,
    matched: summary.matched,
    duplicate: summary.duplicates,
    skipped: summary.skipped,
    rejected: summary.rejected,
    total: summary.total,
    landed: landedCount > 0,
    addedToList: summary.addedToList,
  };
}

/**
 * Terminal `failed` writer for a fast job whose attempts are EXHAUSTED (the worker's failed-hook calls this
 * exactly once, alongside the PII-free dead-letter). Idempotent: a terminal job is left untouched. The
 * accounting identity still holds on the failed terminal: rejected rows are counted and the un-landed
 * remainder is `unprocessed` (created+matched+duplicate+skipped+rejected+deduped+unprocessed = rows_total).
 * `failedReason` must be PII-FREE — pass a bucketed message, never a raw error that may quote row values.
 */
export async function markFastImportFailed(args: {
  scope: { tenantId: string; workspaceId: string };
  jobId: string;
  failedReason: string;
  /** The zero-progress summary when the exhausting error carried one (FastImportFailedError). */
  summary?: ImportSummary;
  /** Fallback row count when no summary is available (payload rows length). */
  totalRows?: number;
}): Promise<void> {
  const { scope, jobId, failedReason } = args;
  await withTenantTx(scope, async (tx) => {
    const job = await importJobRepository.getJobSystem(tx, jobId);
    if (!job || TERMINAL.has(job.status)) return;
    const total = args.summary?.total ?? args.totalRows ?? 0;
    const rejected = args.summary?.rejected ?? 0;
    if (job.rowsTotal === 0 && total > 0) {
      await importJobRepository.updateJobProgress(tx, jobId, {
        rowsTotal: total,
        rowsRejected: rejected,
        rowsUnprocessed: total - rejected,
      });
    }
    const chunks = await importJobRepository.listChunks(tx, jobId);
    const chunk = chunks.find((c) => c.chunkIndex === 0);
    if (chunk && chunk.status !== "completed") {
      await importJobRepository.updateChunk(tx, chunk.id, {
        status: "failed",
        completedAt: new Date(),
      });
    }
    await importJobRepository.updateJobStatus(tx, jobId, {
      status: "failed",
      failedReason,
      completedAt: new Date(),
      rejectHistogram: args.summary?.rejectHistogram,
    });
  });
}
