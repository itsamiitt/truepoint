// leaderLock — singleton election for sweep/maintenance jobs (mirrors TruePoint leaderLock.ts). SET key token
// PX ttl NX acquires; a compare-and-delete Lua release ensures a slow holder can't delete a newer owner's lock.
// Returns null (did not run) when another replica holds the lock.
import type { Redis } from "ioredis";

const RELEASE_IF_OWNER =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** A minimal Redis surface — the real ioredis client satisfies it; tests pass a fake. */
export interface LockRedis {
  set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    condition: "NX",
  ): Promise<string | null>;
  eval(script: string, numKeys: number, key: string, token: string): Promise<unknown>;
}

export async function withLeaderLock<T>(
  redis: LockRedis,
  key: string,
  ttlMs: number,
  token: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") return null; // another replica is the leader this tick
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_IF_OWNER, 1, key, token);
  }
}

/** Adapt an ioredis client to LockRedis (its set/eval overloads are wider). */
export function asLockRedis(redis: Redis): LockRedis {
  return {
    set: (key, value, _mode, ttlMs, _condition) => redis.set(key, value, "PX", ttlMs, "NX"),
    eval: (script, numKeys, key, token) => redis.eval(script, numKeys, key, token),
  };
}
