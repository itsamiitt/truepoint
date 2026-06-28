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
} from "@leadwolf/types";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { importJobChunks, importJobRows, importJobs } from "../schema/importJobs.ts";

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

  /** Read a job by id (RLS already restricts it to the caller's workspace). Null if not visible. */
  async getJob(tx: Tx, jobId: string): Promise<ImportJobRow | null> {
    const rows = await tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    return rows[0] ?? null;
  },

  /**
   * List the workspace's jobs, most-recent first, capped at `limit` (default 50, max 200). Workspace-scoped
   * via RLS — the `import_jobs_workspace_isolation` policy restricts the SELECT to the caller's workspace, so
   * this can never return another workspace's jobs. Control-row columns only (all non-PII; serializable).
   */
  async listJobsByWorkspace(tx: Tx, limit = 50): Promise<ImportJobRow[]> {
    const capped = Math.max(1, Math.min(200, Math.trunc(limit)));
    return tx
      .select()
      .from(importJobs)
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
