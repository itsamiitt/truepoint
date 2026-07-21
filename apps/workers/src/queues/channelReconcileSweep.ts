// channelReconcileSweep.ts — S-CH5: the leader-locked PERMANENT channel reconcile / drift sweep
// (import-and-data-model-redesign 05 §3.4/§5; 15 §M-SEQ seq 48 / §3 "permanent fixtures"). The final step of
// the channel train (S-CH1..S-CH5). It is the SAME leader-locked, env-gated, per-workspace-fan-out shape as
// the S-CH3 channelBackfillSweep — but it NEVER retires (05 §5): where the backfill self-terminates once the
// completeness census drains, this holds CH-INV-1 at drift = 0 forever (post-cutover especially, where
// child-first writers make the flat cache the thing that can drift).
//
// DARK by default: registered only when CHANNEL_DUAL_WRITE AND CHANNEL_RECONCILE_ENABLED both read "true" (a
// reconcile is meaningful only where child rows are maintained — the S-CH3 env-pair posture). WHICH tenants
// reconcile, and in WHICH repair DIRECTION, is decided per batch in core's runner: the `channels_dual_write`
// gate selects the tenant + is the dynamic abort (fail-closed), and the READ gate (`CHANNEL_READ_FROM_CHILD`
// + `channels_read`) picks the phase-dependent direction — flat-wins while reads are still flat, child-wins
// after cutover (05 §3.4 "the job never guesses").
//
// Shape per tick (leader-locked — exactly one worker):
//   1. OWNER-conn census (non-PII ids only): workspaces still holding a drifting contact, capped.
//   2. Per workspace: core's runChannelReconcileForWorkspace — withTenantTx keyset batches (RLS ENFORCING;
//      never the owner conn for writes), N batches per tick so a whale's residual drift drains across ticks
//      (resumable — the WHERE-drift selection is the watermark). Best-effort per workspace.
//   3. Publish counters + the `drift_remaining` gauge (05 §Success: target 0 after burn-in; > 0 = the S2
//      alert, runbook §K). A spike is the writer-bug signature (05 §worst-case).

import { env } from "@leadwolf/config";
import { contactChannelRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";
import { incrementChannelCounter, setChannelGauge } from "../metrics.ts";

export const CHANNEL_RECONCILE_SWEEP_QUEUE = "channel_reconcile_sweep";
const LEADER_KEY = "leader:channel_reconcile_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// Workspaces per tick — with the per-workspace batch bound this caps one tick's work under the leader TTL;
// the census only returns workspaces that STILL drift, so nothing starves.
const MAX_WORKSPACES_PER_TICK = 25;

export type ChannelReconcileSweepJobData = Record<string, never>;

// Injected so the sweep is testable without the worker runtime (the makeProcess* house pattern).
type RunWorkspace = (
  scope: { tenantId: string; workspaceId: string },
  opts: { batchSize: number; maxBatches: number },
) => Promise<{
  scanned: number;
  detected: number;
  emailsRepaired: number;
  phonesRepaired: number;
  flatWins: number;
  childWins: number;
  skipped: number;
  batches: number;
  drained: boolean;
  gateOff: boolean;
  readGateOn: boolean;
}>;

/**
 * Build the sweep processor. `runWorkspace` (= core's runChannelReconcileForWorkspace) is injected to keep the
 * module unit-testable and the core dep at the register.ts seam, like makeProcessChannelBackfillSweep.
 */
export function makeProcessChannelReconcileSweep(redis: IORedis, runWorkspace: RunWorkspace) {
  return async function processChannelReconcileSweep(
    _job: Job<ChannelReconcileSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const workspaces =
        await contactChannelRepository.listWorkspacesWithChannelDrift(MAX_WORKSPACES_PER_TICK);
      if (workspaces.length === 0) {
        setChannelGauge("drift_remaining", 0);
        log.info("channel-reconcile sweep: no drift — CH-INV-1 holds fleet-wide", {});
        return;
      }
      let workspacesTouched = 0;
      let gateOffCount = 0;
      for (const scope of workspaces) {
        try {
          const res = await runWorkspace(scope, {
            batchSize: env.CHANNEL_RECONCILE_BATCH_SIZE,
            maxBatches: env.CHANNEL_RECONCILE_BATCHES_PER_TICK,
          });
          workspacesTouched += 1;
          if (res.gateOff) gateOffCount += 1;
          incrementChannelCounter("drift_detected_total", res.detected);
          // Direction-labelled repair counters (the zero-dep renderer has no label support, so the direction
          // is encoded in the name — the backfill_* precedent).
          if (res.flatWins > 0) incrementChannelCounter("drift_repaired_flat_total", res.flatWins);
          if (res.childWins > 0) incrementChannelCounter("drift_repaired_child_total", res.childWins);
          if (res.skipped > 0) incrementChannelCounter("drift_skipped_total", res.skipped);
          // Non-PII operational log per workspace (ids + counts only — never a value).
          log.info("channel-reconcile: workspace pass", {
            workspaceId: scope.workspaceId,
            scanned: res.scanned,
            emailsRepaired: res.emailsRepaired,
            phonesRepaired: res.phonesRepaired,
            flatWins: res.flatWins,
            childWins: res.childWins,
            skipped: res.skipped,
            batches: res.batches,
            drained: res.drained,
            gateOff: res.gateOff,
            direction: res.readGateOn ? "child_wins" : "flat_wins",
          });
        } catch (e) {
          // Best-effort per workspace: the batch tx already rolled back atomically (no half-repaired
          // contact); the census re-surfaces this workspace next tick.
          log.error("channel-reconcile: workspace pass failed", {
            workspaceId: scope.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // The fleet-wide drift gauge (owner-conn count) — recomputed once per tick. THIS is the S2 alert signal.
      try {
        const remaining = await contactChannelRepository.countContactsWithChannelDrift();
        setChannelGauge("drift_remaining", remaining);
        log.info("channel-reconcile sweep: tick done", {
          workspaces: workspacesTouched,
          gateOff: gateOffCount,
          remaining,
        });
      } catch (e) {
        log.error("channel-reconcile sweep: drift count failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
  };
}
