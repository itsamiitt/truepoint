// mailboxThrottle.ts — the Redis token-bucket adapter for the per-mailbox send-rate throttle (M12 P1,
// WARM-001). Implements the core MailboxThrottlePort with an ATOMIC Lua refill-then-consume (the same math as
// core/email/tokenBucket) keyed `email:throttle:{mailboxId}`, so concurrent workers can never oversend one
// mailbox. A denied send returns the ms until a token frees — the outreach processor uses it as the re-enqueue
// delay (defer, never drop). Idle buckets expire once they'd be fully refilled (+ margin).

import type { MailboxThrottlePort } from "@leadwolf/core";
import type IORedis from "ioredis";

// KEYS[1]=bucket hash; ARGV = capacity, refillPerSec, nowMs, cost, ttlMs → {allowed(0|1), retryAfterMs}.
const TOKEN_BUCKET_LUA = `
local cap = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local data = redis.call('hmget', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = cap; ts = now end
local elapsed = math.max(0, (now - ts) / 1000)
tokens = math.min(cap, tokens + elapsed * refill)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local deficit = cost - tokens
  retry = math.ceil((deficit / refill) * 1000)
end
redis.call('hmset', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('pexpire', KEYS[1], ttl)
return {allowed, retry}
`;

export interface MailboxThrottleConfig {
  /** Burst ceiling (max tokens). */
  capacity: number;
  /** Steady-state tokens added per second. */
  refillPerSec: number;
}

export function createRedisMailboxThrottle(
  redis: IORedis,
  cfg: MailboxThrottleConfig,
): MailboxThrottlePort {
  const ttlMs = Math.ceil((cfg.capacity / Math.max(cfg.refillPerSec, 0.0001)) * 1000) + 60_000;
  return {
    async tryConsume(mailboxId) {
      const res = (await redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        `email:throttle:${mailboxId}`,
        cfg.capacity,
        cfg.refillPerSec,
        Date.now(),
        1,
        ttlMs,
      )) as [number, number];
      return { allowed: res[0] === 1, retryAfterMs: res[1] };
    },
  };
}
