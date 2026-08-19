// searchReadCache.test.ts — the S5 contract, per the approved architecture doc §7/S5's test gate:
// (a) cross-tenant/workspace ISOLATION — two scopes never share an entry for the same query;
// (b) INVALIDATION correctness — a generation bump makes the next read recompute;
// (c) the TTL-0 kill switch — that class bypasses the cache entirely;
// (d) user text (suggest prefixes) is hashed, never embedded in a key.
// Runs against in-memory fakes of the CacheStore + version counter — no Redis, no mock.module.

import { describe, expect, test } from "bun:test";
import { type CacheStore, createReadThroughCache, searchVersionKey } from "@leadwolf/core";
import type { ContactQuery } from "@leadwolf/types";
import { createSearchReadCache } from "./searchReadCache.ts";

function fakes(ttls = { facets: 60, count: 30, suggest: 120 }) {
  const stored = new Map<string, string>();
  const store: CacheStore = {
    async get(k) {
      return stored.get(k) ?? null;
    },
    async set(k, v) {
      stored.set(k, v);
    },
    async del(keys) {
      for (const k of keys) stored.delete(k);
    },
  };
  const versions = new Map<string, number>();
  const redis = {
    async get(k: string) {
      const v = versions.get(k);
      return v === undefined ? null : String(v);
    },
  };
  const bump = (scope: { tenantId: string; workspaceId: string }) => {
    const k = searchVersionKey(scope);
    versions.set(k, (versions.get(k) ?? 0) + 1);
  };
  const srCache = createSearchReadCache({ cache: createReadThroughCache(store), redis, ttls });
  return { srCache, stored, bump };
}

const A = {
  tenantId: "0f0e0d0c-0b0a-7999-8888-777766665555",
  workspaceId: "11112222-3333-7444-8555-666677778888",
};
const B = {
  tenantId: "aaaabbbb-cccc-7ddd-8eee-ffff00001111",
  workspaceId: "22223333-4444-7555-8666-777788889999",
};
const QUERY = {
  text: undefined,
  filters: [],
  sort: "created_desc",
  limit: 50,
} as unknown as ContactQuery;
const FIELDS = ["title", "seniority"] as never[];

describe("searchReadCache", () => {
  test("isolation: two scopes with the same query never share an entry", async () => {
    const { srCache, stored } = fakes();
    let loads = 0;
    const load = (label: string) => async () => {
      loads++;
      return [{ label }];
    };
    const a = await srCache.facetCounts(A, QUERY, FIELDS, false, load("A"));
    const b = await srCache.facetCounts(B, QUERY, FIELDS, false, load("B"));
    expect(loads).toBe(2);
    expect(a).toEqual([{ label: "A" }]);
    expect(b).toEqual([{ label: "B" }]);
    // every stored key carries its own tenant AND workspace
    const keys = [...stored.keys()];
    expect(keys.some((k) => k.startsWith(`t:${A.tenantId}:ws:${A.workspaceId}:`))).toBe(true);
    expect(keys.some((k) => k.startsWith(`t:${B.tenantId}:ws:${B.workspaceId}:`))).toBe(true);
    // and a repeat for A hits A's entry, not B's
    const a2 = await srCache.facetCounts(A, QUERY, FIELDS, false, load("A2"));
    expect(loads).toBe(2);
    expect(a2).toEqual([{ label: "A" }]);
  });

  test("hit: same scope + query serves from cache (single load)", async () => {
    const { srCache } = fakes();
    let loads = 0;
    const load = async () => ({ total: ++loads });
    expect(await srCache.count(A, QUERY, load)).toEqual({ total: 1 });
    expect(await srCache.count(A, QUERY, load)).toEqual({ total: 1 });
    expect(loads).toBe(1);
  });

  test("invalidation: a generation bump makes the next read recompute (mutation → fresh read)", async () => {
    const { srCache, bump } = fakes();
    let loads = 0;
    const load = async () => [{ n: ++loads }];
    await srCache.facetCounts(A, QUERY, FIELDS, false, load);
    await srCache.facetCounts(A, QUERY, FIELDS, false, load);
    expect(loads).toBe(1);
    bump(A); // what bumpSearchVersion does after a bulk mutation / reveal / import promotion
    expect(await srCache.facetCounts(A, QUERY, FIELDS, false, load)).toEqual([{ n: 2 }]);
    expect(loads).toBe(2);
    // and B's generation is untouched by A's mutation
    let bLoads = 0;
    const bLoad = async () => [{ b: ++bLoads }];
    await srCache.facetCounts(B, QUERY, FIELDS, false, bLoad);
    bump(A);
    await srCache.facetCounts(B, QUERY, FIELDS, false, bLoad);
    expect(bLoads).toBe(1);
  });

  test("the S-CH4 gate is part of the identity: gate-on and gate-off never share an entry", async () => {
    const { srCache } = fakes();
    let loads = 0;
    const load = async () => [{ n: ++loads }];
    await srCache.facetCounts(A, QUERY, FIELDS, false, load);
    await srCache.facetCounts(A, QUERY, FIELDS, true, load);
    expect(loads).toBe(2);
  });

  test("TTL 0 disables that class: loader every time, nothing stored", async () => {
    const { srCache, stored } = fakes({ facets: 0, count: 0, suggest: 0 });
    let loads = 0;
    const load = async () => [{ n: ++loads }];
    await srCache.facetCounts(A, QUERY, FIELDS, false, load);
    await srCache.facetCounts(A, QUERY, FIELDS, false, load);
    expect(loads).toBe(2);
    expect(stored.size).toBe(0);
  });

  test("suggest hashes user text (unsafe prefixes never throw, never appear in keys)", async () => {
    const { srCache, stored } = fakes();
    const req = { field: "company", prefix: "c1 %😊:*", limit: 10, scope: "workspace" } as never;
    const out = await srCache.suggest(A, req, async () => ["ok"]);
    expect(out).toEqual(["ok"]);
    for (const k of stored.keys()) {
      expect(k.includes("😊")).toBe(false);
      expect(k.includes("%")).toBe(false);
    }
  });
});
