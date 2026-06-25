// retentionSweep.ts — the email retention/idempotency sweep (M12 P6, email-planning/13 P6, 15 §A.2). A
// leader-locked daily job that reclaims expired idempotency keys (the replay cache). The cold-email_event
// partition DROP is the other half (15 §A.2); it lands when email_event is converted to a partitioned parent
// (the outreach_log/source_imports precedent — plain table until volume warrants). Best-effort + batched.

import { idempotencyRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const RETENTION_SWEEP_QUEUE = "email_retention_sweep";
const LEADER_KEY = "leader:email_retention_sweep";
const LEADER_TTL_MS = 5 * 60_000;
// Idempotency keys are a short-lived replay cache; 30 days is well past any client retry window.
const IDEMPOTENCY_RETENTION_DAYS = 30;

export type RetentionSweepJobData = Record<string, never>;

export function makeProcessRetentionSweep(redis: IORedis) {
  return async function processRetentionSweep(_job: Job<RetentionSweepJobData>): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      let total = 0;
      // Drain in batches so a large backlog doesn't lock the table in one statement.
      for (;;) {
        const n = await idempotencyRepository.deleteExpired(IDEMPOTENCY_RETENTION_DAYS);
        total += n;
        if (n < 5000) break;
      }
      if (total > 0) log.info("retention sweep: idempotency keys reclaimed", { count: total });
    });
  };
}
