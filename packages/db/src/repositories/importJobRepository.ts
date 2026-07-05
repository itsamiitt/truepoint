// importJobRepository.ts — data access for the bulk COPY-staging import CONTROL PLANE (15-bulk-import-design,
// backlog #2; phase 2). The job lifecycle CRUD over `import_jobs` / `import_job_chunks` / `import_job_rows`,
// mirroring enrichmentJobRepository idiom-for-idiom but TX-AWARE (every method takes a Tx, like
// verificationJobRepository / dataQualitySnapshotRepository): the caller composes them inside a single
// withTenantTx so RLS workspace isolation rides the GUC, chunks inherit it through their parent job, and a
// chunk/row write carries the workspace scope of that tx. Counter writes (updateJobProgress,
// incrementCompletedChunks) increment ATOMICALLY in SQL so concurrent chunk completions never clobber. The
// closed enums (BulkImportJobStatus / AvScanStatus / BulkImportRowOutcome / ConflictPolicy) come from @leadwolf/types
// and narrow at the edge; columns are string-widened like the rest of the package. No PII lives on these
// control rows (the per-job UNLOGGED staging table holds the transient PII and is owned by importStagingRepository).

import type {
  AvScanStatus,
  BulkImportJobStatus,
  BulkImportRowOutcome,
  ConflictPolicy,
  JobViewer,
} from "@leadwolf/types";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { importJobChunks, importJobRows, importJobs } from "../schema/importJobs.ts";
import { jobVisibility } from "./jobVisibility.ts";

// ── Row types (VerificationJob-style $inferSelect) ─────────────────────────────────────────────────────────

/** The control row (one per uploaded file) — all non-PII; safe to serialize for the status surface. */
export type ImportJobRow = typeof importJobs.$inferSelect;
/** A unit of work a runner claims (a contiguous row band of a job). */
export type ImportJobChunkRow = typeof importJobChunks.$inferSelect;
/** One per input CSV line — the create/match/reject ledger entry (HIGH VOLUME). */
export type ImportJobLedgerRow = typeof importJobRows.$inferSelect;

// ── Job lifecycle ──────────────────────────────────────────────────────────────────────────────────────

/** The writable columns the submit path computes for a job. Counters default to 0; status defaults queued. */
export interface ImportJobCreateValues {
  tenantId: string;
  workspaceId: string;
  createdByUserId?: string | null;
  sourceFile: string;
  sourceName: string;
  status?: BulkImportJobStatus;
  fileSize?: number | null;
  avScanStatus?: AvScanStatus;
  idempotencyKey?: string | null;
  columnMapping?: Record<string, unknown>;
  conflictPolicy?: ConflictPolicy;
  targetListId?: string | null;
  stagingTable?: string | null;
  // ── Import v2 unified-job columns (S-I1; written from S-I3 on, unread while the dual gate is off) ──
  /** The SERVER's routing verdict at commit/one-shot (08 §1): 'fast' | 'copy'. Absent = legacy row. */
  processingMode?: "fast" | "copy";
  /** The honest DISPLAY filename (source_name holds the SourceName provider enum — 08 §Contradiction scan). */
  sourceFilename?: string | null;
}

/**
 * Lifecycle transition for a job. `status` is required; the rest are sparse. `failedReason` is set only on the
 * `failed` transition. The drive phase sets `stagingTable` + `totalChunks` (+ `byteOffset` resume watermark)
 * on the same `staged` transition, and `avScanStatus` once the AV gate clears — so they ride this same patch.
 */
export interface ImportJobStatusUpdate {
  status: BulkImportJobStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
  failedReason?: string | null;
  avScanStatus?: AvScanStatus;
  stagingTable?: string | null;
  totalChunks?: number;
  byteOffset?: number;
  /** NON-PII reject breakdown (stable label → count) — a full SET (not a counter delta), so it rides this
   *  lifecycle patch rather than updateJobProgress. The drive phase writes it once, on the `staged` transition. */
  rejectHistogram?: Record<string, number>;
}

/** Row-accounting deltas applied ATOMICALLY (added to the current value) as a chunk finishes. All optional. */
export interface ImportJobProgressDelta {
  rowsTotal?: number;
  rowsCreated?: number;
  rowsMatched?: number;
  rowsDuplicate?: number;
  rowsSkipped?: number;
  rowsRejected?: number;
  rowsDeduped?: number;
  rowsUnprocessed?: number;
}

// ── Chunks ─────────────────────────────────────────────────────────────────────────────────────────────

/** A unit of work a runner claims (a contiguous row band of a job). */
export interface ImportChunkCreateValues {
  jobId: string;
  chunkIndex: number;
  rowStart: number;
  rowEnd: number;
  status?: BulkImportJobStatus; // the chunk status reuses a subset of the job-status vocabulary
}

/** Sparse chunk patch (undefined fields are left untouched; `attempts` increments atomically when set). */
export interface ImportChunkUpdate {
  status?: BulkImportJobStatus;
  processedRows?: number;
  incrementAttempts?: boolean;
  completedAt?: Date | null;
}

// ── Rows (high-volume per-input ledger) ──────────────────────────────────────────────────────────────────

/** One per input CSV line — the create/match/reject ledger entry. `workspaceId` is denormalized for RLS. */
export interface ImportJobRowInsert {
  jobId: string;
  chunkId: string;
  rowIndex: number;
  workspaceId: string;
  input?: Record<string, unknown>;
  outcome?: BulkImportRowOutcome; // closed set; widened so callers may pass the DB default
  rejectReason?: string | null;
  createdContactId?: string | null; // audit pointer (no FK)
  updatedContactId?: string | null; // audit pointer (no FK)
  matchedContactId?: string | null; // audit pointer (no FK)
  sourceImportId?: string | null; // audit pointer (no FK)
}

/** Drop undefined keys so an UPDATE never overwrites an existing value with `undefined`. */
function definedOnly<T extends object>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined)) as Partial<T>;
}

export const importJobRepository = {
  // ── Jobs ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Create a job. Idempotency is OPT-IN via `idempotencyKey` (the schema's unique index is partial —
   * `WHERE idempotency_key IS NOT NULL`): a re-submit carrying the same key collapses onto the existing job
   * (returns its id, `created: false`) — never a duplicate. With no key, every call creates a fresh job
   * (`created: true`). Workspace-scoped via RLS (compose inside withTenantTx).
   */
  async createJob(
    tx: Tx,
    values: ImportJobCreateValues,
  ): Promise<{ id: string; created: boolean }> {
    const insert = tx.insert(importJobs).values(values);
    const rows = values.idempotencyKey
      ? await insert
          .onConflictDoNothing({ target: [importJobs.workspaceId, importJobs.idempotencyKey] })
          .returning({ id: importJobs.id })
      : await insert.returning({ id: importJobs.id });
    if (rows[0]) return { id: rows[0].id, created: true };
    // The (workspace_id, idempotency_key) unique index collapsed the insert — fetch the job the key already
    // points at. Predicate is explicit on BOTH index columns (not RLS-only) so the lookup is self-contained
    // and can never resolve a foreign workspace's job that happens to share the key.
    const existing = await tx
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(
        and(
          eq(importJobs.workspaceId, values.workspaceId),
          eq(importJobs.idempotencyKey, values.idempotencyKey as string),
        ),
      )
      .limit(1);
    if (!existing[0]) throw new Error("import job vanished after idempotent conflict");
    return { id: existing[0].id, created: false };
  },

  /**
   * USER-FACING read of a job by id (import-redesign 10 §4.2 rule 2): RLS walls the workspace AND the
   * jobVisibility predicate narrows to the viewer (creator-or-shared for members; all for elevated; the
   * whole workspace while the dual gate is off). Invisible (foreign-user or absent) ⇒ null ⇒ the route 404s
   * without revealing existence — the same predicate as the list, so a leaked id is no IDOR side-door.
   * Worker/system paths must use getJobSystem (they act on behalf of the job, not a user — 10 §4.3).
   */
  async getJob(tx: Tx, viewer: JobViewer, jobId: string): Promise<ImportJobRow | null> {
    const rows = await tx
      .select()
      .from(importJobs)
      .where(
        and(
          eq(importJobs.id, jobId),
          jobVisibility(viewer, {
            createdByUserId: importJobs.createdByUserId,
            sharedWithWorkspace: importJobs.sharedWithWorkspace,
          }),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** SYSTEM read of a job by id — worker paths only (chunk runners, the drive, finalize): no viewer, RLS
   *  workspace isolation unchanged. Never call from a user-facing route (10 §4.3). */
  async getJobSystem(tx: Tx, jobId: string): Promise<ImportJobRow | null> {
    const rows = await tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    return rows[0] ?? null;
  },

  /**
   * List the jobs VISIBLE TO THE VIEWER, most-recent first, capped at `limit` (default 50, max 200).
   * Workspace-scoped via RLS (the `import_jobs_workspace_isolation` policy) AND viewer-scoped via the
   * jobVisibility predicate baked in BEFORE the tenant list route ever exists (10 §5 row 1 — strict from
   * birth). Renamed from the unpredicated `listJobsByWorkspace` (10 §4.2 rule 1: the old name is deleted so
   * no call site can compile against a workspace-wide read). Control-row columns only (non-PII).
   */
  async listJobs(tx: Tx, viewer: JobViewer, limit = 50): Promise<ImportJobRow[]> {
    const capped = Math.max(1, Math.min(200, Math.trunc(limit)));
    return tx
      .select()
      .from(importJobs)
      .where(
        jobVisibility(viewer, {
          createdByUserId: importJobs.createdByUserId,
          sharedWithWorkspace: importJobs.sharedWithWorkspace,
        }),
      )
      .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
      .limit(capped);
  },

  /** Transition a job's lifecycle status (+ the matching timestamp / staging / chunk-plan fields). Scoped. */
  async updateJobStatus(tx: Tx, jobId: string, patch: ImportJobStatusUpdate): Promise<void> {
    await tx.update(importJobs).set(definedOnly(patch)).where(eq(importJobs.id, jobId));
  },

  /**
   * Add the given deltas to the job's row-accounting counters ATOMICALLY — `rows_created += n` in SQL, never a
   * read-modify-write, so concurrent chunk completions can't clobber each other. No-op deltas are skipped.
   */
  async updateJobProgress(tx: Tx, jobId: string, delta: ImportJobProgressDelta): Promise<void> {
    const set: Record<string, ReturnType<typeof sql>> = {};
    if (delta.rowsTotal) set.rowsTotal = sql`${importJobs.rowsTotal} + ${delta.rowsTotal}`;
    if (delta.rowsCreated) set.rowsCreated = sql`${importJobs.rowsCreated} + ${delta.rowsCreated}`;
    if (delta.rowsMatched) set.rowsMatched = sql`${importJobs.rowsMatched} + ${delta.rowsMatched}`;
    if (delta.rowsDuplicate)
      set.rowsDuplicate = sql`${importJobs.rowsDuplicate} + ${delta.rowsDuplicate}`;
    if (delta.rowsSkipped) set.rowsSkipped = sql`${importJobs.rowsSkipped} + ${delta.rowsSkipped}`;
    if (delta.rowsRejected)
      set.rowsRejected = sql`${importJobs.rowsRejected} + ${delta.rowsRejected}`;
    if (delta.rowsDeduped) set.rowsDeduped = sql`${importJobs.rowsDeduped} + ${delta.rowsDeduped}`;
    if (delta.rowsUnprocessed)
      set.rowsUnprocessed = sql`${importJobs.rowsUnprocessed} + ${delta.rowsUnprocessed}`;
    if (Object.keys(set).length === 0) return;
    await tx.update(importJobs).set(set).where(eq(importJobs.id, jobId));
  },

  /**
   * Atomically mark one more chunk finished and report the new tally — `completed_chunks += 1` in SQL,
   * RETURNING the post-increment `completedChunks` + `totalChunks` so the caller can detect the LAST chunk
   * (`completedChunks === totalChunks`) and run finalize exactly once without a read-modify-write race.
   */
  async incrementCompletedChunks(
    tx: Tx,
    jobId: string,
  ): Promise<{ completedChunks: number; totalChunks: number }> {
    const rows = await tx
      .update(importJobs)
      .set({ completedChunks: sql`${importJobs.completedChunks} + 1` })
      .where(eq(importJobs.id, jobId))
      .returning({
        completedChunks: importJobs.completedChunks,
        totalChunks: importJobs.totalChunks,
      });
    if (!rows[0]) throw new Error("import job not found for completed-chunk increment");
    return rows[0];
  },

  // ── Chunks ─────────────────────────────────────────────────────────────────────────────────────────

  /** Create a chunk (the runner's claimable work band). Returns its id. Workspace-scoped via the parent job. */
  async createChunk(tx: Tx, values: ImportChunkCreateValues): Promise<string> {
    const rows = await tx
      .insert(importJobChunks)
      .values(values)
      .returning({ id: importJobChunks.id });
    return rows[0]!.id;
  },

  /** Sparse chunk patch; `incrementAttempts` bumps `attempts` atomically (retry accounting). */
  async updateChunk(tx: Tx, chunkId: string, patch: ImportChunkUpdate): Promise<void> {
    const set: Record<string, unknown> = definedOnly({
      status: patch.status,
      processedRows: patch.processedRows,
      completedAt: patch.completedAt,
    });
    if (patch.incrementAttempts) set.attempts = sql`${importJobChunks.attempts} + 1`;
    if (Object.keys(set).length === 0) return;
    await tx.update(importJobChunks).set(set).where(eq(importJobChunks.id, chunkId));
  },

  /** All chunks of a job, ascending by index (the runner's claim order). Workspace-scoped via the parent job. */
  async listChunks(tx: Tx, jobId: string): Promise<ImportJobChunkRow[]> {
    return tx
      .select()
      .from(importJobChunks)
      .where(eq(importJobChunks.jobId, jobId))
      .orderBy(asc(importJobChunks.chunkIndex));
  },

  // ── Rows ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Batch-insert the per-row ledger entries for a chunk. One INSERT … VALUES for the whole batch; empty input
   * is a no-op. Each row carries its own `workspaceId` (the RLS WITH CHECK on this high-volume table).
   */
  async insertJobRows(tx: Tx, rows: ImportJobRowInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(importJobRows).values(rows);
  },
};
