// reliability.test.ts — the PURE CRM reliability helpers (crm-sync §8.2). No IO: pure functions over plain
// inputs. Covers every classifyRetry mapping, backoff growth + cap + the INJECTED jitter (proving no RNG is
// baked in), and the rateBudgetDecision allow/deny — including fail-CLOSED on an unknown/zero cap and the
// Retry-After-honored case.

import { describe, expect, test } from "bun:test";
import {
  backoffDelayMs,
  classifyRetry,
  type CrmRetryClass,
  rateBudgetDecision,
  type RateBudgetInput,
} from "./reliability.ts";

describe("classifyRetry", () => {
  const cases: Array<[CrmRetryClass, string]> = [
    ["transient", "retry"],
    ["rate_limited", "backoff"],
    ["auth_expired", "refresh_auth"],
    ["not_found", "drop"],
    ["validation", "dlq"],
    ["permanent", "dlq"],
    ["conflict", "dlq"],
    ["auth_revoked", "dlq"],
  ];

  for (const [cls, action] of cases) {
    test(`${cls} → ${action}`, () => {
      expect(classifyRetry(cls)).toBe(action);
    });
  }
});

describe("backoffDelayMs", () => {
  test("grows exponentially from the base", () => {
    expect(backoffDelayMs(0)).toBe(1_000);
    expect(backoffDelayMs(1)).toBe(2_000);
    expect(backoffDelayMs(2)).toBe(4_000);
    expect(backoffDelayMs(3)).toBe(8_000);
  });

  test("is clamped to the cap for large attempts", () => {
    expect(backoffDelayMs(100)).toBe(300_000);
    expect(backoffDelayMs(50, { capMs: 10_000 })).toBe(10_000);
  });

  test("clamps a negative attempt to the base", () => {
    expect(backoffDelayMs(-5)).toBe(1_000);
  });

  test("default jitter is identity (no RNG baked in — deterministic)", () => {
    expect(backoffDelayMs(2)).toBe(backoffDelayMs(2));
  });

  test("applies the INJECTED jitter to the capped value", () => {
    expect(backoffDelayMs(3, { jitter: (d) => d / 2 })).toBe(4_000);
    expect(backoffDelayMs(2, { jitter: () => 0 })).toBe(0);
  });

  test("honours a custom base", () => {
    expect(backoffDelayMs(1, { baseMs: 500 })).toBe(1_000);
  });
});

describe("rateBudgetDecision", () => {
  const base = (over: Partial<RateBudgetInput> = {}): RateBudgetInput => ({
    dailyCap: 15_000,
    usedToday: 0,
    fraction: 0.5,
    ...over,
  });

  test("allows while under fraction·cap", () => {
    const d = rateBudgetDecision(base({ usedToday: 7_000 }));
    expect(d).toEqual({ allow: true, delayMs: 0, reason: "under_budget" });
  });

  test("denies once the fair-share budget is exhausted", () => {
    const d = rateBudgetDecision(base({ usedToday: 7_500 }));
    expect(d).toEqual({ allow: false, delayMs: 0, reason: "budget_exhausted" });
  });

  test("fails CLOSED when the cap is unknown (undefined)", () => {
    const d = rateBudgetDecision(base({ dailyCap: undefined }));
    expect(d).toEqual({ allow: false, delayMs: 0, reason: "cap_unknown" });
  });

  test("fails CLOSED when the cap is zero (a missing cap is never infinite headroom)", () => {
    const d = rateBudgetDecision(base({ dailyCap: 0 }));
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("cap_unknown");
  });

  test("honours an explicit Retry-After before any budget check", () => {
    const d = rateBudgetDecision(base({ retryAfterMs: 12_000, dailyCap: undefined, usedToday: 0 }));
    expect(d).toEqual({ allow: false, delayMs: 12_000, reason: "retry_after" });
  });
});
