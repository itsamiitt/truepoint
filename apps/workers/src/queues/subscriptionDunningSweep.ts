// subscriptionDunningSweep.ts — the leader-locked daily dunning grace-SUSPEND sweep for subscriptions (M11
// subs, ADR-0041). STRIPE drives the payment retries + hosted dunning (the customer cures a failed payment via
// Stripe's emailed hosted-invoice link, NOT inside the app — so a suspension never traps them). This sweep is
// the account-side consequence: a subscription that has stayed past_due beyond a generous grace window means the
// tenant is suspended (transparent + non-punitive, ADR-0012). The suspension is REVERSIBLE and tagged
// suspension_reason='dunning' — the subscription webhook AUTO-LIFTS it the moment payment resumes (or the
// subscription cancels to free). It touches ONLY tenants that are currently ACTIVE, so a staff suspension is
// never clobbered and is never auto-lifted (that stays a human decision).
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
// A generous, non-punitive grace window (ADR-0012): suspend only after a subscription has been past_due this
// long beyond its period end — well after Stripe's own retry schedule has run.
const GRACE_DAYS = 14;
const MAX_ROWS = 500;

export type SubscriptionDunningSweepJobData = Record<string, never>;

/** Build the sweep processor. Takes the Redis leader lock, reads (owner path) the subscriptions past_due beyond
 *  the grace window, and suspends each tenant that is still active — reversibly (tagged 'dunning'), one
 *  per-tenant tx so a single failure doesn't block the rest. */
export function makeProcessSubscriptionDunningSweep(redis: IORedis) {
  return async function processSubscriptionDunningSweep(
    _job: Job<SubscriptionDunningSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const delinquent = await db.transaction((tx) =>
        subscriptionRepository.pastDueBeyondGrace(tx, GRACE_DAYS, MAX_ROWS),
      );
      let suspended = 0;
      let failures = 0;

      for (const s of delinquent) {
        try {
          // Suspend ONLY if still active (suspendForDunning's WHERE guard) — a staff suspension or an already-
          // suspended tenant is left untouched. Reversible: the webhook auto-lifts it when payment resumes.
          const touched = await db.transaction((tx) =>
            subscriptionRepository.suspendForDunning(tx, s.tenantId),
          );
          if (touched > 0) {
            suspended += 1;
            log.warn("subscription-dunning: suspended for non-payment", {
              subscriptionId: s.id,
              tenantId: s.tenantId,
              periodEnd: s.currentPeriodEnd?.toISOString() ?? null,
              graceDays: GRACE_DAYS,
            });
          }
        } catch (err) {
          failures += 1;
          log.error("subscription-dunning: suspend failed", {
            subscriptionId: s.id,
            tenantId: s.tenantId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (delinquent.length > 0) {
        log.warn("subscription-dunning sweep: processed delinquents", {
          delinquent: delinquent.length,
          suspended,
          failures,
          graceDays: GRACE_DAYS,
          truncated: delinquent.length >= MAX_ROWS,
        });
      } else {
        log.info("subscription-dunning sweep: none delinquent", {});
      }
    });
  };
}
