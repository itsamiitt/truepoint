// dataQualitySnapshotSweep.ts — the scheduled, leader-locked Data Health snapshot sweep (10 §5 / 22). Once daily,
// a single worker enumerates every workspace holding contacts and captures one WorkspaceDataQuality trend point
// for each (INLINE: a bounded aggregate + insert per workspace — no per-workspace queue needed for a daily,
// non-latency-sensitive rollup). Leader-locked (mirrors the reverification / master-backfill sweeps) so exactly
// one worker runs per tick. Best-effort per workspace — one capture failure never aborts the sweep.

import { captureDataQualitySnapshot } from "@leadwolf/core";
import { contactRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const DATA_QUALITY_SNAPSHOT_SWEEP_QUEUE = "data_quality_snapshot_sweep";
const LEADER_KEY = "leader:data_quality_snapshot_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// Cap the fan-out per tick so one sweep can't do unbounded work; remaining workspaces are picked up next tick.
const MAX_WORKSPACES_PER_SWEEP = 1000;

export type DataQualitySnapshotSweepJobData = Record<string, never>;

/**
 * Build the sweep processor. Takes the Redis leader lock, enumerates workspaces holding contacts (a system-level,
 * non-PII, owner-connection read), and captures one Data Health snapshot for each — best-effort: one workspace's
 * capture failure never aborts the sweep.
 */
export function makeProcessDataQualitySnapshotSweep(redis: IORedis) {
  return async function processDataQualitySnapshotSweep(
    _job: Job<DataQualitySnapshotSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const workspaces = await contactRepository.listWorkspacesWithContacts(MAX_WORKSPACES_PER_SWEEP);
      let captured = 0;
      for (const scope of workspaces) {
        try {
          await captureDataQualitySnapshot(scope);
          captured += 1;
        } catch (e) {
          log.error("data-quality snapshot sweep: per-workspace capture failed", {
            workspaceId: scope.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (captured > 0) {
        log.info("data-quality snapshot sweep: workspace snapshots captured", { count: captured });
      }
    });
  };
}
