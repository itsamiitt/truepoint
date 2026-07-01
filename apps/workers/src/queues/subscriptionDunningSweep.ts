// subscriptionDunningSweep.ts — the leader-locked daily dunning SIGNAL for subscriptions (M11 subs, ADR-0041).
// STRIPE drives the actual dunning: it retries the failed payment per its billing settings and, if it ultimately
// gives up, emits customer.subscription.deleted → our webhook reverts the tenant to the free plan (losing the
// perishable allotment, keeping purchased credits). This sweep is READ-ONLY: it surfaces subscriptions that have
// been past_due beyond a grace window as an ops signal (ids only, non-PII) for human follow-up. It SUSPENDS
// NOTHING — the suspend policy (ADR-0012: transparent + non-punitive) is a flagged owner decision; until it's
// made, no auto-suspend strands a paying customer or conflates with a staff suspension.
//
// DARK by default: register.ts only builds + schedules it when BILLING_SUBSCRIPTIONS_ENABLED is true.
// Leader-locked so exactly one worker runs per tick.

import { db, subscriptionRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const SUBSCRIPTION_DUNNING_SWEEP_QUEUE = "subscription_dunning_sweep";
const LEADER_KEY = "leader:subscription_dunning_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// A generous, non-punitive grace window (ADR-0012): only surface subscriptions past_due well beyond their period.
const GRACE_DAYS = 14;
const MAX_ROWS = 500;

export type SubscriptionDunningSweepJobData = Record<string, never>;

/** Build the sweep processor. Takes the Redis leader lock, reads (owner path) the subscriptions that have been
 *  past_due beyond the grace window, and logs each as a dunning signal. Corrects nothing. */
export function makeProcessSubscriptionDunningSweep(redis: IORedis) {
  return async function processSubscriptionDunningSweep(
    _job: Job<SubscriptionDunningSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const delinquent = await db.transaction((tx) =>
        subscriptionRepository.pastDueBeyondGrace(tx, GRACE_DAYS, MAX_ROWS),
      );
      for (const s of delinquent) {
        log.warn("subscription-dunning: past_due beyond grace", {
          subscriptionId: s.id,
          tenantId: s.tenantId,
          periodEnd: s.currentPeriodEnd?.toISOString() ?? null,
          graceDays: GRACE_DAYS,
        });
      }
      if (delinquent.length > 0) {
        log.warn("subscription-dunning sweep: delinquent subscriptions", {
          count: delinquent.length,
          truncated: delinquent.length >= MAX_ROWS,
        });
      } else {
        log.info("subscription-dunning sweep: none delinquent", {});
      }
    });
  };
}
