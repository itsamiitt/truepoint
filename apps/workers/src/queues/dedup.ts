// dedup.ts — the `dedup` queue processor (24 Phase-0.5): runs the per-workspace contact dedup pass off the
// request thread. Delegates to core's runDedup (which flags likely-duplicate contacts within ONE workspace via
// withTenantTx → RLS isolation). Enqueued after a bulk import completes or on a schedule; idempotent, so a
// re-run is always safe.

import { type RunDedupResult, runDedup } from "@leadwolf/core";
import type { Job } from "bullmq";

export const DEDUP_QUEUE = "dedup";

export interface DedupJobData {
  tenantId: string;
  workspaceId: string;
}

export async function processDedup(job: Job<DedupJobData>): Promise<RunDedupResult> {
  const { tenantId, workspaceId } = job.data;
  return runDedup({ tenantId, workspaceId });
}
