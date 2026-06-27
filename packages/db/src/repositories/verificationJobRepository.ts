// verificationJobRepository.ts — the freshness re-verification AUDIT LEDGER (verification_jobs, PLAN_06). The
// reverify worker records ONE row per completed runReverification pass (the scanned/reverified/errored tally +
// the run window); reads expose recent runs per workspace for ops/observability. Workspace-scoped via RLS — the
// caller composes record/listRecent inside a withTenantTx, so isolation rides the GUC, not an explicit predicate.

import { desc } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { verificationJobs } from "../schema/verificationJobs.ts";

/** The fields the reverify worker supplies for one completed-run ledger row (id + created_at default). */
export interface VerificationJobRecord {
  tenantId: string;
  workspaceId: string;
  startedAt: Date;
  finishedAt: Date;
  scanned: number;
  reverified: number;
  errored: number;
}

/** A persisted ledger row (the non-PII run summary). */
export type VerificationJobRow = typeof verificationJobs.$inferSelect;

export const verificationJobRepository = {
  /** Insert one completed-run ledger row (tx-aware — composed inside the worker's workspace tx). */
  async record(tx: Tx, job: VerificationJobRecord): Promise<void> {
    await tx.insert(verificationJobs).values(job);
  },

  /** Recent re-verification runs for the caller's workspace, newest first (ops/observability read). */
  async listRecent(tx: Tx, limit = 50): Promise<VerificationJobRow[]> {
    return tx.select().from(verificationJobs).orderBy(desc(verificationJobs.createdAt)).limit(limit);
  },
};
