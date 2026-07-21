// revealJobRepository.ts — data access for the async bulk-reveal job (reveal-experience Phase 3). Mirrors
// enrichmentJobRepository: idempotent create, ATOMIC counter increments (never read-modify-write), and the
// status-pinned one-way confirm transition (awaiting_confirmation → running) that guarantees no run can spend
// without a human confirm. Workspace-scoped via RLS (withTenantTx). Per-contact work + outcome live in
// reveal_job_rows — a row starts `queued` and a chunk drives it to a terminal outcome, so resume/retry-failed
// is just "rows that aren't terminal / are failed".

import type { JobViewer } from "@leadwolf/types";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { type TenantScope, withTenantTx } from "../client.ts";
import { users } from "../schema/auth.ts";
import { revealJobRows, revealJobs } from "../schema/revealJobs.ts";
import { creditRepository } from "./creditRepository.ts";
import { jobVisibility } from "./jobVisibility.ts";

type WsScope = TenantScope & { workspaceId: string };

/** Private sentinel: thrown to roll back a confirm tx when the lease can't cover the ceiling (caught + mapped
 *  to an `insufficient` result — the repo never leaks a typed HTTP error). */
class InsufficientLeaseError extends Error {
  constructor(
    readonly balance: number,
    readonly required: number,
  ) {
    super("insufficient_credits_for_lease");
  }
}

/** The outcome of confirmAndLease. */
export type ConfirmRevealJobResult =
  | { result: "confirmed" }
  | { result: "not_awaiting" }
  | { result: "insufficient"; balance: number; required: number };

export interface RevealJobCreateValues {
  tenantId: string;
  workspaceId: string;
  createdByUserId: string | null;
  revealType: string;
  totalContacts: number;
  creditEstimate: number;
  idempotencyKey?: string | null;
}

export interface RevealJobRecord {
  id: string;
  createdByUserId: string | null;
  revealType: string;
  status: string;
  totalContacts: number;
  processedContacts: number;
  revealedContacts: number;
  alreadyOwnedContacts: number;
  suppressedContacts: number;
  failedContacts: number;
  creditEstimate: number;
  creditLeased: number;
  creditSpent: number;
  resultKey: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedReason: string | null;
}

export interface RevealJobStatusUpdate {
  status?: string;
  startedAt?: Date;
  completedAt?: Date;
  failedReason?: string | null;
  resultKey?: string | null;
  creditLeased?: number;
}

export interface RevealJobProgressDelta {
  processedContacts?: number;
  revealedContacts?: number;
  alreadyOwnedContacts?: number;
  suppressedContacts?: number;
  failedContacts?: number;
  creditSpent?: number;
}

export interface RevealBandRow {
  id: string;
  contactId: string | null;
  rowIndex: number;
}

/** A viewer-read job row: the control record + creator attribution (import-redesign 10 §2.1 — the display
 *  name joins from `users` at read time; null = the user row is gone → the UI renders "Former member"). */
export interface RevealJobViewRow extends RevealJobRecord {
  createdByDisplayName: string | null;
}

const JOB_COLS = {
  id: revealJobs.id,
  createdByUserId: revealJobs.createdByUserId,
  revealType: revealJobs.revealType,
  status: revealJobs.status,
  totalContacts: revealJobs.totalContacts,
  processedContacts: revealJobs.processedContacts,
  revealedContacts: revealJobs.revealedContacts,
  alreadyOwnedContacts: revealJobs.alreadyOwnedContacts,
  suppressedContacts: revealJobs.suppressedContacts,
  failedContacts: revealJobs.failedContacts,
  creditEstimate: revealJobs.creditEstimate,
  creditLeased: revealJobs.creditLeased,
  creditSpent: revealJobs.creditSpent,
  // creditLeasedFromSub is internal accounting (not in the customer DTO) — read directly where needed.
  resultKey: revealJobs.resultKey,
  createdAt: revealJobs.createdAt,
  startedAt: revealJobs.startedAt,
  completedAt: revealJobs.completedAt,
  failedReason: revealJobs.failedReason,
};

function definedOnly<T extends object>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export const revealJobRepository = {
  /** Create the control row (idempotent on (workspace, idempotency_key) when a key is given). Starts in
   *  `awaiting_confirmation` — the estimate is computed synchronously at create, so the confirm gate is armed. */
  async createJob(
    scope: TenantScope,
    values: RevealJobCreateValues,
  ): Promise<{ id: string; created: boolean }> {
    return withTenantTx(scope, async (tx) => {
      const insert = tx.insert(revealJobs).values({ ...values, status: "awaiting_confirmation" });
      const rows = values.idempotencyKey
        ? await insert
            .onConflictDoNothing({ target: [revealJobs.workspaceId, revealJobs.idempotencyKey] })
            .returning({ id: revealJobs.id })
        : await insert.returning({ id: revealJobs.id });
      if (rows[0]) return { id: rows[0].id, created: true };
      const existing = await tx
        .select({ id: revealJobs.id })
        .from(revealJobs)
        .where(
          and(
            eq(revealJobs.workspaceId, values.workspaceId),
            eq(revealJobs.idempotencyKey, values.idempotencyKey as string),
          ),
        )
        .limit(1);
      if (!existing[0]) throw new Error("reveal job vanished after idempotent conflict");
      return { id: existing[0].id, created: false };
    });
  },

  /** Batch-insert the per-contact work rows (queued). Idempotent on (job, contact) — a re-run skips dupes. */
  async insertRows(
    scope: WsScope,
    jobId: string,
    rows: Array<{ contactId: string; rowIndex: number }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    return withTenantTx(scope, async (tx) => {
      await tx
        .insert(revealJobRows)
        .values(
          rows.map((r) => ({
            jobId,
            workspaceId: scope.workspaceId,
            contactId: r.contactId,
            rowIndex: r.rowIndex,
            outcome: "queued",
          })),
        )
        .onConflictDoNothing();
    });
  },

  /**
   * List the jobs VISIBLE TO THE VIEWER, most-recent first (import-redesign 10 §2.1): members see their own
   * + shared rows; elevated roles see all with creator attribution; while the dual gate is off the predicate
   * short-circuits to workspace-wide (byte-identical shipped behavior, T-V4). Renamed from the unpredicated
   * `listJobsByWorkspace` (10 §4.2 rule 1 — the old name is deleted so omission is a compile error).
   * RLS keeps guaranteeing the workspace wall underneath either way.
   */
  async listJobs(scope: TenantScope, viewer: JobViewer, limit = 50): Promise<RevealJobViewRow[]> {
    const capped = Math.max(1, Math.min(200, Math.trunc(limit)));
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          ...JOB_COLS,
          createdByDisplayName: sql<
            string | null
          >`coalesce(${users.fullName}, ${users.email}::text)`,
        })
        .from(revealJobs)
        .leftJoin(users, eq(users.id, revealJobs.createdByUserId))
        .where(
          jobVisibility(viewer, {
            createdByUserId: revealJobs.createdByUserId,
            sharedWithWorkspace: revealJobs.sharedWithWorkspace,
          }),
        )
        .orderBy(desc(revealJobs.createdAt), desc(revealJobs.id))
        .limit(capped),
    );
  },

  /**
   * USER-FACING read of one job by id — the SAME predicate as the list (10 §4.2 rule 2), so a leaked or
   * guessed id is no IDOR side-door: invisible (foreign-user or absent) ⇒ null ⇒ the route 404s without
   * revealing existence. Worker/system paths use getJobSystem (10 §4.3).
   */
  async getJob(
    scope: TenantScope,
    viewer: JobViewer,
    jobId: string,
  ): Promise<RevealJobViewRow | null> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          ...JOB_COLS,
          createdByDisplayName: sql<
            string | null
          >`coalesce(${users.fullName}, ${users.email}::text)`,
        })
        .from(revealJobs)
        .leftJoin(users, eq(users.id, revealJobs.createdByUserId))
        .where(
          and(
            eq(revealJobs.id, jobId),
            jobVisibility(viewer, {
              createdByUserId: revealJobs.createdByUserId,
              sharedWithWorkspace: revealJobs.sharedWithWorkspace,
            }),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    });
  },

  /** SYSTEM read of a job by id — worker paths only (the drive/finalize loop): no viewer, RLS workspace
   *  isolation unchanged. Never call from a user-facing route (10 §4.3). */
  async getJobSystem(scope: TenantScope, jobId: string): Promise<RevealJobRecord | null> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select(JOB_COLS)
        .from(revealJobs)
        .where(eq(revealJobs.id, jobId))
        .limit(1);
      return rows[0] ?? null;
    });
  },

  async updateJobStatus(
    scope: TenantScope,
    jobId: string,
    patch: RevealJobStatusUpdate,
  ): Promise<void> {
    return withTenantTx(scope, async (tx) => {
      await tx.update(revealJobs).set(definedOnly(patch)).where(eq(revealJobs.id, jobId));
    });
  },

  /** Add deltas to the progress counters ATOMICALLY (`x = x + n` in SQL). No-op deltas skipped. */
  async updateJobProgress(
    scope: TenantScope,
    jobId: string,
    delta: RevealJobProgressDelta,
  ): Promise<void> {
    const set: Record<string, ReturnType<typeof sql>> = {};
    if (delta.processedContacts)
      set.processedContacts = sql`${revealJobs.processedContacts} + ${delta.processedContacts}`;
    if (delta.revealedContacts)
      set.revealedContacts = sql`${revealJobs.revealedContacts} + ${delta.revealedContacts}`;
    if (delta.alreadyOwnedContacts)
      set.alreadyOwnedContacts = sql`${revealJobs.alreadyOwnedContacts} + ${delta.alreadyOwnedContacts}`;
    if (delta.suppressedContacts)
      set.suppressedContacts = sql`${revealJobs.suppressedContacts} + ${delta.suppressedContacts}`;
    if (delta.failedContacts)
      set.failedContacts = sql`${revealJobs.failedContacts} + ${delta.failedContacts}`;
    if (delta.creditSpent) set.creditSpent = sql`${revealJobs.creditSpent} + ${delta.creditSpent}`;
    if (Object.keys(set).length === 0) return;
    return withTenantTx(scope, async (tx) => {
      await tx.update(revealJobs).set(set).where(eq(revealJobs.id, jobId));
    });
  },

  /**
   * The confirm gate — ONE atomic tx: GUARDED `awaiting_confirmation → running` (the WHERE pins the status, so
   * only one caller wins) THEN lease the worst-case ceiling (ADR-0029). Order matters: the status transition
   * takes the job-row lock first, so a duplicate/concurrent confirm finds no `awaiting_confirmation` row and
   * never leases twice. If the balance can't cover the ceiling the whole tx rolls back (status stays
   * `awaiting_confirmation`, nothing charged) and we report `insufficient`. `not_awaiting` = the job wasn't
   * armed (already running/confirmed/cancelled).
   */
  async confirmAndLease(
    scope: WsScope,
    jobId: string,
    actorUserId: string | null,
  ): Promise<ConfirmRevealJobResult> {
    try {
      return await withTenantTx(scope, async (tx): Promise<ConfirmRevealJobResult> => {
        const won = (
          await tx
            .update(revealJobs)
            .set({ status: "running", startedAt: sql`now()` })
            .where(and(eq(revealJobs.id, jobId), eq(revealJobs.status, "awaiting_confirmation")))
            .returning({ ceiling: revealJobs.creditEstimate })
        ).at(0);
        if (!won) return { result: "not_awaiting" };
        const lease = await creditRepository.leaseForJob(tx, {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          jobId,
          ceiling: won.ceiling,
          actorUserId,
        });
        if (!lease.ok) throw new InsufficientLeaseError(lease.balance, won.ceiling);
        await tx
          .update(revealJobs)
          .set({ creditLeased: won.ceiling, creditLeasedFromSub: lease.leasedFromSubscription })
          .where(eq(revealJobs.id, jobId));
        return { result: "confirmed" };
      });
    } catch (e) {
      if (e instanceof InsufficientLeaseError)
        return { result: "insufficient", balance: e.balance, required: e.required };
      throw e;
    }
  },

  /**
   * Finalize — ONE atomic tx: GUARDED `running → completed` (stamps completed_at + result_key) THEN release the
   * unspent lease remainder. The status pin makes this exactly-once: a redelivered/late chunk finds the job no
   * longer `running` and does NOT double-release. Returns true iff THIS call finalized.
   */
  async finalizeAndRelease(
    scope: WsScope,
    jobId: string,
    resultKey: string | null,
    actorUserId: string | null,
  ): Promise<boolean> {
    return withTenantTx(scope, async (tx) => {
      const won = (
        await tx
          .update(revealJobs)
          .set({ status: "completed", completedAt: sql`now()`, resultKey })
          .where(and(eq(revealJobs.id, jobId), eq(revealJobs.status, "running")))
          .returning({
            leased: revealJobs.creditLeased,
            leasedFromSub: revealJobs.creditLeasedFromSub,
            spent: revealJobs.creditSpent,
          })
      ).at(0);
      if (!won) return false;
      await creditRepository.releaseForJob(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        jobId,
        leased: won.leased,
        leasedFromSubscription: won.leasedFromSub,
        spent: won.spent,
        actorUserId,
      });
      return true;
    });
  },

  /**
   * Cancel — ONE atomic tx: GUARDED transition from any non-terminal state → `cancelled` THEN release the
   * lease remainder (whatever hasn't been spent). Exactly-once via the status pin. Returns true iff cancelled.
   */
  async cancelAndRelease(
    scope: WsScope,
    jobId: string,
    actorUserId: string | null,
  ): Promise<boolean> {
    return withTenantTx(scope, async (tx) => {
      const won = (
        await tx
          .update(revealJobs)
          .set({ status: "cancelled", completedAt: sql`now()` })
          .where(
            and(
              eq(revealJobs.id, jobId),
              inArray(revealJobs.status, ["awaiting_confirmation", "running", "paused"]),
            ),
          )
          .returning({
            leased: revealJobs.creditLeased,
            leasedFromSub: revealJobs.creditLeasedFromSub,
            spent: revealJobs.creditSpent,
          })
      ).at(0);
      if (!won) return false;
      await creditRepository.releaseForJob(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        jobId,
        leased: won.leased,
        leasedFromSubscription: won.leasedFromSub,
        spent: won.spent,
        actorUserId,
      });
      return true;
    });
  },

  /** Pause a running job (status pin running → paused). Resume re-runs the not-yet-done rows. Returns won. */
  async pauseRunning(scope: TenantScope, jobId: string): Promise<boolean> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .update(revealJobs)
        .set({ status: "paused" })
        .where(and(eq(revealJobs.id, jobId), eq(revealJobs.status, "running")))
        .returning({ id: revealJobs.id });
      return rows.length > 0;
    });
  },

  /** Resume a paused job (status pin paused → running). The caller re-enqueues the drive. Returns won. */
  async resumePaused(scope: TenantScope, jobId: string): Promise<boolean> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .update(revealJobs)
        .set({ status: "running" })
        .where(and(eq(revealJobs.id, jobId), eq(revealJobs.status, "paused")))
        .returning({ id: revealJobs.id });
      return rows.length > 0;
    });
  },

  /** The queued rows of a band [rowStart, rowEnd), ascending — the unit a chunk reveals. */
  async listBandQueuedRows(
    scope: TenantScope,
    jobId: string,
    rowStart: number,
    rowEnd: number,
  ): Promise<RevealBandRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: revealJobRows.id,
          contactId: revealJobRows.contactId,
          rowIndex: revealJobRows.rowIndex,
        })
        .from(revealJobRows)
        .where(
          and(
            eq(revealJobRows.jobId, jobId),
            eq(revealJobRows.outcome, "queued"),
            gte(revealJobRows.rowIndex, rowStart),
            lt(revealJobRows.rowIndex, rowEnd),
          ),
        )
        .orderBy(asc(revealJobRows.rowIndex)),
    );
  },

  /** Record a row's terminal outcome + cost. Pins outcome='queued' so a redelivered chunk is a safe no-op. */
  async setRowOutcome(
    scope: TenantScope,
    rowId: string,
    outcome: string,
    creditsCharged: number,
  ): Promise<void> {
    return withTenantTx(scope, async (tx) => {
      await tx
        .update(revealJobRows)
        .set({ outcome, creditsCharged: Math.max(0, Math.trunc(creditsCharged)) })
        .where(and(eq(revealJobRows.id, rowId), eq(revealJobRows.outcome, "queued")));
    });
  },

  /** How many rows are still queued (used to decide finalize). */
  async countQueuedRows(scope: TenantScope, jobId: string): Promise<number> {
    return withTenantTx(scope, async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM reveal_job_rows WHERE job_id = ${jobId} AND outcome = 'queued'`,
      )) as unknown as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    });
  },

  /** The contact ids that resolved to owned data (revealed or already_owned) — the revealed-CSV work-list. */
  async listRevealedContactIds(scope: TenantScope, jobId: string): Promise<string[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({ contactId: revealJobRows.contactId })
        .from(revealJobRows)
        .where(
          and(
            eq(revealJobRows.jobId, jobId),
            inArray(revealJobRows.outcome, ["revealed", "already_owned"]),
          ),
        );
      return rows.map((r) => r.contactId).filter((c): c is string => c !== null);
    });
  },

  /** The contact ids that FAILED (error/insufficient) — the frontend "retry failed" re-submits these as a new
   *  job (its own clean lease/release cycle), rather than re-opening this job's accounting. */
  async listFailedContactIds(scope: TenantScope, jobId: string): Promise<string[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({ contactId: revealJobRows.contactId })
        .from(revealJobRows)
        .where(
          and(
            eq(revealJobRows.jobId, jobId),
            inArray(revealJobRows.outcome, ["error", "insufficient"]),
          ),
        );
      return rows.map((r) => r.contactId).filter((cId): cId is string => cId !== null);
    });
  },

  /** Retry-failed: re-queue rows that ended in error/insufficient. Returns how many were re-queued. */
  async requeueFailedRows(scope: TenantScope, jobId: string): Promise<number> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .update(revealJobRows)
        .set({ outcome: "queued" })
        .where(
          and(
            eq(revealJobRows.jobId, jobId),
            inArray(revealJobRows.outcome, ["error", "insufficient"]),
          ),
        )
        .returning({ id: revealJobRows.id });
      return rows.length;
    });
  },
};
