// reverification.ts — the `reverification` queue processor (ADR-0025, 22 §3/§4): runs the per-workspace freshness
// re-verification off the request thread. Delegates to core's runReverification, which re-grades ONE workspace's
// REVEALED, past-SLA contacts through THE SAME verifier the reveal path wires (Reacher when configured) and resets
// their freshness clock. Idempotent — only still-stale rows are returned each pass, so a re-run/resume is safe.
// Mirrors the master-backfill per-workspace job idiom. Errored rows keep their old last_verified_at and are simply
// re-picked by a later sweep, so this does NOT throw on errored>0 (no retry storm on a persistently-bad row).

import { type ReverificationResult, runReverification } from "@leadwolf/core";
import type { Job } from "bullmq";

export const REVERIFICATION_QUEUE = "reverification";

/** The job payload: the workspace scope to re-verify + an optional keyset batch size (defaults in core). */
export interface ReverificationJobData {
  scope: { tenantId: string; workspaceId: string };
  batchSize?: number;
}

export async function processReverification(
  job: Job<ReverificationJobData>,
): Promise<ReverificationResult> {
  const { scope, batchSize } = job.data;
  return runReverification(scope, { batchSize });
}
