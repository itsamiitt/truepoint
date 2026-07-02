// reverification.ts — the `reverification` queue PROCESSOR (ADR-0025, 22 §3/§4): runs the per-workspace freshness
// re-verification off the request thread. Delegates to core's runReverification, which re-grades ONE workspace's
// REVEALED, past-SLA contacts through THE SAME verifier the reveal path wires (Reacher when configured) and resets
// their freshness clock. Idempotent — only still-stale rows are returned each pass, so a re-run/resume is safe.
// Mirrors the master-backfill per-workspace job idiom. Errored rows keep their old last_verified_at and are simply
// re-picked by a later sweep, so this does NOT throw on errored>0 (no retry storm on a persistently-bad row).
//
// The queue NAME + the job-data CONTRACT now live in @leadwolf/types (the shared producer/consumer contract — also
// used by apps/api's on-demand trigger, data-management #3); they are RE-EXPORTED here so register.ts (and any
// worker code) keep importing them from this module unchanged — an additive, behavior-preserving move.

import { type ReverificationResult, runReverification } from "@leadwolf/core";
import {
  REVERIFICATION_DLQ,
  REVERIFICATION_QUEUE,
  type ReverificationJobData,
} from "@leadwolf/types";
import type { Job } from "bullmq";

export { REVERIFICATION_DLQ, REVERIFICATION_QUEUE };
export type { ReverificationJobData };

export async function processReverification(
  job: Job<ReverificationJobData>,
): Promise<ReverificationResult> {
  const { scope, batchSize } = job.data;
  return runReverification(scope, { batchSize });
}
