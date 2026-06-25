// sequenceTick.ts — the email_sequence_tick processor (M12 P4, email-planning/13 P4, 15 §A.4, D10). On each
// repeatable fire it takes the Redis leader lock and runs one tickSequences pass: claim a bounded batch of
// due enrollments (FOR UPDATE SKIP LOCKED — no double-advance) and enqueue each onto the existing outreach
// queue, which advances its next step through the UNCHANGED M9 send path (D11). The enqueue function is
// passed in by register.ts (enqueueOutreach) so this processor stays free of the producer wiring.

import { tickSequences } from "@leadwolf/core";
import type { ClaimedEnrollment } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const EMAIL_SEQUENCE_TICK_QUEUE = "email_sequence_tick";

/** The leader-lock key + TTL. TTL > the worst-case tick duration so a slow tick keeps the lock until done. */
const LEADER_KEY = "leader:email_sequence_tick";
const LEADER_TTL_MS = 55_000; // < the 60s repeat interval, so the lock frees before the next fire

// Bound the fan-out per tick (15 §A.8) so one tick can't enqueue an unbounded burst.
const BATCH_SIZE = 200;

// The repeatable tick carries no payload.
export type SequenceTickJobData = Record<string, never>;

export function makeProcessSequenceTick(
  redis: IORedis,
  enqueue: (e: ClaimedEnrollment) => Promise<void>,
) {
  return async function processSequenceTick(_job: Job<SequenceTickJobData>): Promise<void> {
    const ran = await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const result = await tickSequences({ batchSize: BATCH_SIZE, enqueue });
      if (result.claimed > 0) {
        log.info("sequence tick", { claimed: result.claimed, enqueued: result.enqueued });
      }
    });
    if (!ran) log.info("sequence tick skipped (not leader)");
  };
}
