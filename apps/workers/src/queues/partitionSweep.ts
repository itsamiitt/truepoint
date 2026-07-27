// partitionSweep.ts — the daily job that keeps monthly range partitions ahead of the calendar (E-6.4).
//
// Registered NOW even though no table is partitioned yet, and that is the point. An INSERT whose partition
// key falls outside every partition is rejected outright (23514 — proven in
// partitioningFeasibility.itest.ts), so a partitioned table without this running does not slow down, it
// stops accepting writes on the first of a month. Shipping the maintenance before the conversion means a
// conversion migration is the only change needed later, rather than a conversion plus remembering to also
// wire the thing that keeps it alive.
//
// Inert until then: the repository asks the catalog for partitioned tables and finds none, so the sweep does
// nothing and logs nothing but a zero.
//
// Leader-locked like the other fleet sweeps — DDL run concurrently from N workers would have them racing to
// create the same partition, and the loser gets a duplicate-table error for no reason.

import { partitionRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const PARTITION_SWEEP_QUEUE = "partition_sweep";
const LEADER_KEY = "leader:partition_sweep";
const LEADER_TTL_MS = 5 * 60_000;

export type PartitionSweepJobData = Record<string, never>;

/**
 * Build the sweep processor: take the leader lock, then ensure the next months exist for every partitioned
 * table.
 *
 * A failure is logged and RETHROWN rather than swallowed. Every other fleet sweep here is best-effort
 * because a missed pass costs freshness; a missed pass of this one eventually costs writes, so it should
 * surface through the queue's retry and dead-letter path like any other failing job.
 */
export function makeProcessPartitionSweep(redis: IORedis) {
  return async function processPartitionSweep(_job: Job<PartitionSweepJobData>): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const results = await partitionRepository.ensureAll();
      const created = results.reduce((sum, r) => sum + r.created, 0);
      // Only worth a line when something happened or there is something to maintain — a daily "0 of 0" from
      // every worker is noise until the first conversion lands.
      if (results.length > 0) {
        log.info("partition sweep", {
          tables: results.length,
          created,
          // Named tables only when they actually gained partitions, so the steady-state line stays short.
          ...(created > 0
            ? { detail: results.filter((r) => r.created > 0).map((r) => `${r.table}:${r.created}`) }
            : {}),
        });
      }
    });
  };
}
