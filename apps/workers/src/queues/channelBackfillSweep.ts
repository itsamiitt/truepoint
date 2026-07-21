// channelBackfillSweep.ts — S-CH3: the leader-locked channel-backfill sweep (import-and-data-model-redesign
// 15 §M-SEQ seq 46, mechanics 15 §2.1; 05 S-CH3 row). Delivered as a run-to-completion job in the house
// one-shot-backfill idiom (the ledgerBackfillSweep precedent): a repeatable tick that processes a BOUNDED
// slice per tick until the fleet-wide missing set drains to zero, then no-ops forever (self-terminating —
// safe to leave scheduled while enabled). DARK by default: registered only when CHANNEL_DUAL_WRITE AND
// CHANNEL_BACKFILL_ENABLED both read "true" (S-CH3 runs strictly after S-CH2 in the rollout train); WHICH
// tenants backfill is then decided per batch by the same `channels_dual_write` per-tenant flag the writers
// use, re-evaluated fail-closed at every batch boundary in core's runner (also the dynamic abort lever).
//
// Shape per tick (leader-locked — exactly one worker):
//   1. OWNER-conn census (non-PII ids only, the listWorkspacesWithUnresolvedContacts precedent): workspaces
//      still holding contacts missing a child projection, capped.
//   2. Per workspace: core's runChannelBackfillForWorkspace — withTenantTx keyset batches (RLS ENFORCING;
//      never the owner conn for writes), N batches per tick so a whale workspace drains across ticks
//      (resumable by construction: the WHERE-missing selection is the watermark). Best-effort per workspace
//      — one failure never aborts the tick; the census returns the workspace again next tick.
//   3. Publish counters + the `backfill_remaining` gauge (= the S-CH4 completeness number, 15 §2.1's gate:
//      S-CH4 does not flip until it reads 0 after the post-dual-write re-run).
//
// Bounds: ≤ MAX_WORKSPACES_PER_TICK × CHANNEL_BACKFILL_BATCHES_PER_TICK × CHANNEL_BACKFILL_BATCH_SIZE
// contacts per tick (default 25×10×1000 = 250k selections, comfortably inside LEADER_TTL_MS — decrypt+insert
// per contact is sub-millisecond; the lock has no renewal, so the bound is the guarantee).

import { env } from "@leadwolf/config";
import { contactChannelRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";
import { incrementChannelCounter, setChannelGauge } from "../metrics.ts";

export const CHANNEL_BACKFILL_SWEEP_QUEUE = "channel_backfill_sweep";
const LEADER_KEY = "leader:channel_backfill_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// Workspaces per tick — with the per-workspace batch bound this caps one tick's total work under the
// leader-lock TTL; the census only returns workspaces that STILL have missing contacts, so nothing starves.
const MAX_WORKSPACES_PER_TICK = 25;

export type ChannelBackfillSweepJobData = Record<string, never>;

// Injected so the sweep is testable without the worker runtime (the makeProcess* house pattern).
type RunWorkspace = (
  scope: { tenantId: string; workspaceId: string },
  opts: { batchSize: number; maxBatches: number },
) => Promise<{
  scanned: number;
  emailsCreated: number;
  phonesCreated: number;
  phonesUnparseable: number;
  conflictsSkipped: number;
  contactsSkipped: number;
  gradesSanitized: number;
  batches: number;
  drained: boolean;
  gateOff: boolean;
}>;

/**
 * Build the sweep processor. `runWorkspace` (= core's runChannelBackfillForWorkspace) is injected to keep
 * the module unit-testable and the core dep at the register.ts seam, like makeProcessMasterBackfillSweep.
 */
export function makeProcessChannelBackfillSweep(redis: IORedis, runWorkspace: RunWorkspace) {
  return async function processChannelBackfillSweep(
    _job: Job<ChannelBackfillSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const workspaces =
        await contactChannelRepository.listWorkspacesMissingChannelProjection(
          MAX_WORKSPACES_PER_TICK,
        );
      if (workspaces.length === 0) {
        // Complete (for now — S-CH2 traffic on a flag-off tenant can re-open the set; the re-run after
        // dual-write has been on everywhere is what closes the tail, 05 §Implementation ordering note).
        setChannelGauge("backfill_remaining", 0);
        log.info("channel-backfill sweep: complete — no contacts missing a channel projection", {});
        return;
      }
      let workspacesTouched = 0;
      let gateOffCount = 0;
      for (const scope of workspaces) {
        try {
          const res = await runWorkspace(scope, {
            batchSize: env.CHANNEL_BACKFILL_BATCH_SIZE,
            maxBatches: env.CHANNEL_BACKFILL_BATCHES_PER_TICK,
          });
          workspacesTouched += 1;
          if (res.gateOff) gateOffCount += 1;
          incrementChannelCounter("backfill_contacts_total", res.scanned);
          incrementChannelCounter("backfill_emails_total", res.emailsCreated);
          incrementChannelCounter("backfill_phones_total", res.phonesCreated);
          incrementChannelCounter("backfill_phone_unparseable_total", res.phonesUnparseable);
          incrementChannelCounter("backfill_conflicts_total", res.conflictsSkipped);
          incrementChannelCounter("backfill_skipped_total", res.contactsSkipped);
          // Non-PII operational log per workspace (ids + counts only — never a value).
          log.info("channel-backfill: workspace pass", {
            workspaceId: scope.workspaceId,
            scanned: res.scanned,
            emails: res.emailsCreated,
            phones: res.phonesCreated,
            unparseable: res.phonesUnparseable,
            conflicts: res.conflictsSkipped,
            skipped: res.contactsSkipped,
            sanitized: res.gradesSanitized,
            batches: res.batches,
            drained: res.drained,
            gateOff: res.gateOff,
          });
        } catch (e) {
          // Best-effort per workspace: the batch tx already rolled back atomically (no half-projected
          // contact); the census re-surfaces this workspace next tick.
          log.error("channel-backfill: workspace pass failed", {
            workspaceId: scope.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // The S-CH4 completeness number, fleet-wide (owner-conn count) — recomputed once per tick.
      try {
        const remaining = await contactChannelRepository.countContactsMissingChannelProjection();
        setChannelGauge("backfill_remaining", remaining);
        log.info("channel-backfill sweep: tick done", {
          workspaces: workspacesTouched,
          gateOff: gateOffCount,
          remaining,
        });
      } catch (e) {
        log.error("channel-backfill sweep: completeness count failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
  };
}
