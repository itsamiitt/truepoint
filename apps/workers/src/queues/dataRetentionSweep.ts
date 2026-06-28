// dataRetentionSweep.ts — the scheduled, leader-locked retention sweep (data-management backlog #6; design
// 16-retention-engine-design.md §5). Mirrors the reverification / master-backfill / data-quality-snapshot sweeps:
// a single repeatable daily job enumerates ACTIVE tenants and runs the per-tenant retention pass for each. The pass
// is DOUBLE-GATED and ships INERT: it is gated INSIDE by the per-tenant `retention_engine_enabled` flag (off, the
// fail-closed default ⇒ it records nothing), and a class deletes ONLY when its policy.mode === 'enforce' (the
// default is `shadow`, which COUNTS + records evidence but DELETES NOTHING). So registering this schedule is
// harmless — with the shipped defaults nothing is purged until an operator flips a class to `enforce` on a
// flag-enabled tenant. Leader-locked so exactly one worker fans out per tick; best-effort per tenant — one
// tenant's failure never aborts the sweep.

import { runRetentionSweepForTenant } from "@leadwolf/core";
import { retentionScanRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const DATA_RETENTION_SWEEP_QUEUE = "data_retention_sweep";
const LEADER_KEY = "leader:data_retention_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// Cap the fan-out per tick so one sweep can't do unbounded work; remaining tenants are picked up next tick.
const MAX_TENANTS_PER_SWEEP = 1000;

export type DataRetentionSweepJobData = Record<string, never>;

/**
 * Build the sweep processor. Takes the Redis leader lock, enumerates ACTIVE tenants (a system-level, non-PII,
 * owner-connection read), and runs the per-tenant retention pass for each — best-effort: one tenant's failure
 * never aborts the sweep. Each pass is double-gated (per-tenant flag + per-class `enforce` mode) and deletes
 * nothing unless a class has been deliberately flipped to `enforce` on a flag-enabled tenant.
 */
export function makeProcessDataRetentionSweep(redis: IORedis) {
  return async function processDataRetentionSweep(
    _job: Job<DataRetentionSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const tenantIds = await retentionScanRepository.listActiveTenants(MAX_TENANTS_PER_SWEEP);
      let recorded = 0;
      let deleted = 0;
      for (const tenantId of tenantIds) {
        try {
          const result = await runRetentionSweepForTenant({ tenantId });
          recorded += result.classesRecorded;
          deleted += result.totalDeleted;
        } catch (e) {
          log.error("data-retention sweep: per-tenant pass failed", {
            tenantId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (recorded > 0) {
        log.info("data-retention sweep: runs recorded", { count: recorded, deleted });
      }
    });
  };
}
