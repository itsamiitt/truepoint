// lowBalanceNotifierSweep.ts — the scheduled, leader-locked low-balance notifier sweep (plans-pricing-credits,
// 07 §9 proactive top-up / churn-risk). Once daily, a single worker reads the active tenants at/under the
// credit threshold (an owner-connection, non-PII aggregate) and emits ONE structured ops signal per low tenant.
//
// SCAFFOLD: this is the detector; the customer-facing delivery channel (email / in-app via the ADR-0027 event
// backbone) is the next wiring step. It is READ-ONLY — it CHARGES and DELETES nothing. DARK by default:
// register.ts only constructs + schedules it when LOW_BALANCE_NOTIFIER_ENABLED is true, so it is inert in prod
// until a channel lands. Leader-locked (mirrors the data-quality / retention sweeps) so exactly one worker runs
// per tick. Logs ids only (tenantId/plan/balance) — never a tenant name or any PII.

import { env } from "@leadwolf/config";
import { platformBillingReadRepository, withPlatformReadTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const LOW_BALANCE_NOTIFIER_SWEEP_QUEUE = "low_balance_notifier_sweep";
const LEADER_KEY = "leader:low_balance_notifier_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// Bound the fan-out per tick so one sweep can't do unbounded work; remaining tenants are picked up next tick.
const MAX_TENANTS_PER_SWEEP = 1000;

export type LowBalanceNotifierSweepJobData = Record<string, never>;

/**
 * Build the sweep processor. Takes the Redis leader lock, reads the active tenants at/under the credit
 * threshold (system-level, non-PII owner read; no audit row — it is automation, not a privileged staff read),
 * and emits one ops signal per low tenant. No customer is charged or notified yet (scaffold).
 */
export function makeProcessLowBalanceNotifierSweep(redis: IORedis) {
  return async function processLowBalanceNotifierSweep(
    _job: Job<LowBalanceNotifierSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const threshold = env.LOW_BALANCE_NOTIFIER_THRESHOLD;
      const tenants = await withPlatformReadTx((tx) =>
        platformBillingReadRepository.lowBalanceTenants(tx, threshold, MAX_TENANTS_PER_SWEEP),
      );
      // SCAFFOLD: one structured ops signal per low tenant. Replace with the customer-facing channel (email /
      // in-app event, ADR-0027) when it lands. Ids only — never the tenant name or any PII.
      for (const t of tenants) {
        log.info("low-balance notifier: tenant at/under threshold", {
          tenantId: t.tenantId,
          plan: t.plan,
          balance: t.revealCreditBalance,
          threshold,
        });
      }
      if (tenants.length > 0) {
        log.info("low-balance notifier sweep: low-balance tenants flagged", {
          count: tenants.length,
          threshold,
        });
      }
    });
  };
}
