// redisStores.test.ts — the Redis-shared breaker + provider gate (waterfall v2 / 0111) against an
// in-memory Redis fake (the crmBudgetStore test idiom): key lifecycles, threshold/cooldown semantics,
// budget windows, and the TTL-on-create rule — no live Redis in CI.

import { describe, expect, test } from "bun:test";
import { type BreakerRedis, redisBreakerStore } from "./redisBreakerStore.ts";
import { type GateRedis, redisProviderGate } from "./redisProviderGate.ts";

/** Map-backed fake covering exactly the narrow interfaces the stores declare. */
function fakeRedis(): BreakerRedis &
  GateRedis & { store: Map<string, string>; ttls: Map<string, number>; now: () => number } {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const buckets = new Map<string, { tokens: number; ts: number }>();
  const self = {
    store,
    ttls,
    now: () => Date.now(),
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: string, _ex: "EX", seconds: number) => {
      store.set(key, value);
      ttls.set(key, seconds);
      return Promise.resolve("OK");
    },
    incr: (key: string) => {
      const next = Number.parseInt(store.get(key) ?? "0", 10) + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    },
    incrby: (key: string, increment: number) => {
      const next = Number.parseInt(store.get(key) ?? "0", 10) + increment;
      store.set(key, String(next));
      return Promise.resolve(next);
    },
    expire: (key: string, seconds: number) => {
      ttls.set(key, seconds);
      return Promise.resolve(1);
    },
    del: (...keys: string[]) => {
      for (const k of keys) {
        store.delete(k);
        ttls.delete(k);
      }
      return Promise.resolve(keys.length);
    },
    // The gate's Lua bucket, reimplemented in JS with the same math (capacity/refill/consume-1).
    eval: (_script: string, _numKeys: number, ...args: (string | number)[]) => {
      const [key, cap, refill, nowMs, cost] = [
        String(args[0]),
        Number(args[1]),
        Number(args[2]),
        Number(args[3]),
        Number(args[4]),
      ];
      const b = buckets.get(key) ?? { tokens: cap, ts: nowMs };
      const elapsed = Math.max(0, (nowMs - b.ts) / 1000);
      let tokens = Math.min(cap, b.tokens + elapsed * refill);
      let allowed = 0;
      let retry = 0;
      if (tokens >= cost) {
        tokens -= cost;
        allowed = 1;
      } else {
        retry = Math.ceil(((cost - tokens) / refill) * 1000);
      }
      buckets.set(key, { tokens, ts: nowMs });
      return Promise.resolve([allowed, retry]);
    },
  };
  return self;
}

describe("redisBreakerStore", () => {
  test("opens after 3 consecutive failures; success clears both keys", async () => {
    const redis = fakeRedis();
    const breaker = redisBreakerStore(redis);
    await breaker.record("apollo", false);
    await breaker.record("apollo", false);
    expect(await breaker.isOpen("apollo")).toBe(false);
    await breaker.record("apollo", false);
    expect(await breaker.isOpen("apollo")).toBe(true);
    expect(redis.ttls.get("enrich:breaker:open:apollo")).toBe(60); // cooldown IS the expiry (half-open)
    await breaker.record("apollo", true);
    expect(await breaker.isOpen("apollo")).toBe(false);
    expect(redis.store.has("enrich:breaker:errors:apollo")).toBe(false);
  });

  test("providers are independent", async () => {
    const redis = fakeRedis();
    const breaker = redisBreakerStore(redis);
    for (let i = 0; i < 3; i++) await breaker.record("apollo", false);
    expect(await breaker.isOpen("apollo")).toBe(true);
    expect(await breaker.isOpen("pdl")).toBe(false);
  });
});

describe("redisProviderGate", () => {
  const NOW = new Date("2026-08-12T10:00:00Z");

  test("no limits → always allowed, nothing counted until settle", async () => {
    const redis = fakeRedis();
    const gate = redisProviderGate(redis, () => NOW);
    const d = await gate.allow("apollo", 30_000, {
      rateLimitPerMin: null,
      monthlyBudgetCents: null,
    });
    expect(d).toEqual({ allowed: true });
  });

  test("monthly budget: denies when spent + estimate exceeds the cap; settle accrues; TTL set once", async () => {
    const redis = fakeRedis();
    const gate = redisProviderGate(redis, () => NOW);
    const limits = { rateLimitPerMin: null, monthlyBudgetCents: 10 }; // 10¢ = 100_000µ$
    expect((await gate.allow("apollo", 60_000, limits)).allowed).toBe(true);
    await gate.settle("apollo", 60_000);
    const key = "enrich:budget:apollo:2026-08";
    expect(redis.store.get(key)).toBe("60000");
    const firstTtl = redis.ttls.get(key);
    expect(firstTtl).toBeGreaterThan(0);
    // 60k spent; another 60k estimate would breach the 100k cap.
    const denied = await gate.allow("apollo", 60_000, limits);
    expect(denied).toEqual({ allowed: false, reason: "budget" });
    // A smaller call still fits.
    expect((await gate.allow("apollo", 30_000, limits)).allowed).toBe(true);
    await gate.settle("apollo", 30_000);
    expect(redis.ttls.get(key)).toBe(firstTtl); // never extended by later settles
  });

  test("rate limit: the bucket denies the burst past capacity and suggests a retry delay", async () => {
    const redis = fakeRedis();
    const gate = redisProviderGate(redis, () => NOW);
    const limits = { rateLimitPerMin: 2, monthlyBudgetCents: null };
    expect((await gate.allow("pdl", 40_000, limits)).allowed).toBe(true);
    expect((await gate.allow("pdl", 40_000, limits)).allowed).toBe(true);
    const third = await gate.allow("pdl", 40_000, limits);
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.reason).toBe("rate_limited");
      expect(third.retryAfterMs).toBeGreaterThan(0);
    }
  });

  test("zero-cost settle writes nothing", async () => {
    const redis = fakeRedis();
    const gate = redisProviderGate(redis, () => NOW);
    await gate.settle("apollo", 0);
    expect(redis.store.size).toBe(0);
  });
});
