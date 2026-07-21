// forgeRateLimiter — the REAL RateLimiter (Phase 4) implementing @leadwolf/forge-core's port on Redis
// (fixed-window INCR + TTL), so limits hold ACROSS api instances (the in-memory one is per-process). FAILS
// OPEN on a Redis outage (ecosystem-facts §A): abuse ≠ security, so a Redis blip must never halt capture.
// Re-homed from @forge/adapters.
import type { RateLimiter } from "@leadwolf/forge-core";
import type { Redis } from "ioredis";

const WINDOW_TTL_SECONDS = 120;

export function forgeRateLimiter(
  redis: Redis,
  opts: { recordLimit: number; byteLimit: number },
): RateLimiter {
  return {
    async check(caller: string, records: number, bytes: number) {
      try {
        const minute = Math.floor(Date.now() / 60_000);
        const recKey = `rl:rec:${caller}:${minute}`;
        const byteKey = `rl:byte:${caller}:${minute}`;
        const recCount = await redis.incrby(recKey, records);
        if (recCount === records) await redis.expire(recKey, WINDOW_TTL_SECONDS);
        const byteCount = await redis.incrby(byteKey, bytes);
        if (byteCount === bytes) await redis.expire(byteKey, WINDOW_TTL_SECONDS);
        if (recCount > opts.recordLimit || byteCount > opts.byteLimit) {
          return { allowed: false, retryAfter: 60 };
        }
        return { allowed: true };
      } catch {
        return { allowed: true }; // FAIL OPEN — a Redis blip must never halt capture (§A)
      }
    },
  };
}
