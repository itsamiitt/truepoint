// jobChangeSweep.ts — the leader-locked S-13 job-change fan-out sweep (intelligence-platform
// 07 §4 slice 7.1; outcomes S-09 "has this person left", S-13 "fast detection of job changes on saved
// contacts", S-14 "successor"). The DISTRIBUTION step of the contribution lifecycle: a fact learned once in
// the shared graph reaching every tenant holding the affected person.
//
// Everything it decides with already shipped and is tested — detectJobChange (the judgement) and
// recordJobChange (the signal + the watcher alert). This file is the trigger those two never had: before it,
// the whole stack existed and nothing called it, so S-13's "time between a contact changing jobs and the
// seller learning about it" was unbounded.
//
// DARK by default: registered only when JOB_CHANGE_SWEEP_ENABLED reads "true". When off, nothing is built.
//
// Shape per tick (leader-locked — exactly one worker, so the watermark has a single writer):
//   1. Read the watermark from Redis. ABSENT ⇒ start at NOW, never at the epoch — see the storm note below.
//   2. OWNER-conn census (non-PII ids only, capped): workspaces holding a contact whose Layer-0 primary
//      employment edge moved since the watermark.
//   3. OWNER-conn read of the Layer-0 employment facts for those people (master_employment is REVOKE'd from
//      leadwolf_app, so it cannot be joined inside a tenant tx — the facts are carried across instead).
//   4. Per workspace: core's runJobChangeSweepForWorkspace — withTenantTx keyset batches, RLS ENFORCING.
//   5. Advance the watermark to the tick's start, and publish counters.
//
// THE ALERT-STORM DEFENCE, and why the failure direction is deliberate. recordJobChange dedups notifications
// per (user, contact) but nothing bounds a FIRST run that sees every historical change at once. The watermark
// is that bound. So when the watermark is missing — first deploy, or a Redis loss — this starts at NOW rather
// than replaying history. That MISSES changes that happened while the watermark was gone, and that is the
// correct trade: a missed change is repaired by the next change on that person, while a storm of stale alerts
// teaches every user to ignore the notification permanently. An alert users learn to ignore has negative
// value, which is the same reasoning jobChange.shouldAlert uses to stay silent on title changes.

import { env } from "@leadwolf/config";
import { jobChangeSweepRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const JOB_CHANGE_SWEEP_QUEUE = "job_change_sweep";
const LEADER_KEY = "leader:job_change_sweep";
const LEADER_TTL_MS = 10 * 60_000;
/** Redis key holding the ISO timestamp through which employment changes have been fanned out. */
const WATERMARK_KEY = "job_change_sweep:watermark";
// Workspaces per tick — with the per-workspace batch bound this caps one tick's work under the leader TTL.
// The census only returns workspaces that changed since the watermark, so nothing starves.
const MAX_WORKSPACES_PER_TICK = 25;
// Distinct people per tick. Bounds both the owner-conn fact read and the `= ANY(...)` array the tenant read
// carries; the watermark does NOT advance past what was actually processed, so the remainder is not lost.
const MAX_PEOPLE_PER_TICK = 500;

export type JobChangeSweepJobData = Record<string, never>;

// Injected so the sweep is unit-testable without the worker runtime, and so the core dep sits at the
// register.ts seam — the makeProcess* house pattern.
type RunWorkspace = (
  scope: { tenantId: string; workspaceId: string },
  observed: ReadonlyMap<string, import("@leadwolf/db").ObservedEmployment>,
  opts: { batchSize: number; maxBatches: number },
) => Promise<{
  scanned: number;
  detected: number;
  notified: number;
  batches: number;
  drained: boolean;
}>;

export function makeProcessJobChangeSweep(redis: IORedis, runWorkspace: RunWorkspace) {
  return async function processJobChangeSweep(_job: Job<JobChangeSweepJobData>): Promise<void> {
    if (!env.JOB_CHANGE_SWEEP_ENABLED) return;

    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      // Captured BEFORE any work so a change landing mid-tick is picked up next tick rather than skipped.
      const tickStart = new Date();

      const stored = await redis.get(WATERMARK_KEY);
      if (!stored) {
        // First run (or a Redis loss): claim NOW and fan out nothing. See the storm note in the header —
        // starting at the epoch here is the one change that could burn S-13's alert permanently.
        await redis.set(WATERMARK_KEY, tickStart.toISOString());
        log.info("job-change sweep: watermark initialised, no fan-out this tick", {
          watermark: tickStart.toISOString(),
        });
        return;
      }
      const since = new Date(stored);

      const workspaces = await jobChangeSweepRepository.listWorkspacesWithEmploymentChanges(
        since,
        MAX_WORKSPACES_PER_TICK,
      );
      if (workspaces.length === 0) {
        await redis.set(WATERMARK_KEY, tickStart.toISOString());
        log.info("job-change sweep: no employment changes since watermark", {
          since: since.toISOString(),
        });
        return;
      }

      let workspacesTouched = 0;
      let totalDetected = 0;
      let totalNotified = 0;
      let allDrained = true;

      for (const scope of workspaces) {
        try {
          // Per-workspace so one tenant's people never leak into another's read set. The census already
          // proved this workspace has at least one; RLS bounds the tenant side regardless.
          const observed = await jobChangeSweepRepository.loadObservedEmploymentForWorkspace(
            scope,
            since,
            MAX_PEOPLE_PER_TICK,
          );
          if (observed.size === 0) continue;

          const res = await runWorkspace(scope, observed, {
            batchSize: env.JOB_CHANGE_SWEEP_BATCH_SIZE,
            maxBatches: env.JOB_CHANGE_SWEEP_BATCHES_PER_TICK,
          });
          workspacesTouched += 1;
          totalDetected += res.detected;
          totalNotified += res.notified;
          if (!res.drained) allDrained = false;

          // Non-PII operational log: ids + counts only, never a name or a value.
          log.info("job-change sweep: workspace pass", {
            workspaceId: scope.workspaceId,
            people: observed.size,
            scanned: res.scanned,
            detected: res.detected,
            notified: res.notified,
            batches: res.batches,
            drained: res.drained,
          });
        } catch (e) {
          // Best-effort per workspace: the batch tx rolled back atomically. Holding the watermark back below
          // is what guarantees this workspace is retried rather than skipped.
          allDrained = false;
          log.error("job-change sweep: workspace pass failed", {
            workspaceId: scope.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Advance ONLY on a fully drained tick. A partial pass — a capped workspace, a failed one — leaves the
      // watermark where it was so the remainder is re-censused next tick. The cost is re-processing some
      // already-fanned-out people, which recordJobChange's per-(user, contact) notification dedup absorbs;
      // the alternative is silently dropping a job change, which is the outcome S-13 exists to prevent.
      if (allDrained) {
        await redis.set(WATERMARK_KEY, tickStart.toISOString());
      }
      log.info("job-change sweep: tick done", {
        workspaces: workspacesTouched,
        detected: totalDetected,
        notified: totalNotified,
        watermarkAdvanced: allDrained,
      });
    });
  };
}
