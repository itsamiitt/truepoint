// leaderLock.ts — a Redis single-leader lock for the scheduled ticks (M12 P4, email-planning/13 P4,
// 15 §A.4). SET key value PX ttl NX acquires the lock for exactly one worker instance per interval; the
// compare-and-delete release (a tiny Lua script) only frees the lock if we still own it, so a slow holder
// whose TTL already expired cannot delete a newer holder's lock. Belt-and-suspenders on top of the claim's
// FOR UPDATE SKIP LOCKED (which already makes a double-tick safe) + the BullMQ repeatable-job dedupe.

import { randomUUID } from "node:crypto";
import type IORedis from "ioredis";

const RELEASE_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Run `fn` iff this instance wins the lock `key` for `ttlMs`. Returns true when the lock was held and `fn`
 * ran, false when another instance held it. The TTL bounds a crashed holder; the release is owner-checked.
 */
export async function withLeaderLock(
  redis: IORedis,
  key: string,
  ttlMs: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const token = randomUUID();
  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") return false;
  try {
    await fn();
    return true;
  } finally {
    await redis.eval(RELEASE_IF_OWNER, 1, key, token).catch(() => {
      /* best-effort release; the TTL frees it regardless */
    });
  }
}
