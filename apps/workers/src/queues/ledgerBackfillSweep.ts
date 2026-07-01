// ledgerBackfillSweep.ts — the one-time historical credit-ledger backfill (M11, ADR-0029), delivered as a
// leader-locked, self-terminating sweep. Each tick claims a bounded batch of active tenants that carry no
// `opening_balance:<id>` marker and backfills each in its OWN owner-path tx: reconstruct grant/spend entries
// from purchases/contact_reveals (idempotent — live post-ledger entries are left untouched), then post one
// `opening_balance` adjustment that absorbs the un-reconstructable residual so SUM(delta) == counter. The
// opening_balance row is also the "done" marker, so once every tenant has one the sweep no-ops (self-
// terminating — safe to leave scheduled). DARK by default (BILLING_LEDGER_BACKFILL_ENABLED): enable it, let it
// drain, confirm 0 drift via billing-recon, then it can stay off. Leader-locked so exactly one worker runs.

import { creditRepository, db, withPlatformReadTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const LEDGER_BACKFILL_SWEEP_QUEUE = "ledger_backfill_sweep";
const LEADER_KEY = "leader:ledger_backfill_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// Tenants backfilled per tick — bounded so one tick's per-tenant txs stay well-behaved; the rest drain next tick.
const BATCH = 100;

export type LedgerBackfillSweepJobData = Record<string, never>;

/**
 * Build the sweep processor. Takes the leader lock, reads the next batch of un-backfilled tenants (owner read),
 * and backfills each in its own owner tx. Best-effort per tenant — one failure never aborts the batch.
 */
export function makeProcessLedgerBackfillSweep(redis: IORedis) {
  return async function processLedgerBackfillSweep(
    _job: Job<LedgerBackfillSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const tenantIds = await withPlatformReadTx((tx) =>
        creditRepository.tenantsNeedingLedgerBackfill(tx, BATCH),
      );
      if (tenantIds.length === 0) {
        log.info("ledger-backfill sweep: complete — all active tenants backfilled", {});
        return;
      }
      let backfilled = 0;
      for (const tenantId of tenantIds) {
        try {
          const { residual } = await db.transaction((tx) =>
            creditRepository.backfillTenantLedger(tx, tenantId),
          );
          backfilled += 1;
          // residual != 0 is expected (it absorbs pre-ledger history); log it for the audit trail.
          log.info("ledger-backfill: tenant backfilled", { tenantId, residual });
        } catch (e) {
          log.error("ledger-backfill: tenant failed", {
            tenantId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      log.info("ledger-backfill sweep: batch done", {
        backfilled,
        batch: tenantIds.length,
        more: tenantIds.length >= BATCH,
      });
    });
  };
}
