// redisCacheStore — the ioredis adapter behind @leadwolf/core's CacheStore port (the read-through cache
// tier, 18-scalability-performance §5). Thin on purpose: every policy decision — TTLs, key structure,
// single-flight, jitter, what may and may not be cached — lives in core, where it is testable without Redis.
//
// Errors are NOT swallowed here. The cache tier's fail-open behaviour is core's decision and is implemented
// there; hiding failures at this layer would make a permanently broken Redis indistinguishable from a cold
// cache, and there would be nothing to log.

import type { CacheStore } from "@leadwolf/core";
import type { Redis } from "ioredis";

/** Namespace so cache entries are trivially distinguishable from BullMQ's and the rate limiter's keys in the
 *  same Redis — and so a `FLUSH`-by-pattern during an incident can target the cache alone. */
const PREFIX = "cache:";

export function redisCacheStore(redis: Redis): CacheStore {
  return {
    async get(key) {
      return redis.get(PREFIX + key);
    },
    async set(key, value, ttlSeconds) {
      // EX rather than a separate EXPIRE: one round-trip, and no window in which a key exists without a TTL
      // (a crash between SET and EXPIRE would otherwise leave an entry that never expires).
      await redis.set(PREFIX + key, value, "EX", ttlSeconds);
    },
    async del(keys) {
      if (keys.length === 0) return;
      await redis.del(...keys.map((k) => PREFIX + k));
    },
  };
}
