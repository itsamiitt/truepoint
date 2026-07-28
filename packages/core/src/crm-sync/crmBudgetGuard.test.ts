// crmBudgetGuard.test.ts — the proactive per-connection API budget (crm-sync 00 §8.2). Pure; the store is a
// fake, so both inversions are exercised without Redis.
//
// The two behaviours that matter are the ones that INVERT the repo's existing defaults: this guard fails
// CLOSED where the auth rate limiter fails open, and it counts in a SHARED store where the AI guard counts
// per process. Only the first is testable here; the second is a contract stated on the interface.

import { describe, expect, test } from "bun:test";
import {
  type CrmBudgetStore,
  crmBudgetWindow,
  releaseCrmBudget,
  reserveCrmBudget,
} from "./crmBudgetGuard.ts";

/** An in-memory store standing in for the Redis one. */
function fakeStore(
  over: Partial<CrmBudgetStore> = {},
): CrmBudgetStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const key = (c: string, w: string) => `${c}:${w}`;
  return {
    counts,
    async increment(c, w, cost) {
      const next = (counts.get(key(c, w)) ?? 0) + cost;
      counts.set(key(c, w), next);
      return next;
    },
    async decrement(c, w, cost) {
      counts.set(key(c, w), Math.max(0, (counts.get(key(c, w)) ?? 0) - cost));
    },
    async peek(c, w) {
      return counts.get(key(c, w)) ?? 0;
    },
    ...over,
  };
}

const NOW = new Date(Date.parse("2026-07-01T12:30:00Z"));

describe("FAIL CLOSED on a store outage", () => {
  test("a throwing store REFUSES the call", async () => {
    // The inversion. packages/auth's limiter fails OPEN because locking users out is worse than briefly
    // unlimited logins. Here failing open means an unbounded sync spending a CUSTOMER's CRM quota — a
    // delayed sync is recoverable, a burned daily allowance locks them out of their own CRM.
    const store = fakeStore({
      increment: async () => {
        throw new Error("redis down");
      },
    });
    const d = await reserveCrmBudget(store, "conn-1", 100, 1, NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unavailable");
  });

  test("'unavailable' is distinguishable from 'exceeded'", async () => {
    // They call for different operator responses — fix Redis vs raise the cap — so a runner must be able to
    // tell them apart rather than seeing one opaque refusal.
    const broken = await reserveCrmBudget(
      fakeStore({
        increment: async () => {
          throw new Error("redis down");
        },
      }),
      "conn-1",
      100,
      1,
      NOW,
    );
    const over = await reserveCrmBudget(fakeStore(), "conn-1", 0.5 as unknown as number, 1, NOW);
    expect(broken.reason).toBe("unavailable");
    expect(over.reason).not.toBe("unavailable");
  });
});

describe("the ceiling", () => {
  test("allows calls up to the limit", async () => {
    const store = fakeStore();
    for (let i = 1; i <= 3; i++) {
      const d = await reserveCrmBudget(store, "conn-1", 3, 1, NOW);
      expect(d.allowed).toBe(true);
      expect(d.used).toBe(i);
    }
  });

  test("refuses the call that would exceed it", async () => {
    const store = fakeStore();
    for (let i = 0; i < 3; i++) await reserveCrmBudget(store, "conn-1", 3, 1, NOW);
    const d = await reserveCrmBudget(store, "conn-1", 3, 1, NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("exceeded");
  });

  test("a REFUSED attempt is rolled back, so it cannot inflate the counter", async () => {
    // Without the rollback a hot retry loop would push the counter far past the limit and keep the
    // connection locked out long after the real usage had subsided.
    const store = fakeStore();
    for (let i = 0; i < 3; i++) await reserveCrmBudget(store, "conn-1", 3, 1, NOW);
    for (let i = 0; i < 10; i++) await reserveCrmBudget(store, "conn-1", 3, 1, NOW);
    expect(await store.peek("conn-1", crmBudgetWindow(NOW))).toBe(3);
  });

  test("cost > 1 is charged and can exceed in one step", async () => {
    const store = fakeStore();
    const d = await reserveCrmBudget(store, "conn-1", 10, 25, NOW);
    expect(d.allowed).toBe(false);
    expect(await store.peek("conn-1", crmBudgetWindow(NOW))).toBe(0); // rolled back
  });

  test("budgets are PER CONNECTION — one exhausting does not block another", async () => {
    // The quota being protected belongs to the CRM org; one workspace may hold a Salesforce and a HubSpot
    // connection with entirely independent allowances.
    const store = fakeStore();
    for (let i = 0; i < 3; i++) await reserveCrmBudget(store, "conn-a", 3, 1, NOW);
    expect((await reserveCrmBudget(store, "conn-a", 3, 1, NOW)).allowed).toBe(false);
    expect((await reserveCrmBudget(store, "conn-b", 3, 1, NOW)).allowed).toBe(true);
  });
});

describe("an unconfigured budget is UNLIMITED, not zero", () => {
  test("limit 0 allows the call and touches no counter", async () => {
    // The guard is opt-in per connection. Defaulting an unconfigured connection to zero would have stopped
    // every sync in the fleet the moment this shipped.
    const store = fakeStore();
    const d = await reserveCrmBudget(store, "conn-1", 0, 1, NOW);
    expect(d.allowed).toBe(true);
    expect(store.counts.size).toBe(0);
  });

  test("a negative limit is treated the same", async () => {
    expect((await reserveCrmBudget(fakeStore(), "conn-1", -5, 1, NOW)).allowed).toBe(true);
  });
});

describe("the window", () => {
  test("is a UTC HOUR, so a runaway loop is bounded to ~1/24 of a daily allowance", async () => {
    expect(crmBudgetWindow(new Date(Date.parse("2026-07-01T12:59:59Z")))).toBe("2026-07-01T12");
    expect(crmBudgetWindow(new Date(Date.parse("2026-07-01T13:00:00Z")))).toBe("2026-07-01T13");
  });

  test("a new window starts fresh, so the connection recovers without an operator", async () => {
    const store = fakeStore();
    for (let i = 0; i < 3; i++) await reserveCrmBudget(store, "conn-1", 3, 1, NOW);
    expect((await reserveCrmBudget(store, "conn-1", 3, 1, NOW)).allowed).toBe(false);

    const nextHour = new Date(Date.parse("2026-07-01T13:00:00Z"));
    expect((await reserveCrmBudget(store, "conn-1", 3, 1, nextHour)).allowed).toBe(true);
  });
});

describe("release", () => {
  test("refunds a reservation whose call never happened", async () => {
    const store = fakeStore();
    await reserveCrmBudget(store, "conn-1", 10, 1, NOW);
    await releaseCrmBudget(store, "conn-1", 1, NOW);
    expect(await store.peek("conn-1", crmBudgetWindow(NOW))).toBe(0);
  });

  test("never throws, even when the store is broken", async () => {
    // A failed refund costs a little headroom until the window rolls — strictly better than failing a job
    // that had already succeeded.
    const store = fakeStore({
      decrement: async () => {
        throw new Error("redis down");
      },
    });
    await expect(releaseCrmBudget(store, "conn-1", 1, NOW)).resolves.toBeUndefined();
  });

  test("cannot drive the counter below zero", async () => {
    const store = fakeStore();
    await releaseCrmBudget(store, "conn-1", 5, NOW);
    expect(await store.peek("conn-1", crmBudgetWindow(NOW))).toBe(0);
  });
});
