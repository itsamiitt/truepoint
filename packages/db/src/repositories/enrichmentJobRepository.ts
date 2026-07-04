// enrichmentJobRepository.ts — data access for bulk CSV enrichment (Wave 2; 03 §12, ADR bulk-enrich). The
// job lifecycle CRUD over `enrichment_jobs` / `enrichment_job_chunks` / `enrichment_job_rows`, plus the
// overlay-match candidate lookup the core matcher receives by INJECTION. All scoped paths run through
// withTenantTx (RLS workspace isolation; chunks inherit it through their parent job, so every chunk write
// MUST carry a workspaceId scope). Counter writes (updateJobProgress) increment ATOMICALLY in SQL so
// concurrent chunk completions never clobber. String-widened columns like the rest of the package; the
// closed enums (EnrichmentJobStatus / MatchMethod / MatchOutcome) come from @leadwolf/types and narrow at
// the edge. PII never leaves the DB — the candidate lookup returns only non-PII facets + which key matched.

import {
  BULK_ENRICHMENT_DRIVE_TOPIC,
  type EnrichmentJobStatus,
  type JobViewer,
  type MatchMethod,
} from "@leadwolf/types";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { type TenantScope, withTenantTx } from "../client.ts";
import { users } from "../schema/auth.ts";
import { contacts } from "../schema/contacts.ts";
import {
  enrichmentJobChunks,
  enrichmentJobRows,
  enrichmentJobs,
} from "../schema/enrichmentJobs.ts";
import { jobVisibility } from "./jobVisibility.ts";
import { outboxRepository } from "./outboxRepository.ts";

// ── Job lifecycle ──────────────────────────────────────────────────────────────────────────────────────

/** The writable columns the submit path computes for a job. Counters default to 0; status defaults queued. */
export interface JobCreateValues {
  tenantId: string;
  workspaceId: string;
  createdByUserId?: string | null;
  sourceFile: string;
  sourceName: string;
  status?: EnrichmentJobStatus;
  totalRows?: number;
  creditEstimateMicros?: number | null;
  columnMapping?: Record<string, unknown>;
  options?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

/** The control row read by the dashboard/worker status path (all non-PII; safe to serialize). */
export interface JobRecord {
  id: string;
  sourceName: string;
  status: string;
  totalRows: number;
  processedRows: number;
  matchedRows: number;
  enrichedRows: number;
  chargedRows: number;
  creditEstimateMicros: number | null;
  creditSpentMicros: number;
  columnMapping: unknown;
  options: unknown;
  idempotencyKey: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedReason: string | null;
}

/** A viewer-read job row: the control record + creator attribution (import-redesign 10 §2.1). The display
 *  name joins from `users` at read time; null = the user row is gone → the UI renders "Former member". */
export interface JobViewRow extends JobRecord {
  createdByUserId: string | null;
  createdByDisplayName: string | null;
}

/** Lifecycle transition for a job. `failedReason` is set only on the `failed` transition. */
export interface JobStatusUpdate {
  status: EnrichmentJobStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
  failedReason?: string | null;
}

/** Counter deltas applied ATOMICALLY (added to the current value) as a chunk finishes. All optional. */
export interface JobProgressDelta {
  processedRows?: number;
  matchedRows?: number;
  enrichedRows?: number;
  chargedRows?: number;
  creditSpentMicros?: number;
}

// ── Chunks ─────────────────────────────────────────────────────────────────────────────────────────────

/** A unit of work a runner claims (a contiguous row band of a job). */
export interface ChunkCreateValues {
  jobId: string;
  chunkIndex: number;
  rowStart: number;
  rowEnd: number;
  status?: EnrichmentJobStatus;
}

/** Sparse chunk patch (undefined fields are left untouched; `attempts` increments atomically when set). */
export interface ChunkUpdate {
  status?: EnrichmentJobStatus;
  processedRows?: number;
  incrementAttempts?: boolean;
  completedAt?: Date | null;
}

export interface ChunkRecord {
  id: string;
  jobId: string;
  chunkIndex: number;
  rowStart: number;
  rowEnd: number;
  status: string;
  attempts: number;
  processedRows: number;
  createdAt: Date;
  completedAt: Date | null;
}

// ── Rows (high-volume per-input ledger) ──────────────────────────────────────────────────────────────────

/** One per input CSV line — the match/enrich/cost ledger entry. `workspaceId` is denormalized for RLS. */
export interface JobRowInsert {
  jobId: string;
  chunkId: string;
  rowIndex: number;
  workspaceId: string;
  input?: Record<string, unknown>;
  matchMethod?: MatchMethod;
  matchOutcome?: string; // closed set (MatchOutcome); widened so callers may pass the DB default
  matchedContactId?: string | null;
  matchedMasterPersonId?: string | null;
  matchConfidence?: number | null; // 0–1; stored as numeric(5,4)
  enrichedFields?: Record<string, unknown>;
  providerSource?: string | null;
  costMicros?: number;
  charged?: boolean;
  emailStatus?: string; // reuses the contacts email_status set
}

/** A ledger row read back for the result file / outcome rollups (non-PII; serializable). */
export interface JobRowRecord {
  id: string;
  rowIndex: number;
  matchMethod: string;
  matchOutcome: string;
  matchedContactId: string | null;
  matchedMasterPersonId: string | null;
  matchConfidence: number | null;
  enrichedFields: unknown;
  providerSource: string | null;
  costMicros: number;
  charged: boolean;
  emailStatus: string;
}

// ── Overlay match (injected into the core matcher) ───────────────────────────────────────────────────────

/**
 * The deterministic match keys for one input row, in priority order. A hit on the earliest present key wins
 * (email → linkedin → registrable domain). PII (email/phone) is never passed in clear: the email key is its
 * per-workspace HMAC blind index, exactly as `contactRepository.findByDedupKeys` consumes it. Phone has no
 * blind index in the contacts overlay (only encrypted `phone_enc`), so it is not an overlay match key here.
 */
export interface ContactMatchKeys {
  emailBlindIndex?: Uint8Array | null;
  linkedinPublicId?: string | null;
  emailDomain?: string | null;
}

/**
 * A candidate contact the overlay matcher may map to a row, plus WHICH key matched so the caller can map it
 * to a MatchMethod. FACETS ONLY — no encrypted email/phone. `matchConfidence` is the deterministic ceiling
 * for the matched key (1 for the unique identity keys; lower for the weaker domain key), so the matcher can
 * gate on its confidence threshold without re-deriving it.
 */
export interface ContactMatchCandidate {
  contactId: string;
  matchedKey: "email" | "linkedin" | "domain";
  matchMethod: MatchMethod;
  matchConfidence: number;
}

/** Drop undefined keys so an UPDATE never overwrites an existing value with `undefined`. */
function definedOnly<T extends object>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined)) as Partial<T>;
}

/** The JobRecord select shape (the control-row, non-PII status columns) — shared by the viewer reads and
 *  the system read so the three can never drift. */
const JOB_STATUS_COLS = {
  id: enrichmentJobs.id,
  sourceName: enrichmentJobs.sourceName,
  status: enrichmentJobs.status,
  totalRows: enrichmentJobs.totalRows,
  processedRows: enrichmentJobs.processedRows,
  matchedRows: enrichmentJobs.matchedRows,
  enrichedRows: enrichmentJobs.enrichedRows,
  chargedRows: enrichmentJobs.chargedRows,
  creditEstimateMicros: enrichmentJobs.creditEstimateMicros,
  creditSpentMicros: enrichmentJobs.creditSpentMicros,
  columnMapping: enrichmentJobs.columnMapping,
  options: enrichmentJobs.options,
  idempotencyKey: enrichmentJobs.idempotencyKey,
  createdAt: enrichmentJobs.createdAt,
  startedAt: enrichmentJobs.startedAt,
  completedAt: enrichmentJobs.completedAt,
  failedReason: enrichmentJobs.failedReason,
};

export const enrichmentJobRepository = {
  // ── Jobs ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Create a job. Idempotency is OPT-IN via `idempotencyKey` (the schema's unique index is partial —
   * `WHERE idempotency_key IS NOT NULL`): a re-submit carrying the same key collapses onto the existing job
   * (returns its id, `created: false`) — never a duplicate. With no key, every call creates a fresh job
   * (`created: true`). Workspace-scoped via RLS.
   */
  async createJob(
    scope: TenantScope,
    values: JobCreateValues,
  ): Promise<{ id: string; created: boolean }> {
    return withTenantTx(scope, async (tx) => {
      const insert = tx.insert(enrichmentJobs).values(values);
      const rows = values.idempotencyKey
        ? await insert
            .onConflictDoNothing({
              target: [enrichmentJobs.workspaceId, enrichmentJobs.idempotencyKey],
            })
            .returning({ id: enrichmentJobs.id })
        : await insert.returning({ id: enrichmentJobs.id });
      if (rows[0]) return { id: rows[0].id, created: true };
      // The (workspace_id, idempotency_key) unique index collapsed the insert — fetch the job the key
      // already points at. Predicate is explicit on BOTH index columns (not RLS-only) so the lookup is
      // self-contained and can never resolve a foreign workspace's job that happens to share the key.
      const existing = await tx
        .select({ id: enrichmentJobs.id })
        .from(enrichmentJobs)
        .where(
          and(
            eq(enrichmentJobs.workspaceId, values.workspaceId),
            eq(enrichmentJobs.idempotencyKey, values.idempotencyKey as string),
          ),
        )
        .limit(1);
      if (!existing[0]) throw new Error("enrichment job vanished after idempotent conflict");
      return { id: existing[0].id, created: false };
    });
  },

  /**
   * List the jobs VISIBLE TO THE VIEWER, most-recent first, capped at `limit` (default 50). Workspace-scoped
   * via RLS (the `enrichment_jobs_workspace_isolation` policy) AND viewer-scoped via the jobVisibility
   * predicate (import-redesign 10 §2.1): members see their own + shared rows; elevated roles see all with
   * creator attribution; dual gate off ⇒ workspace-wide, byte-identical (T-V4). Renamed from the
   * unpredicated `listJobsByWorkspace` (10 §4.2 rule 1 — the old name is deleted so omission is a compile
   * error). The control-row columns only (all non-PII; serializable) — the customer status surface (G-ENR-4)
   * reads these, never the high-volume per-row ledger. Read-only.
   */
  async listJobs(scope: TenantScope, viewer: JobViewer, limit = 50): Promise<JobViewRow[]> {
    const capped = Math.max(1, Math.min(200, Math.trunc(limit)));
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          ...JOB_STATUS_COLS,
          createdByUserId: enrichmentJobs.createdByUserId,
          createdByDisplayName: sql<
            string | null
          >`coalesce(${users.fullName}, ${users.email}::text)`,
        })
        .from(enrichmentJobs)
        .leftJoin(users, eq(users.id, enrichmentJobs.createdByUserId))
        .where(
          jobVisibility(viewer, {
            createdByUserId: enrichmentJobs.createdByUserId,
            sharedWithWorkspace: enrichmentJobs.sharedWithWorkspace,
          }),
        )
        .orderBy(desc(enrichmentJobs.createdAt), desc(enrichmentJobs.id))
        .limit(capped),
    );
  },

  /**
   * USER-FACING read of one job by id — the SAME predicate as the list (10 §4.2 rule 2), so a leaked or
   * guessed id is no IDOR side-door: invisible (foreign-user or absent) ⇒ null ⇒ the route 404s without
   * revealing existence. Worker/system paths use getJobSystem (10 §4.3).
   */
  async getJob(scope: TenantScope, viewer: JobViewer, jobId: string): Promise<JobViewRow | null> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          ...JOB_STATUS_COLS,
          createdByUserId: enrichmentJobs.createdByUserId,
          createdByDisplayName: sql<
            string | null
          >`coalesce(${users.fullName}, ${users.email}::text)`,
        })
        .from(enrichmentJobs)
        .leftJoin(users, eq(users.id, enrichmentJobs.createdByUserId))
        .where(
          and(
            eq(enrichmentJobs.id, jobId),
            jobVisibility(viewer, {
              createdByUserId: enrichmentJobs.createdByUserId,
              sharedWithWorkspace: enrichmentJobs.sharedWithWorkspace,
            }),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    });
  },

  /** SYSTEM read of a job by id — worker paths only (chunk runners, the drive, the confirm gate): no viewer,
   *  RLS workspace isolation unchanged. Never call from a user-facing route (10 §4.3). */
  async getJobSystem(scope: TenantScope, jobId: string): Promise<JobRecord | null> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select(JOB_STATUS_COLS)
        .from(enrichmentJobs)
        .where(eq(enrichmentJobs.id, jobId))
        .limit(1);
      return rows[0] ?? null;
    });
  },

  /** Transition a job's lifecycle status (and the matching timestamp / failure reason). Workspace-scoped. */
  async updateJobStatus(scope: TenantScope, jobId: string, patch: JobStatusUpdate): Promise<void> {
    return withTenantTx(scope, async (tx) => {
      await tx.update(enrichmentJobs).set(definedOnly(patch)).where(eq(enrichmentJobs.id, jobId));
    });
  },

  /**
   * Add the given deltas to the job's progress counters ATOMICALLY — `processed += n` in SQL, never a
   * read-modify-write, so concurrent chunk completions can't clobber each other. No-op deltas are skipped.
   */
  async updateJobProgress(
    scope: TenantScope,
    jobId: string,
    delta: JobProgressDelta,
  ): Promise<void> {
    const set: Record<string, ReturnType<typeof sql>> = {};
    if (delta.processedRows)
      set.processedRows = sql`${enrichmentJobs.processedRows} + ${delta.processedRows}`;
    if (delta.matchedRows)
      set.matchedRows = sql`${enrichmentJobs.matchedRows} + ${delta.matchedRows}`;
    if (delta.enrichedRows)
      set.enrichedRows = sql`${enrichmentJobs.enrichedRows} + ${delta.enrichedRows}`;
    if (delta.chargedRows)
      set.chargedRows = sql`${enrichmentJobs.chargedRows} + ${delta.chargedRows}`;
    if (delta.creditSpentMicros)
      set.creditSpentMicros = sql`${enrichmentJobs.creditSpentMicros} + ${delta.creditSpentMicros}`;
    if (Object.keys(set).length === 0) return;
    return withTenantTx(scope, async (tx) => {
      await tx.update(enrichmentJobs).set(set).where(eq(enrichmentJobs.id, jobId));
    });
  },

  // ── Spend gate (confirm-before-spend) ────────────────────────────────────────────────────────────────
  // The bulk-enrich money path (prospect-database-platform I3 / audit A3/P08) is GUARDED by two one-way status
  // transitions. Unlike updateJobStatus (which sets whatever patch it is given), these pin the CURRENT status in
  // the WHERE clause, so a job can only advance along estimating → awaiting_confirmation → running. There is NO
  // path from queued/estimating straight to running: no bulk run can ever start (and therefore spend) without a
  // human first confirming the persisted worst-case ceiling. Both are workspace-scoped via RLS (withTenantTx).

  /**
   * Persist the WORST-CASE credit CEILING and ARM the confirm gate. GUARDED transition
   * `estimating → awaiting_confirmation`: the WHERE pins `estimating`, so a job can only be armed straight off
   * estimation — never re-armed from running/completed, never skipping the estimate. `creditEstimateMicros` is the
   * ceiling (`worstCaseBulkEnrichMicros`, core) the human confirms and the per-run cap later enforces; it is
   * truncated to a non-negative integer. Returns true iff a row transitioned (0 rows ⇒ the job was not in
   * `estimating`; the caller reports a conflict rather than silently arming nothing).
   */
  async setEstimateAwaitingConfirmation(
    scope: TenantScope,
    jobId: string,
    creditEstimateMicros: number,
  ): Promise<boolean> {
    const ceiling = Math.max(0, Math.trunc(creditEstimateMicros));
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .update(enrichmentJobs)
        .set({ creditEstimateMicros: ceiling, status: "awaiting_confirmation" })
        .where(and(eq(enrichmentJobs.id, jobId), eq(enrichmentJobs.status, "estimating")))
        .returning({ id: enrichmentJobs.id });
      return rows.length > 0;
    });
  },

  /**
   * The HUMAN confirm — the only door to a spending run. GUARDED transition `awaiting_confirmation → running`,
   * stamping `started_at`. The WHERE pins `awaiting_confirmation`, so a run can ONLY begin after the ceiling was
   * shown and confirmed; a job that never armed the gate can never reach `running` through this method. Idempotent
   * and race-safe: a duplicate/concurrent confirm finds no `awaiting_confirmation` row and returns false (only one
   * caller wins the transition). Returns true iff THIS call promoted the job to `running`.
   */
  async confirmAwaitingJob(scope: TenantScope, jobId: string): Promise<boolean> {
    // Workspace-scoped table: without a workspace GUC the RLS-isolated UPDATE below can never match, so an
    // unscoped call is a guaranteed no-win — return early (and give TS the non-null workspaceId it needs).
    const workspaceId = scope.workspaceId;
    if (!workspaceId) return false;
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .update(enrichmentJobs)
        .set({ status: "running", startedAt: sql`now()` })
        .where(
          and(eq(enrichmentJobs.id, jobId), eq(enrichmentJobs.status, "awaiting_confirmation")),
        )
        .returning({ id: enrichmentJobs.id });
      if (rows.length === 0) return false;
      // ADR-0027 TRANSACTIONAL OUTBOX (worker-platform Phase 3): the drive-publish intent commits ATOMICALLY
      // with the awaiting_confirmation → running transition — "DB commit ⇒ event published". The old shape
      // (commit here, then the HTTP handler enqueues to Redis) could crash between the two and strand a
      // `running` job with NO drive job — not self-healing (02-root-cause-analysis §6). The workers-side
      // relay (leaderless, SKIP LOCKED, continuous) publishes this at-least-once; the consumer dedupes by
      // stable jobId. The payload is the SAME PII-free queue DTO the producer used to enqueue directly.
      await outboxRepository.enqueueInTx(tx, {
        tenantId: scope.tenantId,
        workspaceId,
        topic: BULK_ENRICHMENT_DRIVE_TOPIC,
        payload: {
          kind: "drive",
          jobId,
          scope: { tenantId: scope.tenantId, workspaceId },
        },
      });
      return true;
    });
  },

  /**
   * Atomically add `deltaMicros` to the run's `credit_spent_micros` and RETURN the new total. This is the primitive
   * the bulk-enrich worker's PER-RUN CAP is enforced on: after each paid contact the worker adds the cost here and
   * reads back the LIVE run total (including sibling chunks' concurrent spend), so it can stop the run the moment
   * the confirmed ceiling would be exceeded. `SET x = x + delta` is a single atomic UPDATE — never a
   * read-modify-write — so concurrent chunk workers can't clobber the tally. Non-positive deltas are a pure read.
   */
  async addRunSpendReturningTotal(
    scope: TenantScope,
    jobId: string,
    deltaMicros: number,
  ): Promise<number> {
    const delta = Math.max(0, Math.trunc(deltaMicros));
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .update(enrichmentJobs)
        .set({ creditSpentMicros: sql`${enrichmentJobs.creditSpentMicros} + ${delta}` })
        .where(eq(enrichmentJobs.id, jobId))
        .returning({ total: enrichmentJobs.creditSpentMicros });
      return rows[0]?.total ?? 0;
    });
  },

  // ── Chunks ─────────────────────────────────────────────────────────────────────────────────────────

  /** Create a chunk (the runner's claimable work band). Returns its id. Workspace-scoped via the parent job. */
  async createChunk(scope: TenantScope, values: ChunkCreateValues): Promise<string> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .insert(enrichmentJobChunks)
        .values(values)
        .returning({ id: enrichmentJobChunks.id });
      return rows[0]!.id;
    });
  },

  /**
   * Batch-create every chunk band of a job in ONE tx (one INSERT … VALUES) — ATOMIC, so a crashed-then-re-driven
   * job never sees a PARTIAL chunk set (which the resume path would mistake for "already planned" and skip the
   * missing bands). Returns the new chunk ids; empty input is a no-op. Mirrors insertJobRows' batch shape.
   * Workspace-scoped via RLS through the parent job.
   */
  async createChunks(scope: TenantScope, values: ChunkCreateValues[]): Promise<string[]> {
    if (values.length === 0) return [];
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .insert(enrichmentJobChunks)
        .values(values)
        .returning({ id: enrichmentJobChunks.id });
      return rows.map((r) => r.id);
    });
  },

  /** Read ONE chunk by id (the band a worker was handed). Null when not visible (RLS) or absent. */
  async getChunk(scope: TenantScope, chunkId: string): Promise<ChunkRecord | null> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          id: enrichmentJobChunks.id,
          jobId: enrichmentJobChunks.jobId,
          chunkIndex: enrichmentJobChunks.chunkIndex,
          rowStart: enrichmentJobChunks.rowStart,
          rowEnd: enrichmentJobChunks.rowEnd,
          status: enrichmentJobChunks.status,
          attempts: enrichmentJobChunks.attempts,
          processedRows: enrichmentJobChunks.processedRows,
          createdAt: enrichmentJobChunks.createdAt,
          completedAt: enrichmentJobChunks.completedAt,
        })
        .from(enrichmentJobChunks)
        .where(eq(enrichmentJobChunks.id, chunkId))
        .limit(1);
      return rows[0] ?? null;
    });
  },

  /** Sparse chunk patch; `incrementAttempts` bumps `attempts` atomically (retry accounting). */
  async updateChunk(scope: TenantScope, chunkId: string, patch: ChunkUpdate): Promise<void> {
    const set: Record<string, unknown> = definedOnly({
      status: patch.status,
      processedRows: patch.processedRows,
      completedAt: patch.completedAt,
    });
    if (patch.incrementAttempts) set.attempts = sql`${enrichmentJobChunks.attempts} + 1`;
    if (Object.keys(set).length === 0) return;
    return withTenantTx(scope, async (tx) => {
      await tx.update(enrichmentJobChunks).set(set).where(eq(enrichmentJobChunks.id, chunkId));
    });
  },

  /** All chunks of a job, ascending by index (the runner's claim order). Workspace-scoped via the parent job. */
  async listChunks(scope: TenantScope, jobId: string): Promise<ChunkRecord[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: enrichmentJobChunks.id,
          jobId: enrichmentJobChunks.jobId,
          chunkIndex: enrichmentJobChunks.chunkIndex,
          rowStart: enrichmentJobChunks.rowStart,
          rowEnd: enrichmentJobChunks.rowEnd,
          status: enrichmentJobChunks.status,
          attempts: enrichmentJobChunks.attempts,
          processedRows: enrichmentJobChunks.processedRows,
          createdAt: enrichmentJobChunks.createdAt,
          completedAt: enrichmentJobChunks.completedAt,
        })
        .from(enrichmentJobChunks)
        .where(eq(enrichmentJobChunks.jobId, jobId))
        .orderBy(asc(enrichmentJobChunks.chunkIndex)),
    );
  },

  // ── Rows ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Batch-insert the per-row ledger entries for a chunk. One INSERT … VALUES for the whole batch; empty
   * input is a no-op. Each row carries its own `workspaceId` (the RLS WITH CHECK on this high-volume table).
   */
  async insertJobRows(scope: TenantScope, rows: JobRowInsert[]): Promise<void> {
    if (rows.length === 0) return;
    // numeric(5,4) takes a string on write; map the 0–1 confidence number to its decimal string (null stays).
    const values = rows.map(({ matchConfidence, ...rest }) => ({
      ...rest,
      matchConfidence: matchConfidence == null ? matchConfidence : String(matchConfidence),
    }));
    return withTenantTx(scope, async (tx) => {
      await tx.insert(enrichmentJobRows).values(values);
    });
  },

  /** All ledger rows of a job with the given outcome, ascending by row index (drives the result file). */
  async getJobRowsByOutcome(
    scope: TenantScope,
    jobId: string,
    outcome: string,
  ): Promise<JobRowRecord[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          id: enrichmentJobRows.id,
          rowIndex: enrichmentJobRows.rowIndex,
          matchMethod: enrichmentJobRows.matchMethod,
          matchOutcome: enrichmentJobRows.matchOutcome,
          matchedContactId: enrichmentJobRows.matchedContactId,
          matchedMasterPersonId: enrichmentJobRows.matchedMasterPersonId,
          matchConfidence: enrichmentJobRows.matchConfidence,
          enrichedFields: enrichmentJobRows.enrichedFields,
          providerSource: enrichmentJobRows.providerSource,
          costMicros: enrichmentJobRows.costMicros,
          charged: enrichmentJobRows.charged,
          emailStatus: enrichmentJobRows.emailStatus,
        })
        .from(enrichmentJobRows)
        .where(and(eq(enrichmentJobRows.jobId, jobId), eq(enrichmentJobRows.matchOutcome, outcome)))
        .orderBy(asc(enrichmentJobRows.rowIndex));
      // numeric(5,4) reads back as a string; widen to number (null stays null) for serializable output.
      return rows.map((r) => ({
        ...r,
        matchConfidence: r.matchConfidence == null ? null : Number(r.matchConfidence),
      }));
    });
  },

  // ── Overlay match (injected into the core matcher) ───────────────────────────────────────────────────

  /**
   * Find the existing overlay `contacts` candidate for one input row by the deterministic match keys, in
   * priority order: email blind index → linkedin_public_id → registrable email domain. Returns the FIRST
   * key that hits with the matched contact id, which key matched, the mapped MatchMethod, and the
   * deterministic confidence ceiling for that key — so the injected core matcher can gate on its threshold
   * and write the row's `match_method`. Workspace-scoped via RLS (and the explicit workspace predicate,
   * mirroring `contactRepository.findByDedupKeys`). Null when no key matches. PII never leaves the DB: the
   * email key is its HMAC blind index, and only the contact id + facets are returned.
   */
  async findContactCandidatesByMatchKeys(
    scope: TenantScope,
    keys: ContactMatchKeys,
  ): Promise<ContactMatchCandidate | null> {
    if (!scope.workspaceId)
      throw new Error("findContactCandidatesByMatchKeys requires a workspaceId scope");
    const workspaceId = scope.workspaceId;
    return withTenantTx(scope, async (tx) => {
      if (keys.emailBlindIndex) {
        const r = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, workspaceId),
              eq(contacts.emailBlindIndex, keys.emailBlindIndex),
            ),
          )
          .limit(1);
        if (r[0])
          return {
            contactId: r[0].id,
            matchedKey: "email",
            matchMethod: "deterministic_email",
            matchConfidence: 1,
          };
      }
      if (keys.linkedinPublicId) {
        const r = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, workspaceId),
              eq(contacts.linkedinPublicId, keys.linkedinPublicId),
            ),
          )
          .limit(1);
        if (r[0])
          return {
            contactId: r[0].id,
            matchedKey: "linkedin",
            matchMethod: "deterministic_linkedin",
            matchConfidence: 1,
          };
      }
      if (keys.emailDomain) {
        // Domain is the weakest deterministic key (many contacts share a company domain) — return the
        // newest candidate and a sub-1 confidence so the matcher can require corroboration / a threshold.
        // The id tiebreak keeps the pick deterministic when same-domain contacts share a created_at
        // (common: one bulk import inserts many same-domain rows in a single statement).
        const r = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(eq(contacts.workspaceId, workspaceId), eq(contacts.emailDomain, keys.emailDomain)),
          )
          .orderBy(desc(contacts.createdAt), desc(contacts.id))
          .limit(1);
        if (r[0])
          return {
            contactId: r[0].id,
            matchedKey: "domain",
            matchMethod: "deterministic_domain",
            matchConfidence: 0.5,
          };
      }
      return null;
    });
  },
};
