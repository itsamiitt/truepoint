// lowBalanceNotifierSweep.ts — the scheduled, leader-locked low-balance notifier (plans-pricing-credits 07 §9;
// G-NTF-1 producer). Once daily, a single worker reads the active tenants at/under the credit threshold (an
// owner-connection, non-PII aggregate) and creates ONE in-app `low_credits` notification for each tenant's
// OWNER — the customer-facing delivery channel the detector was waiting for. DEDUPED: a tenant whose owner
// still has an UNREAD low-credits note is skipped (no daily spam). READ-ONLY on money — it CHARGES and DELETES
// nothing. DARK by default: register.ts only constructs + schedules it when LOW_BALANCE_NOTIFIER_ENABLED is
// true. Leader-locked (mirrors the data-quality / retention sweeps) so exactly one worker runs per tick. The
// notification insert runs on the base owner connection (BYPASSRLS), like the Stripe grant path; best-effort
// per tenant — one failure never aborts the sweep.

import { env } from "@leadwolf/config";
import {
  db,
  notificationRepository,
  platformBillingReadRepository,
  withPlatformReadTx,
} from "@leadwolf/db";
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
 * Build the sweep processor. Takes the Redis leader lock, reads the active low-balance tenants (system-level,
 * non-PII owner read; no audit row — automation, not a privileged staff read), and creates a deduped
 * `low_credits` notification for each tenant's owner. Best-effort per tenant.
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
      let notified = 0;
      for (const t of tenants) {
        // Notify the tenant OWNER in the default workspace; skip tenants missing either target.
        const ownerUserId = t.ownerUserId;
        const workspaceId = t.defaultWorkspaceId;
        if (!ownerUserId || !workspaceId) continue;
        try {
          const created = await db.transaction(async (tx) => {
            // Dedup: skip while a prior low-credits note is still unread (avoids daily spam).
            if (
              await notificationRepository.existsUnreadOfType(
                tx,
                workspaceId,
                ownerUserId,
                "low_credits",
              )
            ) {
              return false;
            }
            await notificationRepository.create(tx, {
              tenantId: t.tenantId,
              workspaceId,
              userId: ownerUserId,
              type: "low_credits",
              title: "Credits running low",
              body: `${t.revealCreditBalance.toLocaleString()} credits left — top up to keep revealing.`,
            });
            return true;
          });
          if (created) notified += 1;
        } catch (e) {
          log.error("low-balance notifier: per-tenant notify failed", {
            tenantId: t.tenantId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (notified > 0) {
        log.info("low-balance notifier sweep: low_credits notifications created", {
          count: notified,
          threshold,
        });
      }
    });
  };
}
