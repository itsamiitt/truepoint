// subscriptionGrantSweep.ts — the leader-locked monthly-grant/reset sweep for subscriptions (M11, ADR-0041).
// Per due billing_cycle (period started, not yet granted) it runs ONE per-tenant transaction that: expires the
// unused perishable allotment (subscription bucket → ledger 'adjustment' reason=subscription_reset_expiry),
// grants the plan's monthly allotment (ledger 'grant'), resets the bucket, and marks the cycle granted — all
// atomic, so SUM(delta) still equals the counter (billing-recon stays green) and PURCHASED credits are never
// touched. Idempotent: a due cycle is processed exactly once (dueForGrant excludes granted cycles; markGranted
// runs in the SAME tx; the ledger idempotency keys are the last-line guard).
//
// DARK by default: register.ts only constructs + schedules it when BILLING_SUBSCRIPTIONS_ENABLED is true.
// Leader-locked so exactly one worker runs per tick.

import { billingCycleRepository, creditRepository, db } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const SUBSCRIPTION_GRANT_SWEEP_QUEUE = "subscription_grant_sweep";
const LEADER_KEY = "leader:subscription_grant_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// Bound the cycles granted per tick; the oldest due cycles first (dueForGrant orders by period_start). Any
// remainder resurfaces next tick.
const MAX_CYCLES = 500;

export type SubscriptionGrantSweepJobData = Record<string, never>;

/**
 * Build the sweep processor. Takes the Redis leader lock, reads the due billing cycles (owner path — a system
 * sweep across all tenants, no audit row), and applies each cycle's reset+grant in its own per-tenant tx so one
 * failing tenant never rolls back the others.
 */
export function makeProcessSubscriptionGrantSweep(redis: IORedis) {
  return async function processSubscriptionGrantSweep(
    _job: Job<SubscriptionGrantSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const due = await db.transaction((tx) => billingCycleRepository.dueForGrant(tx, MAX_CYCLES));
      let grantedCredits = 0;
      let expiredCredits = 0;
      let failures = 0;

      for (const cycle of due) {
        try {
          const result = await db.transaction(async (tx) => {
            const r = await creditRepository.applyMonthlyReset(
              tx,
              cycle.tenantId,
              cycle.id,
              cycle.grantCredits,
            );
            await billingCycleRepository.markGranted(tx, cycle.id, r.grantLedgerId);
            return r;
          });
          grantedCredits += result.granted;
          expiredCredits += result.expired;
        } catch (err) {
          failures += 1;
          // Ids only — never PII. A failed cycle stays open (granted_at null) → retried next tick.
          log.error("subscription-grant sweep: cycle failed", {
            cycleId: cycle.id,
            tenantId: cycle.tenantId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (due.length > 0) {
        log.info("subscription-grant sweep: processed due cycles", {
          cycles: due.length,
          grantedCredits,
          expiredCredits,
          failures,
          truncated: due.length >= MAX_CYCLES,
        });
      } else {
        log.info("subscription-grant sweep: no due cycles", {});
      }
    });
  };
}
