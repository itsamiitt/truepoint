// readThrough.test.ts — the read-through cache tier. The assertions worth having here are not "it caches";
// they are the properties that decide whether this tier is safe to put in front of real reads: keys always
// carry a tenant, a cache outage degrades instead of failing, a failed load is never cached, and concurrent
// misses do not stampede.

import { describe, expect, test } from "bun:test";
import { type CacheStore, createReadThroughCache, systemKey, tenantKey } from "./readThrough.ts";

/** In-memory CacheStore with optional fault injection. */
function fakeStore(opts: { failing?: boolean } = {}) {
  const map = new Map<string, string>();
  const ttls = new Map<string, number>();
  const boom = () => {
    throw new Error("redis unreachable");
  };
  const store: CacheStore = {
    async get(k) {
      if (opts.failing) boom();
      return map.get(k) ?? null;
    },
    async set(k, v, ttl) {
      if (opts.failing) boom();
      map.set(k, v);
      ttls.set(k, ttl);
    },
    async del(keys) {
      if (opts.failing) boom();
      for (const k of keys) map.delete(k);
    },
  };
  return { store, map, ttls };
}

const SCOPE = { tenantId: "11111111-1111-1111-1111-111111111111", workspaceId: "ws-a" };

describe("cache keys", () => {
  test("a tenant key always carries the tenant, and the workspace when scoped", () => {
    expect(tenantKey(SCOPE, "home", "summary")).toBe(
      "t:11111111-1111-1111-1111-111111111111:ws:ws-a:home:summary",
    );
    expect(tenantKey({ tenantId: "t1" }, "entitlements")).toBe("t:t1:entitlements");
  });

  test("two tenants never collide, and two workspaces never collide", () => {
    const a = tenantKey({ tenantId: "t1", workspaceId: "w1" }, "x");
    const b = tenantKey({ tenantId: "t2", workspaceId: "w1" }, "x");
    const c = tenantKey({ tenantId: "t1", workspaceId: "w2" }, "x");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("key parts that could break the delimiter structure are rejected", () => {
    // A part carrying ':' or '*' could forge another tenant's prefix or widen an invalidation. Ids are uuids
    // and part names are literals, so this only fires on a programming error — which is when it matters.
    expect(() => tenantKey({ tenantId: "t1:t2" }, "x")).toThrow();
    expect(() => tenantKey(SCOPE, "a:b")).toThrow();
    expect(() => tenantKey(SCOPE, "*")).toThrow();
    expect(() => systemKey("a b")).toThrow();
  });

  test("system keys sit in their own namespace, never under a tenant prefix", () => {
    expect(systemKey("pricing", "catalog")).toBe("sys:pricing:catalog");
    expect(systemKey("pricing").startsWith("t:")).toBe(false);
  });
});

describe("getOrSet", () => {
  test("misses load, hits do not", async () => {
    const { store } = fakeStore();
    const cache = createReadThroughCache(store);
    let loads = 0;
    const load = async () => {
      loads++;
      return { n: 1 };
    };
    expect(await cache.getOrSet("k", 60, load)).toEqual({ n: 1 });
    expect(await cache.getOrSet("k", 60, load)).toEqual({ n: 1 });
    expect(loads).toBe(1);
  });

  test("a cache outage degrades to the uncached path instead of failing the request", async () => {
    // A cache outage is not a data outage. If an unreachable Redis could fail reads, adding a cache would
    // have made availability strictly worse.
    const { store } = fakeStore({ failing: true });
    const cache = createReadThroughCache(store);
    expect(await cache.getOrSet("k", 60, async () => "value")).toBe("value");
  });

  test("a FAILED load is never cached", async () => {
    // Otherwise one transient database error is served to every caller for the whole TTL.
    const { store, map } = fakeStore();
    const cache = createReadThroughCache(store);
    await expect(
      cache.getOrSet("k", 60, async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
    expect(map.has("k")).toBe(false);
    expect(await cache.getOrSet("k", 60, async () => "recovered")).toBe("recovered");
  });

  test("concurrent misses share ONE load (single-flight)", async () => {
    // The stampede case: a cold or just-expired hot key otherwise lets every in-flight request run the same
    // expensive query simultaneously, so the cache makes the worst moment worse.
    const { store } = fakeStore();
    const cache = createReadThroughCache(store);
    let loads = 0;
    let release: (v: string) => void = () => {};
    const gate = new Promise<string>((r) => {
      release = r;
    });
    const load = async () => {
      loads++;
      return gate;
    };
    const all = Promise.all([
      cache.getOrSet("k", 60, load),
      cache.getOrSet("k", 60, load),
      cache.getOrSet("k", 60, load),
    ]);
    release("once");
    expect(await all).toEqual(["once", "once", "once"]);
    expect(loads).toBe(1);
  });

  test("TTL is jittered upward only — never below what the caller asked for", async () => {
    // Spreading expiries stops a batch created together from expiring together. Only ever longer, so a
    // caller's freshness bound is not silently shortened.
    const { store, ttls } = fakeStore();
    const cache = createReadThroughCache(store);
    for (let i = 0; i < 25; i++) {
      await cache.getOrSet(`k${i}`, 100, async () => i);
    }
    const seen = [...ttls.values()];
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(100);
    expect(Math.max(...seen)).toBeLessThanOrEqual(120);
  });
});

describe("invalidate", () => {
  test("drops the key so the next read reloads", async () => {
    const { store } = fakeStore();
    const cache = createReadThroughCache(store);
    let n = 0;
    const load = async () => ++n;
    expect(await cache.getOrSet("k", 60, load)).toBe(1);
    await cache.invalidate("k");
    expect(await cache.getOrSet("k", 60, load)).toBe(2);
  });

  test("an in-flight load started before the invalidation does not write back stale state", async () => {
    // The subtle one. A loader that already read the pre-mutation rows must not be allowed to populate the
    // cache AFTER the mutation invalidated it, or the write is immediately undone for a full TTL.
    const { store } = fakeStore();
    const cache = createReadThroughCache(store);
    let release: (v: string) => void = () => {};
    const gate = new Promise<string>((r) => {
      release = r;
    });
    const first = cache.getOrSet("k", 60, async () => gate);
    await cache.invalidate("k"); // mutation lands while the load is still in flight
    release("stale");
    await first;
    // The next reader must NOT be served "stale" from the entry the in-flight load wrote.
    expect(await cache.getOrSet("k", 60, async () => "fresh")).toBe("fresh");
  });

  test("invalidating with no keys is a no-op, and a store failure never throws", async () => {
    const { store } = fakeStore({ failing: true });
    const cache = createReadThroughCache(store);
    expect(cache.invalidate()).resolves.toBeUndefined();
    expect(cache.invalidate("k")).resolves.toBeUndefined();
  });
});
