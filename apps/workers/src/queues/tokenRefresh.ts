// tokenRefresh.ts — the email_token_refresh processor (M12 P1). A leader-locked repeatable sweep that refreshes
// the OAuth access tokens nearing expiry OFF the send path — so a send never pays the refresh latency, and a
// revoked grant is flagged reauth_required proactively (not first discovered mid-send). Mirrors retentionSweep:
// the refresh+rotate is tenant-scoped per mailbox inside core's refreshDueMailboxTokens (the worklist read is a
// cross-tenant owner-connection scan of ids only — no credential).

import { refreshDueMailboxTokens } from "@leadwolf/core";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const EMAIL_TOKEN_REFRESH_QUEUE = "email_token_refresh";
const LEADER_KEY = "leader:email_token_refresh";
const LEADER_TTL_MS = 110_000; // < the 2-min repeat interval, so the lock frees before the next fire
const BATCH_SIZE = 200; // bound the fan-out per sweep (15 §A.8)

export type TokenRefreshJobData = Record<string, never>;

export function makeProcessTokenRefresh(redis: IORedis) {
  return async function processTokenRefresh(_job: Job<TokenRefreshJobData>): Promise<void> {
    const ran = await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const result = await refreshDueMailboxTokens({ batchSize: BATCH_SIZE });
      if (result.scanned > 0) {
        log.info("token refresh sweep", {
          scanned: result.scanned,
          refreshed: result.refreshed,
          failed: result.failed,
        });
      }
    });
    if (!ran) log.info("token refresh skipped (not leader)");
  };
}
