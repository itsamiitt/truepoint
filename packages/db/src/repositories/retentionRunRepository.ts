// retentionRunRepository.ts — data access for the per-tenant, APPEND-ONLY retention RUN audit (retention_runs,
// data-management backlog #6; design 16-retention-engine-design.md). The sweep records ONE row per data class
// per run: the candidate volume it found and (in shadow mode) the zero it deleted — the evidence measured BEFORE
// any class is flipped to `enforce`. Tx-aware and composed inside withTenantTx, so RLS scopes every read/append
// to the active tenant via the GUC. The run audit is IMMUTABLE: this repository only appends and reads — there
// is no update/delete (and RLS denies them: retention_runs has SELECT + INSERT policies only). No deletion
// logic here — the sweep that computes candidate_count / deleted_count lives in core/workers (a later phase).

import type { RetentionDataClass, RetentionMode } from "@leadwolf/types";
import { desc, eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { retentionRuns } from "../schema/retention.ts";

/** One persisted run-audit row (the DB-edge shape of the RetentionRun contract; timestamps are Date). */
export type RetentionRunRow = typeof retentionRuns.$inferSelect;

/**
 * The values the sweep records for one class's run. The DB-edge shape of the RetentionRun contract from
 * @leadwolf/types — timestamps are `Date` (drizzle's timestamp mode), `cutoff` is null when the class's ttlDays
 * is null (nothing ages out), and `deletedCount` defaults to 0 (always 0 in shadow mode). `tenantId` is pinned
 * by the RLS WITH CHECK to the active tenant, so a run can only ever be appended for the caller's own tenant.
 */
export interface RetentionRunInsert {
  tenantId: string;
  dataClass: RetentionDataClass;
  mode: RetentionMode;
  candidateCount: number;
  deletedCount?: number;
  cutoff: Date | null;
  runStartedAt: Date;
  runFinishedAt: Date;
}

/** Optional filters for the audit read: narrow to one class and/or cap the page (default 100, max 500). */
export interface RecentRunsOptions {
  dataClass?: RetentionDataClass;
  limit?: number;
}

export const retentionRunRepository = {
  /**
   * Append one run-audit row for the active tenant (tx-aware — composed inside the sweep's withTenantTx). RLS
   * pins `tenant_id` to the GUC tenant on insert; `deletedCount` defaults to 0 when omitted (shadow mode).
   */
  async recordRun(tx: Tx, input: RetentionRunInsert): Promise<void> {
    await tx.insert(retentionRuns).values({
      tenantId: input.tenantId,
      dataClass: input.dataClass,
      mode: input.mode,
      candidateCount: input.candidateCount,
      deletedCount: input.deletedCount ?? 0,
      cutoff: input.cutoff,
      runStartedAt: input.runStartedAt,
      runFinishedAt: input.runFinishedAt,
    });
  },

  /**
   * The recent run audit for the caller's tenant, newest-first (the dashboard/admin trend read). Tenant-scoped
   * via RLS — the `retention_runs_tenant_read` policy restricts the SELECT to the active tenant, so this can
   * never return another tenant's runs. Optionally narrowed to one data class; capped at `limit` (default 100,
   * max 500). The (tenant_id, data_class, created_at) index serves both the all-class and per-class read.
   */
  async recentRuns(tx: Tx, opts: RecentRunsOptions = {}): Promise<RetentionRunRow[]> {
    const capped = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100)));
    return tx
      .select()
      .from(retentionRuns)
      .where(opts.dataClass ? eq(retentionRuns.dataClass, opts.dataClass) : undefined)
      .orderBy(desc(retentionRuns.createdAt))
      .limit(capped);
  },
};
