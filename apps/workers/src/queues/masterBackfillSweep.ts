// masterBackfillSweep.ts — the scheduled, leader-locked master-link backfill SWEEP (PLAN_07 Stage B). The
// per-workspace backfill (masterBackfill.ts) resolves ONE workspace's NULL-bridge contacts; this sweep is what
// DRIVES it fleet-wide: a single repeatable daily job (registered in register.ts) enumerates every workspace
// that still holds unresolved contacts and enqueues a per-workspace backfill for each, so the existing backlog
// drains on a cadence without anyone manually enqueuing. Leader-locked (mirrors the retention sweep) so exactly
// one worker fans out per tick; idempotent — the per-workspace jobs only ever touch still-NULL rows.

import { contactRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const MASTER_BACKFILL_SWEEP_QUEUE = "master_backfill_sweep";
const LEADER_KEY = "leader:master_backfill_sweep";
const LEADER_TTL_MS = 5 * 60_000;
// Cap the fan-out per tick so one sweep can't enqueue unbounded work; a workspace still unresolved after this
// tick is picked up next tick (the enumeration only returns workspaces that STILL have NULL-bridge contacts).
const MAX_WORKSPACES_PER_SWEEP = 1000;

export type MasterBackfillSweepJobData = Record<string, never>;

/**
 * Build the sweep processor. `enqueue` (= enqueueMasterBackfill) is injected to avoid a circular import with
 * register.ts (which owns the producer). The processor takes the Redis leader lock, enumerates workspaces with
 * unresolved contacts (a system-level, non-PII, owner-connection read), and enqueues one per-workspace backfill
 * each — best-effort: one workspace's enqueue failure never aborts the sweep.
 */
export function makeProcessMasterBackfillSweep(
  redis: IORedis,
  enqueue: (scope: { tenantId: string; workspaceId: string }) => Promise<string>,
) {
  return async function processMasterBackfillSweep(
    _job: Job<MasterBackfillSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const workspaces =
        await contactRepository.listWorkspacesWithUnresolvedContacts(MAX_WORKSPACES_PER_SWEEP);
      let enqueued = 0;
      for (const scope of workspaces) {
        try {
          await enqueue(scope);
          enqueued += 1;
        } catch (e) {
          log.error("master-backfill sweep: per-workspace enqueue failed", {
            workspaceId: scope.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (enqueued > 0) {
        log.info("master-backfill sweep: per-workspace backfills enqueued", { count: enqueued });
      }
    });
  };
}
