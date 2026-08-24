// redisBreakerStore.ts — the Redis-shared circuit breaker for the enrichment waterfall (waterfall v2 /
// 0111; the "Redis-shared breaker is the M12 scale follow-up" note in core waterfall.ts:4, delivered).
// Workers are horizontally scaled: a process-local breaker lets N workers EACH make the full error budget
// of failing calls before any breaker opens; this one is shared, so the fleet collectively opens after
// `threshold` consecutive failures.
//
// Key shape (the redisCrmBudgetStore idiom — narrow injected interface, no hard ioredis type):
//   enrich:breaker:errors:{provider} — consecutive-failure counter (reset on success)
//   enrich:breaker:open:{provider}   — presence = open; EX cooldown seconds. The EXPIRY IS the half-open
//                                      probe: when it lapses, isOpen() reads false and exactly the next
//                                      call goes through; failure re-opens, success clears the counter.
//
// Failure posture lives in the CALLER (fieldWaterfall): isOpen errors fail open, record errors are
// swallowed — this store just counts.

import type { BreakerStore } from "@leadwolf/core";

/** The minimal Redis surface used — satisfied by ioredis; tests inject a Map-backed fake. */
export interface BreakerRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: "EX", seconds: number): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_SECONDS = 60;
/** The error counter self-heals if a provider goes quiet mid-streak (10 cooldowns). */
const COUNTER_TTL_SECONDS = 600;

/** Cap on a vendor-sent rate-limit horizon — one bad Retry-After header must not block a provider
 *  fleet-wide for longer than this (env ENRICH_BREAKER_RATE_LIMIT_HORIZON_CAP_S at the composition root). */
const DEFAULT_HORIZON_CAP_SECONDS = 86_400;

export function redisBreakerStore(
  redis: BreakerRedis,
  threshold = DEFAULT_THRESHOLD,
  cooldownSeconds = DEFAULT_COOLDOWN_SECONDS,
  horizonCapSeconds = DEFAULT_HORIZON_CAP_SECONDS,
): BreakerStore {
  const errorsKey = (p: string) => `enrich:breaker:errors:${p}`;
  const openKey = (p: string) => `enrich:breaker:open:${p}`;
  // Rate-limit horizon (recordRateLimited): presence = blocked until the vendor's Retry-After elapses.
  // The key EXPIRY IS the horizon (the openKey idiom) — no strike, the errors counter is untouched.
  const limitedKey = (p: string) => `enrich:breaker:limited:${p}`;
  return {
    async isOpen(provider) {
      const [open, limited] = await Promise.all([
        redis.get(openKey(provider)),
        redis.get(limitedKey(provider)),
      ]);
      return open !== null || limited !== null;
    },
    async record(provider, ok) {
      if (ok) {
        await redis.del(errorsKey(provider), openKey(provider), limitedKey(provider));
        return;
      }
      const errors = await redis.incr(errorsKey(provider));
      await redis.expire(errorsKey(provider), COUNTER_TTL_SECONDS);
      if (errors >= threshold) {
        await redis.set(openKey(provider), "1", "EX", cooldownSeconds);
      }
    },
    async recordRateLimited(provider, retryAfterMs) {
      const seconds = Math.min(Math.max(1, Math.ceil(retryAfterMs / 1000)), horizonCapSeconds);
      await redis.set(limitedKey(provider), "1", "EX", seconds);
    },
  };
}
