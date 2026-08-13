// redisProviderGate.ts — the Redis-shared per-provider rate limiter + monthly budget gate (waterfall v2 /
// 0111). This is the enforcement half of provider_configs.rate_limit_per_min and monthly_budget_cents —
// columns platform admins have written since 13 §3.6 that the engine never read. BullMQ's limiter is
// per-QUEUE, so bounding one vendor among five needs a per-provider bucket; the Lua token bucket is the
// mailboxThrottle math verbatim, keyed per provider and shared fleet-wide.
//
// Keys:
//   enrich:throttle:{provider}          — token-bucket hash (capacity = rate_limit_per_min, refill = /60s)
//   enrich:budget:{provider}:{yyyy-mm}  — month spend counter in MICROS (compared vs budget_cents × 10_000);
//                                         TTL ~40 days set on creation only (the crmBudgetStore idiom).
//
// Failure posture lives in the CALLER (fieldWaterfall): a gate that cannot be evaluated fails CLOSED for
// that provider (skip it, cascade on) — the crmBudgetStore reasoning: a skipped vendor costs a fallback
// call; a broken gate letting a loop through costs real money.

import type { GateDecision, ProviderGate, ProviderLimits } from "@leadwolf/core";

/** Minimal Redis surface — satisfied by ioredis; tests inject a fake. */
export interface GateRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

// KEYS[1]=bucket hash; ARGV = capacity, refillPerSec, nowMs, cost, ttlMs → {allowed(0|1), retryAfterMs}.
// The mailboxThrottle refill-then-consume math, unchanged.
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

const BUDGET_TTL_SECONDS = 40 * 24 * 60 * 60; // outlives any month it stamps

/** yyyy-mm for the month window, UTC. */
function monthWindow(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function redisProviderGate(
  redis: GateRedis,
  now: () => Date = () => new Date(),
): ProviderGate {
  return {
    async allow(
      provider: string,
      estCostMicros: number,
      limits: ProviderLimits,
    ): Promise<GateDecision> {
      // Monthly budget first — cheaper read, and a budget-stop should not consume a rate token.
      if (limits.monthlyBudgetCents != null) {
        const capMicros = limits.monthlyBudgetCents * 10_000;
        const raw = await redis.get(`enrich:budget:${provider}:${monthWindow(now())}`);
        const spent = raw ? Number.parseInt(raw, 10) : 0;
        if (spent + estCostMicros > capMicros) {
          return { allowed: false, reason: "budget" };
        }
      }

      if (limits.rateLimitPerMin != null && limits.rateLimitPerMin > 0) {
        const res = (await redis.eval(
          TOKEN_BUCKET_LUA,
          1,
          `enrich:throttle:${provider}`,
          limits.rateLimitPerMin,
          limits.rateLimitPerMin / 60,
          now().getTime(),
          1,
          // Idle buckets expire once fully refilled (+ margin) — the mailboxThrottle TTL rule.
          Math.ceil(60 * 1000) + 60_000,
        )) as [number, number];
        if (res[0] !== 1) {
          return { allowed: false, reason: "rate_limited", retryAfterMs: res[1] };
        }
      }

      return { allowed: true };
    },

    async settle(provider: string, actualCostMicros: number): Promise<void> {
      if (actualCostMicros <= 0) return;
      const key = `enrich:budget:${provider}:${monthWindow(now())}`;
      const total = await redis.incrby(key, actualCostMicros);
      // TTL only when the counter was just created — a later settle never extends the window.
      if (total === actualCostMicros) await redis.expire(key, BUDGET_TTL_SECONDS);
    },
  };
}
