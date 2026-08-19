// signalFanout.ts — the leader-locked signal fan-out sweep (market-intelligence MI-S6;
// docs/planning/market-intelligence/06-architecture.md §2). Outcomes: [S-13][S-09].
//
// The DISTRIBUTION step for company-subject signals, the jobChangeSweep sibling: a fact recorded once in
// master_signals (exec_hired, headcount_surge, funding_round when its producer exists) reaching every
// workspace that holds a bridged account — as a tenant_signals row the feed, scoring and alerts read
// under RLS. Person-subject signals are NOT handled here; job_change already has its own sweep.
//
// DARK by default: registered only when SIGNAL_FANOUT_ENABLED reads "true".
//
// Shape per tick (leader-locked — one worker, one watermark writer):
//   1. Redis watermark on master_signals.recorded_at. ABSENT ⇒ claim NOW, fan out nothing — the same
//      alert-storm defence as jobChangeSweep: a missed historical signal is repaired by the next one,
//      a storm of stale deliveries teaches users to ignore the feed permanently.
//   2. OWNER-conn census: new company signals since the watermark (capped), then the workspaces holding
//      any bridged account (ids only — the C-02 boundary).
//   3. Per workspace: core's fanoutSignalsToWorkspace — one withTenantTx, RLS ENFORCING, redelivery
//      collapsing on the (workspace, master_signal_id) unique wall.
//   4. Advance the watermark ONLY on a fully drained tick (signal page not full, every workspace pass
//      succeeded) so a partial pass is re-censused rather than dropped.

import { env } from "@leadwolf/config";
import { type FanoutSignal, signalFanoutRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const SIGNAL_FANOUT_QUEUE = "signal_fanout";
const LEADER_KEY = "leader:signal_fanout";
const LEADER_TTL_MS = 10 * 60_000;
/** Redis key holding the ISO recorded_at through which company signals have been fanned out. */
const WATERMARK_KEY = "signal_fanout:watermark";
// Signals per tick. A full page means more may remain, so the watermark holds and the next tick continues.
const MAX_SIGNALS_PER_TICK = 500;
// Workspaces per tick — bounds one tick's tenant transactions under the leader TTL.
const MAX_WORKSPACES_PER_TICK = 200;

export type SignalFanoutJobData = Record<string, never>;

// Injected like jobChangeSweep's runner: unit-testable without the worker runtime, core dep at register.ts.
type RunWorkspace = (
  scope: { tenantId: string; workspaceId: string },
  signals: readonly FanoutSignal[],
) => Promise<{ offered: number; delivered: number }>;

export function makeProcessSignalFanout(redis: IORedis, runWorkspace: RunWorkspace) {
  return async function processSignalFanout(_job: Job<SignalFanoutJobData>): Promise<void> {
    if (!env.SIGNAL_FANOUT_ENABLED) return;

    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const tickStart = new Date();

      const stored = await redis.get(WATERMARK_KEY);
      if (!stored) {
        await redis.set(WATERMARK_KEY, tickStart.toISOString());
        log.info("signal fan-out: watermark initialised, no fan-out this tick", {
          watermark: tickStart.toISOString(),
        });
        return;
      }
      const since = new Date(stored);

      const signals = await signalFanoutRepository.listNewCompanySignals(
        since,
        MAX_SIGNALS_PER_TICK,
      );
      if (signals.length === 0) {
        await redis.set(WATERMARK_KEY, tickStart.toISOString());
        return;
      }

      const companyIds = [...new Set(signals.map((s) => s.masterCompanyId))];
      const workspaces = await signalFanoutRepository.listWorkspacesForCompanies(
        companyIds,
        MAX_WORKSPACES_PER_TICK,
      );

      // A capped signal page means unseen signals remain past the page's recorded_at — never advance
      // beyond what was actually censused.
      let allDrained = signals.length < MAX_SIGNALS_PER_TICK;
      let totalDelivered = 0;

      for (const scope of workspaces) {
        try {
          const res = await runWorkspace(scope, signals);
          totalDelivered += res.delivered;
        } catch (e) {
          allDrained = false;
          log.error("signal fan-out: workspace pass failed", {
            workspaceId: scope.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (allDrained) {
        await redis.set(WATERMARK_KEY, tickStart.toISOString());
      }
      // Non-PII operational log: counts and ids only.
      log.info("signal fan-out: tick done", {
        since: since.toISOString(),
        signals: signals.length,
        companies: companyIds.length,
        workspaces: workspaces.length,
        delivered: totalDelivered,
        drained: allDrained,
      });
    });
  };
}
