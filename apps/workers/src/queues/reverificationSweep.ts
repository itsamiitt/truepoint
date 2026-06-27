// reverificationSweep.ts — the scheduled, leader-locked freshness re-verification SWEEP (ADR-0025, 22 §3/§4).
// The per-workspace job (reverification.ts) re-grades ONE workspace's stale revealed contacts; this sweep DRIVES
// it fleet-wide: a single repeatable daily job enumerates every workspace holding REVEALED, past-SLA contacts and
// enqueues a per-workspace re-verification for each, so decayed data is re-graded on a cadence. Leader-locked
// (mirrors the master-backfill / retention sweeps) so exactly one worker fans out per tick. NO-OP when no verifier
// is configured (REACHER_BACKEND_URL unset): without a real verifier there is nothing to re-grade and we must
// never reset freshness clocks falsely — so the sweep skips entirely.

import { env } from "@leadwolf/config";
import { contactRepository } from "@leadwolf/db";
import { FRESHNESS_SLA_DAYS, reverifyCutoff } from "@leadwolf/types";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const REVERIFICATION_SWEEP_QUEUE = "reverification_sweep";
const LEADER_KEY = "leader:reverification_sweep";
const LEADER_TTL_MS = 5 * 60_000;
// Cap the fan-out per tick so one sweep can't enqueue unbounded work; a workspace still stale after this tick is
// picked up next tick (the enumeration only returns workspaces that STILL hold past-SLA revealed contacts).
const MAX_WORKSPACES_PER_SWEEP = 1000;

export type ReverificationSweepJobData = Record<string, never>;

/**
 * Build the sweep processor. `enqueue` (= enqueueReverification) is injected to avoid a circular import with
 * register.ts. The processor skips when no verifier is configured, else takes the Redis leader lock, enumerates
 * workspaces with stale revealed contacts (a system-level, non-PII, owner-connection read), and enqueues one
 * per-workspace re-verification each — best-effort: one workspace's enqueue failure never aborts the sweep.
 */
export function makeProcessReverificationSweep(
  redis: IORedis,
  enqueue: (scope: { tenantId: string; workspaceId: string }) => Promise<string>,
) {
  return async function processReverificationSweep(
    _job: Job<ReverificationSweepJobData>,
  ): Promise<void> {
    // No verifier wired → nothing to re-grade; skip without touching any freshness clock.
    if (!env.REACHER_BACKEND_URL) {
      log.info("reverification sweep skipped (no verifier configured)");
      return;
    }
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const cutoff = reverifyCutoff(new Date(), FRESHNESS_SLA_DAYS.email);
      const workspaces = await contactRepository.listWorkspacesWithStaleRevealed(
        cutoff,
        MAX_WORKSPACES_PER_SWEEP,
      );
      let enqueued = 0;
      for (const scope of workspaces) {
        try {
          await enqueue(scope);
          enqueued += 1;
        } catch (e) {
          log.error("reverification sweep: per-workspace enqueue failed", {
            workspaceId: scope.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (enqueued > 0) {
        log.info("reverification sweep: per-workspace re-verifications enqueued", {
          count: enqueued,
        });
      }
    });
  };
}
