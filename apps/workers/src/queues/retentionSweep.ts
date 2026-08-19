// retentionSweep.ts — the platform replay-cache/hygiene sweep (M12 P6, email-planning/13 P6, 15 §A.2;
// sessions added by perf-audit P2.8). A leader-locked daily job that reclaims expired idempotency keys (the
// replay cache) and DEAD user sessions (revoked/expired > 30 days — the prune schema/auth.ts's refresh-hash
// index comment promised; without it the table grew per login AND per rotation forever, degrading the
// silent-refresh hot path). The cold-email_event partition DROP is the other half (15 §A.2); it lands when
// email_event is converted to a partitioned parent. Best-effort + batched.

import { idempotencyRepository, sessionRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const RETENTION_SWEEP_QUEUE = "email_retention_sweep";
const LEADER_KEY = "leader:email_retention_sweep";
const LEADER_TTL_MS = 5 * 60_000;
// Idempotency keys are a short-lived replay cache; 30 days is well past any client retry window.
const IDEMPOTENCY_RETENTION_DAYS = 30;
// Dead sessions: past any admin recent-sessions view or reuse-detection forensics window.
const SESSION_RETENTION_DAYS = 30;

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

      let sessions = 0;
      for (;;) {
        const n = await sessionRepository.deleteExpired(SESSION_RETENTION_DAYS);
        sessions += n;
        if (n < 5000) break;
      }
      if (sessions > 0) log.info("retention sweep: dead sessions reclaimed", { count: sessions });
    });
  };
}
