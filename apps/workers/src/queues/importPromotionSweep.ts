// importPromotionSweep.ts — the S-Q2 leader-locked `deferred → queued` promotion sweep (import-redesign
// 09 §2.2): the scheduler half of the per-workspace job cap. One repeatable job (stable jobId → exactly one
// schedule) ticks on IMPORT_PROMOTION_SWEEP_EVERY_MS; the leader enumerates workspaces holding `deferred`
// import jobs (system-level, non-PII, owner-connection read), then runs the per-workspace promotion pass
// (core's promoteDeferredForWorkspace) under an RLS-scoped tx — oldest-first, metered into the cap's
// headroom. Transport per mode:
//   • copy drives get RE-PUBLISHED here (payload `{jobId, scope}` is reconstructable from the row; the
//     stable `import-drive:<jobId>` id dedupes a race with anything else that published it);
//   • fast jobs get a DB flip ONLY — their payload carries the rows (Phase-A bound, importV2.ts), so the
//     transport rides the delayed re-check loop the deferred claim already keeps in flight; the flip makes
//     the next claim run it (and keeps census/UI truthful: `queued`, waiting on worker).
// Failure containment mirrors the house sweeps: leader TTL bounds a crashed holder; per-workspace failures
// are best-effort (one workspace's error never aborts the sweep); every promotion is idempotent (the
// UPDATE pins status='deferred'). Registered only when the unified import queue itself is constructed.

import { promoteDeferredForWorkspace } from "@leadwolf/core";
import { importJobRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const IMPORT_PROMOTION_SWEEP_QUEUE = "import-promotion-sweep";
const LEADER_KEY = "leader:import_promotion_sweep";
const LEADER_TTL_MS = 2 * 60_000;
/** The scheduler cadence (09 §2.2 "the house sweep idiom"): frequent enough that a freed slot promotes the
 *  oldest deferred job promptly; the deferred claim's own delayed re-check backstops a missed tick. */
export const IMPORT_PROMOTION_SWEEP_EVERY_MS = 30_000;
// Cap the fan-out per tick so one sweep can't do unbounded work; remaining workspaces wait one tick.
const MAX_WORKSPACES_PER_SWEEP = 500;

export type ImportPromotionSweepJobData = Record<string, never>;

/**
 * Build the sweep processor. `enqueueCopyDrive` re-publishes a promoted COPY job's drive (injected so this
 * module never constructs a producer); fast promotions need no transport here (see header).
 */
export function makeProcessImportPromotionSweep(
  redis: IORedis,
  enqueueCopyDrive: (jobId: string, scope: { tenantId: string; workspaceId: string }) => Promise<void>,
) {
  return async function processImportPromotionSweep(
    _job: Job<ImportPromotionSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const workspaces = await importJobRepository.listDeferredWorkspaces(
        MAX_WORKSPACES_PER_SWEEP,
      );
      let promoted = 0;
      for (const scope of workspaces) {
        try {
          const jobs = await promoteDeferredForWorkspace(scope);
          promoted += jobs.length;
          for (const j of jobs) {
            if (j.processingMode === "copy") {
              await enqueueCopyDrive(j.id, scope);
            }
          }
        } catch (e) {
          log.error("import-promotion sweep: per-workspace pass failed", {
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (promoted > 0) {
        log.info("import-promotion sweep: deferred jobs promoted", { count: promoted });
      }
    });
  };
}
