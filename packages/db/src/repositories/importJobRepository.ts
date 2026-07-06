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
  ImportJobStatusV2,
  ImportMergeMode,
  JobViewer,
} from "@leadwolf/types";
import { and, asc, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";
import { importJobChunks, importJobRows, importJobs } from "../schema/importJobs.ts";
import { artifactVisibility, jobVisibility } from "./jobVisibility.ts";

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
  /** Widened to the 12-state v2 vocabulary (S-Q2: the commit verb may park a job `deferred`); the legacy
   *  9-state BulkImportJobStatus is a strict subset, so existing callers are unchanged. */
  status?: ImportJobStatusV2;
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
  /** The 08 §5 strategy pair the server resolved for this job (S-I6): request → template → import_policy
   *  default. Persisted so history/detail reflects HOW the job merged; the columns default to the policy-
   *  matching create_and_update / false, so an unset caller is unchanged. */
  mergeMode?: ImportMergeMode;
  preservePopulated?: boolean;
}

/**
 * Lifecycle transition for a job. `status` is required; the rest are sparse. `failedReason` is set only on the
 * `failed` transition. The drive phase sets `stagingTable` + `totalChunks` (+ `byteOffset` resume watermark)
 * on the same `staged` transition, and `avScanStatus` once the AV gate clears — so they ride this same patch.
 */
export interface ImportJobStatusUpdate {
  /** Widened to the 12-state v2 vocabulary (S-Q2 promotes `deferred → queued`); legacy callers unchanged. */
  status: ImportJobStatusV2;
  startedAt?: Date | null;
  completedAt?: Date | null;
  failedReason?: string | null;
  avScanStatus?: AvScanStatus;
  stagingTable?: string | null;
  totalChunks?: number;
  byteOffset?: number;
  /** The server's routing verdict, written by the COMMIT transition (08 §1, S-I8: a draft is created with
   *  the mode UNSET — the server routes once, at commit, from measured facts; the one-shot path still sets
   *  it at create). Optional + additive: every existing caller is unchanged. */
  processingMode?: "fast" | "copy";
  /** NON-PII reject breakdown (stable label → count) — a full SET (not a counter delta), so it rides this
   *  lifecycle patch rather than updateJobProgress. The drive phase writes it once, on the `staged` transition. */
  rejectHistogram?: Record<string, number>;
  /** Object-store key of the REPAIR CSV artifact (08 §6.2, S-I7) — written on the terminal transition when ≥1
   *  row was rejected and a FileStore is composed. The error-report key rides `options.errorReportKey` (only one
   *  key column shipped in S-I1 — 08's predecessor sizing; the pair's second key lives in options). */
  rejectedArtifactKey?: string | null;
  /** Parse/import options jsonb (08 §Contradiction/S-I5). A FULL SET (not a merge) — the caller merges with the
   *  current value before passing it. S-I7 writes `errorReportKey` (the second artifact key) here. */
  options?: Record<string, unknown>;
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

  /**
   * ARTIFACT-GATE read of a job by id (import-redesign 10 §2.1 last row, 13 §4.2, S-V5): the TIGHTEST predicate
   * for the PII-bearing error artifacts — creator ∪ elevated, `shared_with_workspace` IGNORED and the dual-gate
   * short-circuit IGNORED (the artifact endpoint is strict from birth). RLS walls the workspace; artifactVisibility
   * narrows to the creator for non-elevated callers. Invisible/foreign ⇒ null ⇒ the route 404s (no existence
   * oracle). The route runs a member+ role gate before this, so a viewer never reaches it.
   */
  async getJobForArtifact(tx: Tx, viewer: JobViewer, jobId: string): Promise<ImportJobRow | null> {
    const rows = await tx
      .select()
      .from(importJobs)
      .where(
        and(eq(importJobs.id, jobId), artifactVisibility(viewer, importJobs.createdByUserId)),
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

  /** SYSTEM read of a job by id `FOR UPDATE` — the worker's STATUS-MUTATING boundary reads (runFastImport's
   *  claim / validating→running / terminal txs; markFastImportFailed). Locking the row closes the cancel-revive
   *  race (09 §5): the tenant cancel verb (getJobForUpdate, also FOR UPDATE) can no longer interleave a
   *  `cancelled` commit BETWEEN this read and the subsequent unconditional UPDATE — the two verbs serialize on
   *  the row lock, so a cancelled job is re-read as terminal and never overwritten back to running/completed.
   *  No viewer (a worker acts on behalf of the job, not a user — 10 §4.3); RLS workspace isolation unchanged. */
  async getJobSystemForUpdate(tx: Tx, jobId: string): Promise<ImportJobRow | null> {
    const rows = await tx
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, jobId))
      .for("update")
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * List the jobs VISIBLE TO THE VIEWER, most-recent first, KEYSET-paginated on the `idx_import_jobs_ws_created`
   * composite `(workspace_id, created_at DESC, id DESC)` (08 S-I1 / 07 §4.3) — the exact ORDER BY, so the scan
   * is index-ordered with no sort node. Workspace-scoped via RLS AND viewer-scoped via the jobVisibility
   * predicate baked in BEFORE the tenant list route ever exists (10 §5 row 1 — strict from birth). Renamed
   * from the unpredicated `listJobsByWorkspace` (10 §4.2 rule 1: the old name is deleted so no call site can
   * compile against a workspace-wide read). `cursor` pages STRICTLY OLDER than `(createdAt, id)` (opaque at
   * the route). Control-row columns only (non-PII).
   */
  async listJobs(
    tx: Tx,
    viewer: JobViewer,
    opts: {
      limit?: number;
      cursor?: { createdAt: Date; id: string } | null;
      /** 08 §7: DRAFTS (and the dead `uploading` state) are excluded from history by DEFAULT; `"only"` is
       *  the wizard-resume opt-in (`GET /imports?state=draft`) listing a viewer's drafts exclusively. */
      drafts?: "exclude" | "only";
    } = {},
  ): Promise<ImportJobRow[]> {
    const capped = Math.max(1, Math.min(200, Math.trunc(opts.limit ?? 50)));
    const predicate = jobVisibility(viewer, {
      createdByUserId: importJobs.createdByUserId,
      sharedWithWorkspace: importJobs.sharedWithWorkspace,
    });
    const draftTerm =
      opts.drafts === "only"
        ? eq(importJobs.status, "draft")
        : notInArray(importJobs.status, ["draft", "uploading"]);
    // Row-value keyset: `(created_at, id) < (cursor.createdAt, cursor.id)` matches the composite index order
    // exactly. `and(...)` drops the `undefined` visibility term (elevated / gate-off) — never widens scope.
    const keyset = opts.cursor
      ? sql`(${importJobs.createdAt}, ${importJobs.id}) < (${opts.cursor.createdAt}, ${opts.cursor.id})`
      : undefined;
    return tx
      .select()
      .from(importJobs)
      .where(and(predicate, draftTerm, keyset))
      .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
      .limit(capped);
  },

  /**
   * USER-FACING read of a job by id for a STATE-MUTATING verb (the cancel verb, 08 §2.1 / 09 §5): the SAME
   * viewer-predicated read as getJob (creator ∪ elevated; invisible ⇒ null ⇒ 404, no IDOR side-door) but
   * `FOR UPDATE`, so 08 §2.1's legality check runs against the LOCKED row and a concurrent worker transition
   * can never race the verb. Compose inside the same withTenantTx as the transition + its in-tx audit row.
   */
  async getJobForUpdate(tx: Tx, viewer: JobViewer, jobId: string): Promise<ImportJobRow | null> {
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
      .for("update")
      .limit(1);
    return rows[0] ?? null;
  },

  /** Transition a job's lifecycle status (+ the matching timestamp / staging / chunk-plan fields). Scoped. */
  async updateJobStatus(tx: Tx, jobId: string, patch: ImportJobStatusUpdate): Promise<void> {
    await tx.update(importJobs).set(definedOnly(patch)).where(eq(importJobs.id, jobId));
  },

  // ── Draft-flow writes (import-redesign 08 §2.1/§3, S-I8) — every one PINS `status='draft'` in the WHERE
  // so a raced commit/cancel can never be overwritten by a stale wizard call: 0 rows updated ⇒ the caller
  // answers 409 illegal_state against the row's REAL state (the server-side legality rule, 08 §2.1).

  /**
   * Save the draft's mapping document (full replace — PUT semantics, 08 §2.3): the column mapping, the
   * resolved 08 §5 strategy pair, the template provenance, and the optional list target. `undefined`
   * fields are left untouched (definedOnly); pass an explicit `null` to clear a nullable column. Returns
   * false when the row is no longer a draft (or absent) — the caller 409s/404s off its own locked read.
   */
  async updateDraftMapping(
    tx: Tx,
    jobId: string,
    patch: {
      columnMapping?: Record<string, unknown>;
      mergeMode?: ImportMergeMode;
      preservePopulated?: boolean;
      mappingTemplateId?: string | null;
      targetListId?: string | null;
    },
  ): Promise<boolean> {
    const set = definedOnly(patch);
    if (Object.keys(set).length === 0) return true;
    const rows = await tx
      .update(importJobs)
      .set(set)
      .where(and(eq(importJobs.id, jobId), eq(importJobs.status, "draft")))
      .returning({ id: importJobs.id });
    return rows.length > 0;
  },

  /** Cache the NON-PII full-pass projection on the draft row (08 §4 `preview_summary` — counts + codes +
   *  line numbers only; sample rows are recomputed per request and NEVER persisted). Draft-pinned like the
   *  mapping write; a raced commit simply drops the cache write (the projection is re-derivable). */
  async savePreviewSummary(
    tx: Tx,
    jobId: string,
    summary: Record<string, unknown>,
  ): Promise<boolean> {
    const rows = await tx
      .update(importJobs)
      .set({ previewSummary: summary })
      .where(and(eq(importJobs.id, jobId), eq(importJobs.status, "draft")))
      .returning({ id: importJobs.id });
    return rows.length > 0;
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

  // ── Fairness census + deferred promotion (import-redesign 09 §2, S-Q2) ───────────────────────────────

  /** Count a workspace's jobs in the given states — the per-workspace cap census (09 §2.2). The census is
   *  deliberately UNSERIALIZED (soft cap, ±1 under a submit race): the atomic version is the Phase-5
   *  fair-share dispatcher, not an interim lock. Workspace-scoped via RLS + the explicit predicate. */
  async countJobsByStatuses(tx: Tx, workspaceId: string, statuses: string[]): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(importJobs)
      .where(and(eq(importJobs.workspaceId, workspaceId), inArray(importJobs.status, statuses)));
    return rows[0]?.n ?? 0;
  },

  /**
   * Promote up to `limit` of the workspace's `deferred` jobs to `queued`, OLDEST-FIRST (09 §2.2's
   * leader-locked sweep calls this per workspace with its computed headroom). Returns the promoted rows'
   * id + processing_mode so the sweep can re-publish transport for copy drives (fast jobs' transport rides
   * their delayed re-check loop — Phase A). Idempotent: promoting zero rows is a no-op; the WHERE pins
   * `status='deferred'` so a concurrent claim-time promotion never double-flips.
   */
  async promoteDeferredJobs(
    tx: Tx,
    workspaceId: string,
    limit: number,
  ): Promise<Array<{ id: string; processingMode: string | null }>> {
    if (limit <= 0) return [];
    const capped = Math.min(100, Math.trunc(limit));
    return tx
      .update(importJobs)
      .set({ status: "queued" })
      .where(
        and(
          eq(importJobs.status, "deferred"),
          inArray(
            importJobs.id,
            tx
              .select({ id: importJobs.id })
              .from(importJobs)
              .where(
                and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.status, "deferred")),
              )
              .orderBy(asc(importJobs.createdAt), asc(importJobs.id))
              .limit(capped),
          ),
        ),
      )
      .returning({ id: importJobs.id, processingMode: importJobs.processingMode });
  },

  /** Enumerate workspaces holding `deferred` jobs for the promotion sweep — a system-level, non-PII,
   *  OWNER-connection read mirroring retentionScanRepository.listActiveTenants (the sweep fans out per
   *  workspace, then opens one RLS-scoped tx each). Capped by `limit`. */
  async listDeferredWorkspaces(
    limit = 500,
  ): Promise<Array<{ tenantId: string; workspaceId: string }>> {
    const rows = (await db.execute(
      sql`SELECT DISTINCT tenant_id, workspace_id FROM import_jobs WHERE status = 'deferred' LIMIT ${limit}`,
    )) as unknown as Array<{ tenant_id: string; workspace_id: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, workspaceId: r.workspace_id }));
  },

  // ── Reaper reads (import-redesign 09 §7 row 2 / §8, S-Q5) ─────────────────────────────────────────────
  // System-level, non-PII, OWNER-connection reads (mirroring listDeferredWorkspaces / the shipped relays'
  // cross-tenant drain — 13 §5 re-verified: a system drain of control rows, not a new overlay access path).
  // Control-row columns only (no `import_job_rows`, so no imported-contact PII crosses the boundary). The
  // reaper opens an RLS-scoped withTenantTx per row when it must WRITE (markFastImportFailed); these reads
  // only enumerate + count.

  /** Enumerate NON-TERMINAL import jobs (the reaper's recovery + stall candidates), oldest-first, bounded.
   *  `processed` is the 7-bucket accounting sum — the reaper compares it across ticks (no `updated_at` column
   *  exists, so counter-movement IS the running-progress signal — 09 §8). */
  async listNonTerminalImportJobs(limit = 500): Promise<
    Array<{
      id: string;
      tenantId: string;
      workspaceId: string;
      status: string;
      processingMode: string | null;
      createdAt: Date;
      rowsTotal: number;
      processed: number;
    }>
  > {
    const capped = Math.max(1, Math.min(2000, Math.trunc(limit)));
    const rows = (await db.execute(sql`
      SELECT id, tenant_id, workspace_id, status, processing_mode, created_at, rows_total,
             (rows_created + rows_matched + rows_duplicate + rows_skipped + rows_rejected
              + rows_deduped + rows_unprocessed) AS processed
      FROM import_jobs
      WHERE status IN ('queued','validating','staged','running','deferred')
      ORDER BY created_at ASC
      LIMIT ${capped}
    `)) as unknown as Array<{
      id: string;
      tenant_id: string;
      workspace_id: string;
      status: string;
      processing_mode: string | null;
      created_at: Date;
      rows_total: number;
      processed: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      workspaceId: r.workspace_id,
      status: r.status,
      processingMode: r.processing_mode,
      createdAt: new Date(r.created_at),
      rowsTotal: Number(r.rows_total),
      processed: Number(r.processed),
    }));
  },

  /** Count TERMINAL jobs (partial/completed) that have rejected rows but NO artifact key — the artifact
   *  re-sweep flag (09 §7 row 4 / §3 finalize step). A gauge the reaper publishes; >0 = a terminal job whose
   *  repair CSV never landed (a store crash mid-finalize). */
  async countArtifactPendingJobs(): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM import_jobs
      WHERE status IN ('completed','partial') AND rows_rejected > 0 AND rejected_artifact_key IS NULL
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  },

  /** Count TERMINAL jobs whose 7-bucket accounting identity is VIOLATED (sum ≠ rows_total) — the S1 data-
   *  integrity gauge (09 §8: "accounting reconciliation … an unreconciled total is itself a defect"). Only
   *  rows_total>0 are checked (an all-zero job is trivially reconciled). */
  async countAccountingViolations(): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM import_jobs
      WHERE status IN ('completed','partial','failed','cancelled') AND rows_total > 0
        AND (rows_created + rows_matched + rows_duplicate + rows_skipped + rows_rejected
             + rows_deduped + rows_unprocessed) <> rows_total
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  },

  /** S-S7 (13 §4.4) — the artifact-TTL sweep's census: TERMINAL jobs past the cutoff still holding an
   *  artifact key (the repair column and/or `options.errorReportKey`). Owner-connection read, control-row
   *  columns only (keys are opaque non-PII paths); the sweep opens an RLS-scoped tx per row to WRITE
   *  (clearArtifactKeys) — the exact reaper-reads posture above. Oldest-first, bounded. */
  async listArtifactExpiryCandidates(
    cutoff: Date,
    limit = 200,
  ): Promise<
    Array<{
      id: string;
      tenantId: string;
      workspaceId: string;
      rejectedArtifactKey: string | null;
      errorReportKey: string | null;
    }>
  > {
    const capped = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const rows = (await db.execute(sql`
      SELECT id, tenant_id, workspace_id, rejected_artifact_key,
             (options ->> 'errorReportKey') AS error_report_key
      FROM import_jobs
      WHERE status IN ('completed','partial','failed','cancelled')
        AND completed_at IS NOT NULL AND completed_at < ${cutoff}
        AND (rejected_artifact_key IS NOT NULL OR (options ->> 'errorReportKey') IS NOT NULL)
      ORDER BY completed_at ASC
      LIMIT ${capped}
    `)) as unknown as Array<{
      id: string;
      tenant_id: string;
      workspace_id: string;
      rejected_artifact_key: string | null;
      error_report_key: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      workspaceId: r.workspace_id,
      rejectedArtifactKey: r.rejected_artifact_key,
      errorReportKey: r.error_report_key,
    }));
  },

  /** S-S7 key-nulling (13 §4.4): after the objects lapse, null `rejected_artifact_key` and drop
   *  `options.errorReportKey` so the UI shows the honest "expired" state instead of a dead link (the
   *  artifact route already 404s on a null key). Tenant-scoped write (RLS); status untouched. */
  async clearArtifactKeys(tx: Tx, jobId: string): Promise<void> {
    await tx
      .update(importJobs)
      .set({
        rejectedArtifactKey: null,
        // jsonb `-` drops the key; a NULL options stays NULL (NULL - text = NULL).
        options: sql`${importJobs.options} - 'errorReportKey'`,
      })
      .where(eq(importJobs.id, jobId));
  },

  /** S-I8 (08 §2.1 draft exit "reaped") — the draft reaper's census: `draft` rows older than the TTL
   *  cutoff, oldest-first, bounded. Owner-connection read of CONTROL-ROW columns only (id/scope/object
   *  key — the reaper-reads posture above; `source_file` is an opaque store key, non-PII). The reaper
   *  then hard-deletes each row through a draft-pinned tenant tx (deleteDraftJob) — a draft that commits
   *  between census and delete survives untouched. */
  async listReapableDrafts(
    cutoff: Date,
    limit = 200,
  ): Promise<
    Array<{ id: string; tenantId: string; workspaceId: string; sourceFile: string; createdAt: Date }>
  > {
    const capped = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const rows = (await db.execute(sql`
      SELECT id, tenant_id, workspace_id, source_file, created_at
      FROM import_jobs
      WHERE status = 'draft' AND created_at < ${cutoff}
      ORDER BY created_at ASC
      LIMIT ${capped}
    `)) as unknown as Array<{
      id: string;
      tenant_id: string;
      workspace_id: string;
      source_file: string;
      created_at: Date | string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      workspaceId: r.workspace_id,
      sourceFile: r.source_file,
      // Feeds the reaper's `import.draft_reaped` audit facet (non-PII: the draft's age at reap — 08 §2.1).
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    }));
  },

  /** S-I8: hard-delete ONE reaped draft row (08 §2.1 "reaped (sweep; row deleted…)"). PINS `status='draft'`
   *  in the WHERE so a draft that committed/cancelled after the census is NEVER deleted — the reaper skips
   *  its object too when this returns false. Tenant-scoped (compose inside withTenantTx; RLS applies).
   *  Ledger/chunk children cascade by FK (a draft has none — nothing ever ran). */
  async deleteDraftJob(tx: Tx, jobId: string): Promise<boolean> {
    const rows = await tx
      .delete(importJobs)
      .where(and(eq(importJobs.id, jobId), eq(importJobs.status, "draft")))
      .returning({ id: importJobs.id });
    return rows.length > 0;
  },

  /** S-S2 (13 §2.3) — the NO-NEW-'skipped' monitor's census: uploads recorded `av_scan_status='skipped'`
   *  within the look-back window. `retry:%` children are EXCLUDED (they carry no new bytes and INHERIT the
   *  parent's verdict — a retry of a pre-scanner parent is not a scan bypass). Owner-connection count of
   *  control-row columns only (the reaper-reads posture above). Should be 0 whenever a real scanner is
   *  configured — any hit is the G08 gate failing open (S2). */
  async countRecentSkippedAvScans(lookbackMs: number): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM import_jobs
      WHERE av_scan_status = 'skipped'
        AND source_file NOT LIKE 'retry:%'
        AND created_at > now() - (${lookbackMs} * interval '1 millisecond')
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  },

  /** S-S2 (13 §2.3) — `pending`-older-than-SLA half of the monitor: non-terminal jobs whose AV verdict never
   *  arrived (scanner outage holding jobs, or a wiring gap). Owner-connection count, control rows only. */
  async countStalePendingAvScans(olderThanMs: number): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM import_jobs
      WHERE av_scan_status = 'pending'
        AND status NOT IN ('completed','partial','failed','cancelled')
        AND created_at < now() - (${olderThanMs} * interval '1 millisecond')
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  },

  // ── Commit quota + retry-child sourcing (import-redesign 08 §2.3/§6.3, S-I10) ─────────────────────────

  /** Count a workspace's jobs CREATED since `since` — the per-workspace commit-quota census (08 §2.3 / 12 §5;
   *  `IMPORT_MAX_COMMITS_PER_HOUR`). Every commit (incl. a retry-failed child) is one `import_jobs` row, so the
   *  row-creation count is the commit count. DRAFTS (and the dead `uploading` state) are EXCLUDED (S-I8): an
   *  uncommitted draft is not a commit — it consumes quota only once the commit verb flips it (08 §2.3: the
   *  quota is the COMMIT quota; upload has its own rate bucket). Deliberately UNSERIALIZED (soft quota, ±1
   *  under a submit race — the same posture as the fairness census; a committed draft's created_at also
   *  pre-dates its commit, an accepted under-count recorded in doc 16). Workspace-scoped via RLS + predicate. */
  async countJobsCreatedSince(tx: Tx, workspaceId: string, since: Date): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(importJobs)
      .where(
        and(
          eq(importJobs.workspaceId, workspaceId),
          gt(importJobs.createdAt, since),
          notInArray(importJobs.status, ["draft", "uploading"]),
        ),
      );
    return rows[0]?.n ?? 0;
  },

  /**
   * The failed+unprocessed rows of a terminal job, as their RAW parsed input — the Phase-A source of a
   * retry-failed child (08 §6.3). The repair CSV is REGENERATED from these same ledger `input` values
   * (runFastImport), so sourcing the child from the ledger is byte-equivalent to "re-import the repair CSV"
   * WITHOUT needing a FileStore in apps/api (Phase B re-extracts by row_index from the stored object instead).
   * `input` is the raw header-keyed row (core's RawRow); rows without stored `input` are skipped (a wholly-
   * `failed` fast job writes no per-row ledger, so it yields nothing to retry → the route 409s). Ascending by
   * row_index so the child's line order matches the parent's. Workspace-scoped via RLS.
   */
  async listRetryableRows(tx: Tx, jobId: string): Promise<Array<Record<string, string>>> {
    const rows = await tx
      .select({ input: importJobRows.input })
      .from(importJobRows)
      .where(
        and(
          eq(importJobRows.jobId, jobId),
          inArray(importJobRows.outcome, ["rejected", "unprocessed"]),
        ),
      )
      .orderBy(asc(importJobRows.rowIndex));
    const out: Array<Record<string, string>> = [];
    for (const r of rows) {
      const input = r.input as Record<string, string> | null;
      if (input && Object.keys(input).length > 0) out.push(input);
    }
    return out;
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
