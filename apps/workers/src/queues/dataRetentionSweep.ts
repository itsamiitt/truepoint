// dataRetentionSweep.ts — the scheduled, leader-locked retention SHADOW sweep (data-management backlog #6, phase 2;
// design 16-retention-engine-design.md §5). Mirrors the reverification / master-backfill / data-quality-snapshot
// sweeps: a single repeatable daily job enumerates ACTIVE tenants and runs the per-tenant SHADOW retention pass for
// each. The pass is gated INSIDE by the per-tenant `retention_engine_enabled` flag (off, the fail-closed default ⇒
// it records nothing), so registering this schedule is harmless — a tenant without the flag is skipped. SHADOW: the
// pass COUNTS candidate rows per data class and appends a retention_runs evidence row — it DELETES NOTHING
// (enforce-mode deletion is phase 3). Leader-locked so exactly one worker fans out per tick; best-effort per
// tenant — one tenant's failure never aborts the sweep.

import { runRetentionShadowSweep } from "@leadwolf/core";
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
 * owner-connection read), and runs the per-tenant SHADOW retention pass for each — best-effort: one tenant's
 * failure never aborts the sweep. Each pass is itself flag-gated and DELETES NOTHING (counts + records only).
 */
export function makeProcessDataRetentionSweep(redis: IORedis) {
  return async function processDataRetentionSweep(
    _job: Job<DataRetentionSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const tenantIds = await retentionScanRepository.listActiveTenants(MAX_TENANTS_PER_SWEEP);
      let recorded = 0;
      for (const tenantId of tenantIds) {
        try {
          const result = await runRetentionShadowSweep({ tenantId });
          recorded += result.classesRecorded;
        } catch (e) {
          log.error("data-retention sweep: per-tenant shadow pass failed", {
            tenantId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (recorded > 0) {
        log.info("data-retention sweep: shadow runs recorded", { count: recorded });
      }
    });
  };
}
