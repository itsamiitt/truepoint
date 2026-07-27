// cache.ts — the api's read-through cache instance (@leadwolf/core's tier over Redis).
//
// The connection options here are deliberately the OPPOSITE of the queue connections elsewhere in this app,
// and the difference matters. BullMQ uses `maxRetriesPerRequest: null` because a job must not be dropped
// when Redis blips — it should wait. A CACHE must do the reverse: if Redis is slow or gone, the read has to
// fail immediately so the tier falls through to the database. `null` plus the default offline queue would
// make a wedged Redis BUFFER the command silently, so every cached read would hang on the very outage the
// fail-open path exists to survive — turning a cache outage into a site outage.
//
// So: no offline queue (fail now, not later), one retry, and a command timeout well under any request budget.

import { env } from "@leadwolf/config";
import { type ReadThroughCache, createReadThroughCache, systemKey } from "@leadwolf/core";
import { redisCacheStore } from "@leadwolf/integrations";
import IORedis from "ioredis";

// Keys live here, next to the cache itself, rather than in the feature that reads them. A cached entry always
// has at least two owners — the reader and every writer that must invalidate it — and those sit in different
// features (the public pricing route reads; admin/pricing writes). Defining the key in one of them would be a
// cross-feature import; re-spelling it in both is worse, because a rename then leaves an invalidation
// pointing at a key nothing writes and the staleness is silent.
//
// The public pricing catalog is the one legitimate `systemKey` user: it is identical for every caller,
// renders with no token and no tenant, and so has no tenant dimension to key on.
export const PRICING_PACKS_KEY = systemKey("pricing", "credit-packs");
export const PRICING_PLANS_KEY = systemKey("pricing", "plans");

/** Upper bound on how long a cache lookup may add to a request before we give up and read through. */
const CACHE_COMMAND_TIMEOUT_MS = 150;

let instance: ReadThroughCache | undefined;

/** Lazily-constructed singleton — mirrors the per-feature lazy Redis connections already used here, so a
 *  process that never touches a cached route never opens the connection. */
export function cache(): ReadThroughCache {
  if (!instance) {
    const redis = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      commandTimeout: CACHE_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    // An unreachable cache is expected to be survivable, so its connection errors must not become unhandled
    // 'error' events (which would take the process down). The tier already treats every failure as a miss.
    redis.on("error", () => {});
    instance = createReadThroughCache(redisCacheStore(redis));
  }
  return instance;
}
