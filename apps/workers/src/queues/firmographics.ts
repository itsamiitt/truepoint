// firmographics.ts — the `firmographics` queue processor (24 Phase-0.5): rolls existing intent_signals up onto
// the account firmographic facets (technologies / funding_stage) for one workspace, off the request thread.
// Delegates to core's runFirmographicRollup (withTenantTx → RLS isolation). Enqueued after a bulk import (new
// rows bring new signals) or on a schedule; idempotent, so a re-run is always safe.

import { type RunFirmographicRollupResult, runFirmographicRollup } from "@leadwolf/core";
import { FIRMOGRAPHICS_DLQ, FIRMOGRAPHICS_QUEUE } from "@leadwolf/types";
import type { Job } from "bullmq";

// Queue + DLQ names live in @leadwolf/types (workerQueues.ts — the admin probe reads them too); re-exported.
export { FIRMOGRAPHICS_DLQ, FIRMOGRAPHICS_QUEUE };

export interface FirmographicsJobData {
  tenantId: string;
  workspaceId: string;
}

export async function processFirmographics(
  job: Job<FirmographicsJobData>,
): Promise<RunFirmographicRollupResult> {
  const { tenantId, workspaceId } = job.data;
  return runFirmographicRollup({ tenantId, workspaceId });
}
