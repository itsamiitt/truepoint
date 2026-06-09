// rateLimit.ts — per-IP + per-identifier throttling for the identifier/credential steps (ADR-0020), backed
// by Redis (rate-limiter-flexible). Throws RateLimitedError when a key is exhausted; fails OPEN on a Redis
// outage so a cache blip can't brick authentication.
import Redis from "ioredis";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { env } from "@leadwolf/config";
import { RateLimitedError } from "@leadwolf/types";

const redis = new Redis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });

const ipLimiter = new RateLimiterRedis({ storeClient: redis, keyPrefix: "rl:ip", points: 30, duration: 60 });
const idLimiter = new RateLimiterRedis({ storeClient: redis, keyPrefix: "rl:id", points: 10, duration: 60 });
// Coarse per-caller cap for the resource API (keyed by subject when authenticated, else IP). 120/min.
const apiLimiter = new RateLimiterRedis({ storeClient: redis, keyPrefix: "rl:api", points: 120, duration: 60 });

// Throw RateLimitedError if `limiter` is exhausted for `key`; fail OPEN on a Redis outage (shared helper).
async function consume(limiter: RateLimiterRedis, key: string): Promise<void> {
  try {
    await limiter.consume(key);
  } catch (e) {
    if (e && typeof e === "object" && "msBeforeNext" in e) {
      throw new RateLimitedError(Math.ceil((e as { msBeforeNext: number }).msBeforeNext / 1000));
    }
    // Infra error (e.g. Redis unavailable) — fail open so an outage can't brick the platform.
  }
}

export async function checkIdentifierRate(args: { ip: string; identifier: string }): Promise<void> {
  await consume(ipLimiter, args.ip);
  await consume(idLimiter, args.identifier.toLowerCase());
}

/** Coarse per-request throttle for the resource API. `key` is the subject (authenticated) or client IP. */
export async function checkRequestRate(key: string): Promise<void> {
  await consume(apiLimiter, key);
}
