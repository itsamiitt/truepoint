// budgetGuard.test.ts — the per-tenant daily AI budget guard (23 §7): reserve increments-then-checks so a
// tenant can never exceed its ceiling, counters are per-tenant + per-UTC-day, and the in-memory store prunes
// stale days.

import { describe, expect, test } from "bun:test";
import {
  AiBudgetExceededError,
  createInMemoryBudgetStore,
  releaseAiBudget,
  reserveAiBudget,
  utcDayKey,
} from "./budgetGuard.ts";

describe("reserveAiBudget", () => {
  test("allows up to the limit, then throws", async () => {
    const store = createInMemoryBudgetStore();
    await reserveAiBudget(store, "t-1", 2);
    await reserveAiBudget(store, "t-1", 2);
    await expect(reserveAiBudget(store, "t-1", 2)).rejects.toBeInstanceOf(AiBudgetExceededError);
  });

  test("counts are isolated per tenant", async () => {
    const store = createInMemoryBudgetStore();
    await reserveAiBudget(store, "t-1", 1);
    await expect(reserveAiBudget(store, "t-1", 1)).rejects.toBeInstanceOf(AiBudgetExceededError);
    // A different tenant is unaffected.
    await expect(reserveAiBudget(store, "t-2", 1)).resolves.toBeUndefined();
  });

  test("counters are scoped to the UTC day and reset across days", async () => {
    const store = createInMemoryBudgetStore();
    const day1 = new Date("2026-06-17T23:59:00Z");
    const day2 = new Date("2026-06-18T00:01:00Z");
    await reserveAiBudget(store, "t-1", 1, day1);
    await expect(reserveAiBudget(store, "t-1", 1, day1)).rejects.toBeInstanceOf(
      AiBudgetExceededError,
    );
    // New day → fresh budget.
    await expect(reserveAiBudget(store, "t-1", 1, day2)).resolves.toBeUndefined();
  });

  test("a rejected (over-limit) reservation is rolled back, not left counted", async () => {
    const store = createInMemoryBudgetStore();
    await reserveAiBudget(store, "t-1", 1); // count = 1
    await expect(reserveAiBudget(store, "t-1", 1)).rejects.toBeInstanceOf(AiBudgetExceededError);
    // The rejected attempt must not have left the counter at 2 (peek stays at the limit).
    expect(await store.peek("t-1", utcDayKey())).toBe(1);
  });

  test("releaseAiBudget refunds a reserved unit so a failed call doesn't burn quota", async () => {
    const store = createInMemoryBudgetStore();
    await reserveAiBudget(store, "t-1", 1); // reserve the only unit
    await releaseAiBudget(store, "t-1"); // call failed → refund
    // Budget is available again.
    await expect(reserveAiBudget(store, "t-1", 1)).resolves.toBeUndefined();
  });

  test("decrement never goes below zero", async () => {
    const store = createInMemoryBudgetStore();
    await releaseAiBudget(store, "t-1");
    expect(await store.peek("t-1", utcDayKey())).toBe(0);
  });

  test("utcDayKey is YYYY-MM-DD in UTC", () => {
    expect(utcDayKey(new Date("2026-06-18T03:00:00Z"))).toBe("2026-06-18");
  });
});
