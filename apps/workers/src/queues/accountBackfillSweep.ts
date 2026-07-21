// accountBackfillSweep.ts — S-A1/S-A3: the leader-locked account-backfill sweep (import-and-data-model-redesign
// 15 §M-SEQ seq 55/56, mechanics 15 §2.2; 06 S-A1/S-A3). The accounts sibling of channelBackfillSweep, at
// smaller scale (one row per domained account). Delivered as a run-to-completion job in the house
// one-shot-backfill idiom: a repeatable tick that processes a BOUNDED slice per tick until the fleet-wide
// missing set drains to zero, then no-ops forever (self-terminating — safe to leave scheduled while enabled).
// DARK by default: registered only when ACCOUNT_DOMAINS_DUAL_WRITE AND ACCOUNT_BACKFILL_ENABLED both read
// "true" (the backfill runs strictly after S-A2 dual-write is live — the S-CH3 train posture); WHICH tenants
// backfill is then decided per batch by the same `account_domains_dual_write` per-tenant flag the writers use,
// re-evaluated fail-closed at every batch boundary in core's runner (also the dynamic abort lever).
//
// Shape per tick (leader-locked — exactly one worker):
//   1. OWNER-conn census (non-PII ids only): workspaces still holding an account needing EITHER pass (missing
//      domain child OR missing hq location), capped.
//   2. Per workspace: core's runAccountBackfillForWorkspace — withTenantTx keyset batches (RLS ENFORCING;
//      never the owner conn for writes), N batches per pass per tick so a whale workspace drains across ticks
//      (resumable by construction: the WHERE-missing selection is the watermark). Best-effort per workspace —
//      one failure never aborts the tick; the census returns the workspace again next tick.
//   3. Publish counters + the gauges: `backfill_domain_remaining` (= THE S-A6/C2 gate, 15 §2.2 — C2 must not
//      activate until it reads 0 after the post-dual-write re-run) and `backfill_hq_remaining` (count-only).

import { env } from "@leadwolf/config";
import { accountChildRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";
import { incrementAccountCounter, setAccountGauge } from "../metrics.ts";

export const ACCOUNT_BACKFILL_SWEEP_QUEUE = "account_backfill_sweep";
const LEADER_KEY = "leader:account_backfill_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// Workspaces per tick — with the per-workspace batch bound this caps one tick's total work under the
// leader-lock TTL; the census only returns workspaces that STILL need a pass, so nothing starves.
const MAX_WORKSPACES_PER_TICK = 25;

export type AccountBackfillSweepJobData = Record<string, never>;

// Injected so the sweep is testable without the worker runtime (the makeProcess* house pattern).
type RunWorkspace = (
  scope: { tenantId: string; workspaceId: string },
  opts: { batchSize: number; maxBatches: number },
) => Promise<{
  domainsScanned: number;
  domainsCreated: number;
  domainConflicts: number;
  hqScanned: number;
  hqCreated: number;
  hqUnmapped: number;
  hqConflicts: number;
  domainBatches: number;
  hqBatches: number;
  drained: boolean;
  gateOff: boolean;
}>;

/**
 * Build the sweep processor. `runWorkspace` (= core's runAccountBackfillForWorkspace) is injected to keep the
 * module unit-testable and the core dep at the register.ts seam, like makeProcessChannelBackfillSweep.
 */
export function makeProcessAccountBackfillSweep(redis: IORedis, runWorkspace: RunWorkspace) {
  return async function processAccountBackfillSweep(
    _job: Job<AccountBackfillSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const workspaces =
        await accountChildRepository.listWorkspacesNeedingAccountBackfill(MAX_WORKSPACES_PER_TICK);
      if (workspaces.length === 0) {
        // Complete (for now — S-A2 traffic on a flag-off tenant can re-open the set; the re-run after
        // dual-write has been on everywhere is what closes the tail, 15 §2.2 / 14 conflict ⑤).
        setAccountGauge("backfill_domain_remaining", 0);
        setAccountGauge("backfill_hq_remaining", 0);
        log.info("account-backfill sweep: complete — no account needs a backfill pass", {});
        return;
      }
      let workspacesTouched = 0;
      let gateOffCount = 0;
      for (const scope of workspaces) {
        try {
          const res = await runWorkspace(scope, {
            batchSize: env.ACCOUNT_BACKFILL_BATCH_SIZE,
            maxBatches: env.ACCOUNT_BACKFILL_BATCHES_PER_TICK,
          });
          workspacesTouched += 1;
          if (res.gateOff) gateOffCount += 1;
          incrementAccountCounter("backfill_domains_scanned_total", res.domainsScanned);
          incrementAccountCounter("backfill_domains_created_total", res.domainsCreated);
          incrementAccountCounter("backfill_domain_conflicts_total", res.domainConflicts);
          incrementAccountCounter("backfill_hq_scanned_total", res.hqScanned);
          incrementAccountCounter("backfill_hq_created_total", res.hqCreated);
          incrementAccountCounter("backfill_hq_unmapped_total", res.hqUnmapped);
          incrementAccountCounter("backfill_hq_conflicts_total", res.hqConflicts);
          // Non-PII operational log per workspace (ids + counts only — never a value).
          log.info("account-backfill: workspace pass", {
            workspaceId: scope.workspaceId,
            domainsScanned: res.domainsScanned,
            domainsCreated: res.domainsCreated,
            domainConflicts: res.domainConflicts,
            hqScanned: res.hqScanned,
            hqCreated: res.hqCreated,
            hqUnmapped: res.hqUnmapped,
            hqConflicts: res.hqConflicts,
            drained: res.drained,
            gateOff: res.gateOff,
          });
        } catch (e) {
          // Best-effort per workspace: the batch tx already rolled back atomically (no half-written account);
          // the census re-surfaces this workspace next tick.
          log.error("account-backfill: workspace pass failed", {
            workspaceId: scope.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // The completeness numbers, fleet-wide (owner-conn counts) — recomputed once per tick.
      try {
        const domainRemaining = await accountChildRepository.countAccountsMissingDomainChild();
        const hqRemaining = await accountChildRepository.countAccountsMissingHqLocation();
        setAccountGauge("backfill_domain_remaining", domainRemaining); // THE S-A6/C2 gate
        setAccountGauge("backfill_hq_remaining", hqRemaining); // count-only
        log.info("account-backfill sweep: tick done", {
          workspaces: workspacesTouched,
          gateOff: gateOffCount,
          domainRemaining,
          hqRemaining,
        });
      } catch (e) {
        log.error("account-backfill sweep: completeness count failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
  };
}
