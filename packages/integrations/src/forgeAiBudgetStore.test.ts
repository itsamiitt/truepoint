// forgeAiBudgetStore.test.ts — the Redis-backed Forge AI spend cap. The behaviour worth pinning is not the
// arithmetic (INCRBY is not interesting) but the two decisions that are easy to get wrong and expensive when
// wrong: what happens when Redis is unavailable, and whether a refund can leave a counter that hands out free
// budget later.

import { describe, expect, test } from "bun:test";
import { forgeAiBudgetStore } from "./forgeAiBudgetStore.ts";

type Call = { op: string; key: string; arg?: number };

/** Minimal ioredis stand-in: just the four commands the store issues. */
function fakeRedis(opts: { failing?: boolean } = {}) {
  const values = new Map<string, number>();
  const ttls = new Map<string, number>();
  const calls: Call[] = [];
  const boom = () => {
    throw new Error("ECONNREFUSED: redis unreachable");
  };
  const redis = {
    async incrby(key: string, by: number) {
      calls.push({ op: "incrby", key, arg: by });
      if (opts.failing) boom();
      const next = (values.get(key) ?? 0) + by;
      values.set(key, next);
      return next;
    },
    async decrby(key: string, by: number) {
      calls.push({ op: "decrby", key, arg: by });
      if (opts.failing) boom();
      const next = (values.get(key) ?? 0) - by;
      values.set(key, next);
      return next;
    },
    async expire(key: string, seconds: number) {
      calls.push({ op: "expire", key, arg: seconds });
      ttls.set(key, seconds);
      return 1;
    },
    async set(key: string, value: number, _ex: string, seconds: number) {
      calls.push({ op: "set", key, arg: value });
      values.set(key, value);
      ttls.set(key, seconds);
      return "OK";
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub, not the full ioredis surface.
  return { redis: redis as any, values, ttls, calls };
}

describe("forgeAiBudgetStore", () => {
  test("reserve returns the running total so the caller never re-reads", async () => {
    const { redis } = fakeRedis();
    const store = forgeAiBudgetStore(redis);
    expect(await store.reserve("k", 2)).toBe(2);
    expect(await store.reserve("k", 1)).toBe(3);
  });

  test("the TTL is set once, on creation — not refreshed on every reservation", async () => {
    // Re-setting the expiry on each reservation would keep pushing the window out, so a continuously busy
    // tenant's counter would never roll over and its budget would never reset.
    const { redis, calls } = fakeRedis();
    const store = forgeAiBudgetStore(redis);
    await store.reserve("k", 1);
    await store.reserve("k", 1);
    await store.reserve("k", 1);
    expect(calls.filter((c) => c.op === "expire")).toHaveLength(1);
  });

  test("release gives units back", async () => {
    const { redis, values } = fakeRedis();
    const store = forgeAiBudgetStore(redis);
    await store.reserve("k", 2);
    await store.release("k", 1);
    expect(values.get("k")).toBe(1);
  });

  test("a refund against an expired window cannot leave a NEGATIVE counter", async () => {
    // DECRBY on a missing key creates it at -units. Left alone, the next window would start below zero and
    // silently hand the tenant extra free budget on top of its limit.
    const { redis, values } = fakeRedis();
    const store = forgeAiBudgetStore(redis);
    await store.release("vanished-key", 5);
    expect(values.get("vanished-key")).toBe(0);
  });

  test("FAILS CLOSED when Redis is unreachable", async () => {
    // The deliberate divergence from forgeRateLimiter, which fails OPEN. That one throttles abuse, where a
    // Redis blip must not halt capture. This one caps MONEY on a path an outsider triggers, so failing open
    // during an outage re-opens the exact unbounded-spend hole the budget exists to close — unattended, for
    // however long the outage lasts. A returned total above any real limit makes the caller reject.
    const { redis } = fakeRedis({ failing: true });
    const store = forgeAiBudgetStore(redis);
    const total = await store.reserve("k", 1);
    expect(total).toBe(Number.POSITIVE_INFINITY);
    expect(total > 1_000_000).toBe(true);
  });

  test("a failing release never throws — a lost refund over-counts, which is the safe direction", async () => {
    const { redis } = fakeRedis({ failing: true });
    const store = forgeAiBudgetStore(redis);
    expect(store.release("k", 1)).resolves.toBeUndefined();
  });
});
