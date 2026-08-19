// gateMemo.test.ts — the S6 two-layer contract: L1 fast path, L2 shared visibility (what makes a second
// instance see an admin write), targeted DEL for tenant writes, generation bump for global writes, and
// tenant isolation of the L2 keys. Bound to in-memory fakes via setGateL2ForTests — no Redis.

import { afterEach, describe, expect, test } from "bun:test";
import { type CacheStore, createReadThroughCache } from "@leadwolf/core";
import {
  entitlementBasisCached,
  flagGateCached,
  invalidateAllFlagGates,
  invalidateEntitlementBasis,
  invalidateFlagGate,
  resetGateMemos,
  setGateL2ForTests,
} from "./gateMemo.ts";

const T1 = "0f0e0d0c-0b0a-7999-8888-777766665555";
const T2 = "aaaabbbb-cccc-7ddd-8eee-ffff00001111";

function fakes() {
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
  const counters = new Map<string, number>();
  const redis = {
    async get(k: string) {
      const v = counters.get(k);
      return v === undefined ? null : String(v);
    },
    async incr(k: string) {
      const v = (counters.get(k) ?? 0) + 1;
      counters.set(k, v);
      return v;
    },
  };
  setGateL2ForTests({ cache: createReadThroughCache(store), redis });
  return { stored };
}

afterEach(() => {
  setGateL2ForTests(undefined);
  resetGateMemos();
});

describe("gateMemo (S6 two-layer)", () => {
  test("miss loads once; repeat serves from memo", async () => {
    fakes();
    let loads = 0;
    const read = async () => {
      loads++;
      return true;
    };
    expect(await flagGateCached(T1, "import_v2", read)).toBe(true);
    expect(await flagGateCached(T1, "import_v2", read)).toBe(true);
    expect(loads).toBe(1);
  });

  test("L2 is the shared layer: a second 'instance' (cold L1) hits it without reloading", async () => {
    fakes();
    let loads = 0;
    const read = async () => {
      loads++;
      return true;
    };
    await flagGateCached(T1, "import_v2", read);
    resetGateMemos(); // simulate another instance: empty L1, same shared L2
    expect(await flagGateCached(T1, "import_v2", read)).toBe(true);
    expect(loads).toBe(1);
  });

  test("tenant-targeted invalidation retires L1 and the shared L2 entry", async () => {
    fakes();
    let loads = 0;
    const read = async () => {
      loads++;
      return loads % 2 === 1;
    };
    await flagGateCached(T1, "import_v2", read);
    invalidateFlagGate(T1, "import_v2");
    await Bun.sleep(5); // the L2 DEL is fire-and-forget
    resetGateMemos(); // other-instance view
    await flagGateCached(T1, "import_v2", read);
    expect(loads).toBe(2);
  });

  test("global invalidation bumps the generation so every tenant recomputes", async () => {
    fakes();
    let loads = 0;
    const read = async () => {
      loads++;
      return true;
    };
    await flagGateCached(T1, "channel_read_from_child", read);
    await flagGateCached(T2, "channel_read_from_child", read);
    invalidateAllFlagGates();
    await Bun.sleep(5);
    resetGateMemos();
    await flagGateCached(T1, "channel_read_from_child", read);
    await flagGateCached(T2, "channel_read_from_child", read);
    expect(loads).toBe(4);
  });

  test("L2 keys are tenant-scoped (isolation)", async () => {
    const { stored } = fakes();
    await flagGateCached(T1, "import_v2", async () => true);
    await flagGateCached(T2, "import_v2", async () => false);
    const keys = [...stored.keys()];
    expect(keys.some((k) => k.startsWith(`t:${T1}:`))).toBe(true);
    expect(keys.some((k) => k.startsWith(`t:${T2}:`))).toBe(true);
    // and the values did not cross
    resetGateMemos();
    expect(await flagGateCached(T1, "import_v2", async () => false)).toBe(true);
    expect(await flagGateCached(T2, "import_v2", async () => true)).toBe(false);
  });

  test("entitlement basis: cached, tenant-invalidated", async () => {
    fakes();
    let loads = 0;
    const read = async () => ({ grants: { reveal_month: 100 }, enforcing: loads++ === 42 });
    await entitlementBasisCached(T1, read);
    await entitlementBasisCached(T1, read);
    expect(loads).toBe(1);
    invalidateEntitlementBasis(T1);
    await Bun.sleep(5);
    resetGateMemos();
    await entitlementBasisCached(T1, read);
    expect(loads).toBe(2);
  });

  test("a throwing read is never cached", async () => {
    fakes();
    let calls = 0;
    const read = async () => {
      calls++;
      if (calls === 1) throw new Error("db blip");
      return true;
    };
    let threw = false;
    try {
      await flagGateCached(T1, "import_v2", read);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await flagGateCached(T1, "import_v2", read)).toBe(true);
    expect(calls).toBe(2);
  });
});
