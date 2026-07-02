// masterBackfill.ts — the `master-backfill` queue processor (PLAN_00 §11.5 / PLAN_07 Stage B): runs the
// per-workspace master-link backfill off the request thread. Delegates to core's runMasterBackfill, which walks
// ONE workspace's overlay contacts with NULL master_* bridges (withTenantTx → RLS isolation) and re-resolves
// each through the SAME Phase-2′ resolver the import path uses (withErTx → leadwolf_er). Idempotent — only
// still-NULL rows are returned each pass, so a re-run (or a resume after a crash) is always safe. Mirrors the
// dedup/firmographics per-workspace job idiom.

import { type MasterBackfillResult, runMasterBackfill } from "@leadwolf/core";
import type { Job } from "bullmq";

export const MASTER_BACKFILL_QUEUE = "master-backfill";
/** Dead-letter holding queue for backfill jobs that exhaust their retries (PII-free records). Before this,
 *  an exhausted attempts:4 job silently sat in the BullMQ failed set with no ops signal. */
export const MASTER_BACKFILL_DLQ = "master-backfill-dlq";

/** The job payload: the workspace scope to backfill + an optional keyset batch size (defaults in core). */
export interface MasterBackfillJobData {
  scope: { tenantId: string; workspaceId: string };
  batchSize?: number;
}

/**
 * The self-heal gate — extracted as a pure fn so it's unit-testable WITHOUT mock.module (which leaks
 * process-globally in bun and reddens the suite). A row that THREW during resolve/stamp was left NULL (in-flight
 * staging), so THROW to make BullMQ retry the job (attempts/backoff in register.ts): the re-run re-scans from
 * the start and re-attempts the still-NULL rows. Cleanly-unresolvable KEYLESS rows do NOT count as `errored`, so
 * a job whose only leftovers are keyless succeeds and never loops.
 */
export function throwIfErrored(result: MasterBackfillResult): void {
  if (result.errored > 0) {
    throw new Error(
      `master-backfill: ${result.errored} row(s) errored (resolved ${result.resolved}/${result.scanned}); retrying`,
    );
  }
}

export async function processMasterBackfill(
  job: Job<MasterBackfillJobData>,
): Promise<MasterBackfillResult> {
  const { scope, batchSize } = job.data;
  const result = await runMasterBackfill(scope, { batchSize });
  throwIfErrored(result);
  return result;
}
