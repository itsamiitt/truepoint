// marketRollupSweep.ts — the daily market-segment rollup rebuild (market-intelligence MI-S7;
// outcomes S-01/S-02). One leader-locked full-window rebuild: DELETE + INSERT..SELECT in one owner-conn
// transaction (the repository documents why the owner conn — er stays never-DELETE). Failure mode is a
// STALE board, never a wrong-tenant number: the table holds non-PII graph aggregates only.
//
// Revisit trigger (06-architecture §4): rebuild runtime > 15 min or board p95 > 1s for two consecutive
// weeks → evaluate a columnar store. The runtime is logged on every tick for exactly that watch.
//
// DARK by default: registered only when MARKET_ROLLUPS_ENABLED reads "true".

import { env } from "@leadwolf/config";
import { marketRollupRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const MARKET_ROLLUP_SWEEP_QUEUE = "market_rollup_sweep";
const LEADER_KEY = "leader:market_rollup_sweep";
const LEADER_TTL_MS = 20 * 60_000;
const WINDOW_MONTHS = 12;

export type MarketRollupSweepJobData = Record<string, never>;

export function makeProcessMarketRollupSweep(redis: IORedis) {
  return async function processMarketRollupSweep(
    _job: Job<MarketRollupSweepJobData>,
  ): Promise<void> {
    if (!env.MARKET_ROLLUPS_ENABLED) return;
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const started = Date.now();
      // Destructured to `rowCount` deliberately: `rebuild()` returns a COUNT, and logging it as `{ rows }`
      // reads like the rows themselves — both to a person skimming a log line and to the import-path PII
      // tripwire, which flags bare `{ rows }` because that shorthand is how a real leak gets written.
      const { rows: rowCount } = await marketRollupRepository.rebuild(WINDOW_MONTHS);
      log.info("market rollup sweep: rebuilt", {
        rowCount,
        months: WINDOW_MONTHS,
        runtimeMs: Date.now() - started,
      });
    });
  };
}
