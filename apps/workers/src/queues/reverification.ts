// reverification.ts — the `reverification` queue PROCESSOR (ADR-0025, 22 §3/§4): runs the per-workspace freshness
// re-verification off the request thread. Delegates to core's runReverification, which re-grades ONE workspace's
// REVEALED, past-SLA contacts through THE SAME verifier the reveal path wires (Reacher when configured) and resets
// their freshness clock. Idempotent — only still-stale rows are returned each pass, so a re-run/resume is safe.
// Mirrors the master-backfill per-workspace job idiom. Errored rows keep their old last_verified_at and are simply
// re-picked by a later sweep, so this does NOT throw on errored>0 (no retry storm on a persistently-bad row).
//
// Deadline cooperation (perf-audit P1.2/P1.3): register.ts wraps this in withDeadline, whose AbortSignal is
// threaded into the core loop — a deadline-killed attempt stops within one verify wave (no orphan vendor
// spend), stamps + ledgers what it did, and the checkpoint written onto the JOB DATA after each batch makes
// the backoff retry RESUME from where the kill landed instead of re-scanning the workspace from the top.
//
// The queue NAME + the job-data CONTRACT live in @leadwolf/types (the shared producer/consumer contract — also
// used by apps/api's on-demand trigger, data-management #3); they are RE-EXPORTED here so register.ts (and any
// worker code) keep importing them from this module unchanged.

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
  signal?: AbortSignal,
): Promise<ReverificationResult> {
  const { scope, batchSize, resumeCursor } = job.data;
  return runReverification(scope, {
    batchSize,
    signal,
    // The checkpoint crosses Redis as JSON (ISO sortKey) — rehydrate the Date for the keyset read.
    resumeCursor: resumeCursor
      ? { sortKey: new Date(resumeCursor.sortKey), id: resumeCursor.id }
      : null,
    // Persist the cursor onto the job after each stamped batch, so THIS job's retry attempts resume there.
    // updateData writes the stored job data in Redis; scope/batchSize ride along unchanged.
    onCheckpoint: async (cursor) => {
      await job.updateData({
        ...job.data,
        resumeCursor: { sortKey: cursor.sortKey.toISOString(), id: cursor.id },
      });
    },
  });
}
