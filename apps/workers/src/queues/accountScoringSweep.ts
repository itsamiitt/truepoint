// accountScoringSweep.ts — the leader-locked account-rescore sweep (market-intelligence MI-S4;
// outcomes S-01/S-02). Event-driven: an account is rescored when a SIGNAL was delivered to it since the
// watermark — fit inputs change slowly and get picked up on the same ride. The signalFanout sibling:
// same watermark discipline (absent ⇒ claim NOW, no storm of historical rescores — harmless here but
// wasteful), same census pattern (owner-conn ids only, per-workspace withTenantTx work).
//
// DARK by default: registered only when ACCOUNT_SCORING_ENABLED reads "true".

import { env } from "@leadwolf/config";
import { accountScoreRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const ACCOUNT_SCORING_SWEEP_QUEUE = "account_scoring_sweep";
const LEADER_KEY = "leader:account_scoring_sweep";
const LEADER_TTL_MS = 10 * 60_000;
const WATERMARK_KEY = "account_scoring_sweep:watermark";
const MAX_WORKSPACES_PER_TICK = 100;
const MAX_ACCOUNTS_PER_WORKSPACE = 200;

export type AccountScoringSweepJobData = Record<string, never>;

// Injected runner — unit-testable, core dep at the register.ts seam.
type ScoreAccount = (input: {
  scope: { tenantId: string; workspaceId: string };
  accountId: string;
}) => Promise<unknown>;
type ListAccounts = (
  scope: { tenantId: string; workspaceId: string },
  since: Date,
  limit: number,
) => Promise<string[]>;

export function makeProcessAccountScoringSweep(
  redis: IORedis,
  scoreAccount: ScoreAccount,
  listAccounts: ListAccounts,
) {
  return async function processAccountScoringSweep(
    _job: Job<AccountScoringSweepJobData>,
  ): Promise<void> {
    if (!env.ACCOUNT_SCORING_ENABLED) return;

    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const tickStart = new Date();
      const stored = await redis.get(WATERMARK_KEY);
      if (!stored) {
        await redis.set(WATERMARK_KEY, tickStart.toISOString());
        return;
      }
      const since = new Date(stored);

      const workspaces = await accountScoreRepository.listWorkspacesWithNewSignals(
        since,
        MAX_WORKSPACES_PER_TICK,
      );
      if (workspaces.length === 0) {
        await redis.set(WATERMARK_KEY, tickStart.toISOString());
        return;
      }

      let allDrained = workspaces.length < MAX_WORKSPACES_PER_TICK;
      let rescored = 0;
      for (const scope of workspaces) {
        try {
          const accountIds = await listAccounts(scope, since, MAX_ACCOUNTS_PER_WORKSPACE);
          if (accountIds.length >= MAX_ACCOUNTS_PER_WORKSPACE) allDrained = false;
          for (const accountId of accountIds) {
            await scoreAccount({ scope, accountId });
            rescored += 1;
          }
        } catch (e) {
          allDrained = false;
          log.error("account-scoring sweep: workspace pass failed", {
            workspaceId: scope.workspaceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (allDrained) await redis.set(WATERMARK_KEY, tickStart.toISOString());
      log.info("account-scoring sweep: tick done", {
        since: since.toISOString(),
        workspaces: workspaces.length,
        rescored,
        drained: allDrained,
      });
    });
  };
}
