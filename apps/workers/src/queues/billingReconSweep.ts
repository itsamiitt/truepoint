// billingReconSweep.ts — the leader-locked daily credit-ledger reconciliation sweep (M11, ADR-0029). Asserts
// the ledger invariant per tenant: SUM(credit_ledger.delta) == tenants.reveal_credit_balance. A mismatch is
// DRIFT and is logged as an ops signal (ids + amounts only, non-PII). READ-ONLY — it corrects nothing; a real
// drift is a bug to investigate (a mutation that skipped its ledger entry), NOT something to auto-heal.
//
// DARK by default: register.ts only constructs + schedules it when BILLING_RECON_ENABLED is true. It stays
// inert until the historical backfill has brought PRE-ledger tenants to 0 drift — before the backfill every
// old tenant reads as fully drifted (its un-ledgered balance), which is expected noise, not a bug. Once
// enabled, a fully-ledgered tenant must read 0; any non-zero drift is a genuine alarm. Leader-locked so
// exactly one worker runs per tick.

import { platformBillingReadRepository, withPlatformReadTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const BILLING_RECON_SWEEP_QUEUE = "billing_recon_sweep";
const LEADER_KEY = "leader:billing_recon_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// Bound the report per tick — worst |drift| first; a persistent drift resurfaces next tick.
const MAX_DRIFT_ROWS = 500;

export type BillingReconSweepJobData = Record<string, never>;

/**
 * Build the sweep processor. Takes the Redis leader lock, reads the active tenants whose counter disagrees
 * with their credit-ledger sum (owner read; no audit row — automation, not a staff read), and logs each as a
 * drift alarm. Corrects nothing.
 */
export function makeProcessBillingReconSweep(redis: IORedis) {
  return async function processBillingReconSweep(
    _job: Job<BillingReconSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const drifted = await withPlatformReadTx((tx) =>
        platformBillingReadRepository.reconcileDrift(tx, MAX_DRIFT_ROWS),
      );
      // Ids + amounts only per row — never the tenant name in the ops signal (names are for the admin console).
      for (const d of drifted) {
        log.error("billing-recon: ledger drift", {
          tenantId: d.tenantId,
          counter: d.counter,
          ledgerSum: d.ledgerSum,
          drift: d.drift,
          entryCount: d.entryCount,
        });
      }
      if (drifted.length > 0) {
        log.error("billing-recon sweep: tenants with ledger drift", {
          count: drifted.length,
          truncated: drifted.length >= MAX_DRIFT_ROWS,
        });
      } else {
        log.info("billing-recon sweep: no ledger drift", { checked: "all active tenants" });
      }
    });
  };
}
