// leaseAccounting.test.ts — the ADR-0029 reserve-then-settle release math. The invariant that matters:
// lease(-leased) then release(+remainder) must net to exactly -spent on the counter, and the subscription
// bucket must be restored to (leasedFromSub - spentFromSub) with spend attributed subscription-first.

import { describe, expect, test } from "bun:test";
import { computeReleaseSplit } from "./leaseAccounting.ts";

describe("computeReleaseSplit", () => {
  test("nothing spent → the whole lease is released, full subscription portion restored", () => {
    expect(computeReleaseSplit(50, 30, 0)).toEqual({ remainder: 50, subRestore: 30 });
  });

  test("everything spent → nothing to release", () => {
    expect(computeReleaseSplit(50, 30, 50)).toEqual({ remainder: 0, subRestore: 0 });
  });

  test("partial spend within the subscription portion → remainder + the unspent sub portion", () => {
    // leased 50 (30 from sub), spent 10 → spentFromSub=10, remainder=40, subRestore=30-10=20.
    expect(computeReleaseSplit(50, 30, 10)).toEqual({ remainder: 40, subRestore: 20 });
  });

  test("spend exceeds the subscription portion → subRestore is 0 (sub fully consumed first)", () => {
    // leased 50 (30 from sub), spent 40 → spentFromSub=30, remainder=10, subRestore=30-30=0.
    expect(computeReleaseSplit(50, 30, 40)).toEqual({ remainder: 10, subRestore: 0 });
  });

  test("no subscription in the lease → subRestore always 0", () => {
    expect(computeReleaseSplit(50, 0, 10)).toEqual({ remainder: 40, subRestore: 0 });
  });

  test("guards: spent capped at leased, negatives floored, values truncated", () => {
    expect(computeReleaseSplit(50, 30, 999)).toEqual({ remainder: 0, subRestore: 0 });
    expect(computeReleaseSplit(-5, -5, -5)).toEqual({ remainder: 0, subRestore: 0 });
    expect(computeReleaseSplit(50.9, 30.9, 10.9)).toEqual({ remainder: 40, subRestore: 20 });
  });

  test("recon: for any lease/spend, leased − remainder == actual spend (counter nets to −spent)", () => {
    for (const leased of [0, 1, 7, 50, 100]) {
      for (const fromSub of [0, 3, 50, 200]) {
        for (const spent of [0, 1, 7, 49, 50, 100]) {
          const { remainder } = computeReleaseSplit(leased, fromSub, spent);
          const l = Math.max(0, leased);
          const s = Math.max(0, Math.min(l, spent));
          expect(l - remainder).toBe(s); // counter was reduced by exactly the actual spend
        }
      }
    }
  });
});
