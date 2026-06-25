// masterBackfill.ts — the `master-backfill` queue processor (PLAN_00 §11.5 / PLAN_07 Stage B): runs the
// per-workspace master-link backfill off the request thread. Delegates to core's runMasterBackfill, which walks
// ONE workspace's overlay contacts with NULL master_* bridges (withTenantTx → RLS isolation) and re-resolves
// each through the SAME Phase-2′ resolver the import path uses (withErTx → leadwolf_er). Idempotent — only
// still-NULL rows are returned each pass, so a re-run (or a resume after a crash) is always safe. Mirrors the
// dedup/firmographics per-workspace job idiom.

import { type MasterBackfillResult, runMasterBackfill } from "@leadwolf/core";
import type { Job } from "bullmq";

export const MASTER_BACKFILL_QUEUE = "master-backfill";

/** The job payload: the workspace scope to backfill + an optional keyset batch size (defaults in core). */
export interface MasterBackfillJobData {
  scope: { tenantId: string; workspaceId: string };
  batchSize?: number;
}

export async function processMasterBackfill(
  job: Job<MasterBackfillJobData>,
): Promise<MasterBackfillResult> {
  const { scope, batchSize } = job.data;
  return runMasterBackfill(scope, { batchSize });
}
