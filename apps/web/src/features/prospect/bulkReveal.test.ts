// bulkReveal.test.ts — proves the bulk money-loop POLICY (07 §3, §13): it sums the SERVER-reported
// creditsCharged (never a client-side cost), STOPS on insufficient_credits (402), SKIPS suppressed (403),
// counts other failures and keeps going, and reports the latest server balance + progress. Pure — no React,
// no network (the reveal fn is injected/mocked).
import { describe, expect, test } from "bun:test";
import type { RevealResponse } from "@leadwolf/types";
import { ApiError } from "./api";
import { runBulkReveal } from "./bulkReveal";

/** A minimal successful reveal response with the only fields the policy reads. */
function ok(creditsCharged: number, balanceAfter: number): RevealResponse {
  return {
    contactId: "c",
    reveal_type: "email",
    email: "x@y.test",
    creditsCharged,
    balanceAfter,
    alreadyOwned: false,
  };
}

const apiError = (code: string, ext: Record<string, unknown> = {}) =>
  new ApiError(code, code === "insufficient_credits" ? 402 : 403, code, ext);

describe("runBulkReveal", () => {
  test("reveals all, sums the server charges, tracks the latest balance", async () => {
    const s = await runBulkReveal(["a", "b"], async () => ok(2, 8));
    expect(s.revealedIds).toEqual(["a", "b"]);
    expect(s.totalCharged).toBe(4);
    expect(s.balanceAfter).toBe(8);
    expect(s.suppressedCount).toBe(0);
    expect(s.failedCount).toBe(0);
    expect(s.stoppedForCredits).toBe(false);
  });

  test("skips suppressed (403) and continues the rest", async () => {
    const s = await runBulkReveal(["a", "b", "c"], async (id) => {
      if (id === "b") throw apiError("suppressed");
      return ok(1, 5);
    });
    expect(s.revealedIds).toEqual(["a", "c"]);
    expect(s.suppressedCount).toBe(1);
    expect(s.totalCharged).toBe(2);
  });

  test("stops on insufficient_credits (402), surfaces the server balance, attempts no more", async () => {
    const attempted: string[] = [];
    const s = await runBulkReveal(["a", "b", "c"], async (id) => {
      attempted.push(id);
      if (id === "b") throw apiError("insufficient_credits", { balance: 0 });
      return ok(3, 3);
    });
    expect(s.revealedIds).toEqual(["a"]);
    expect(attempted).toEqual(["a", "b"]); // "c" is never attempted after the stop
    expect(s.stoppedForCredits).toBe(true);
    expect(s.balanceAfter).toBe(0);
  });

  test("on a 402 carrying no balance, still stops and retains the last known server balance", async () => {
    const s = await runBulkReveal(["a", "b", "c"], async (id) => {
      if (id === "b") throw apiError("insufficient_credits"); // 402 with no balance extension
      return ok(2, 7);
    });
    expect(s.revealedIds).toEqual(["a"]);
    expect(s.stoppedForCredits).toBe(true);
    expect(s.balanceAfter).toBe(7); // a's server balance is retained; the 402 carried none
    expect(s.totalCharged).toBe(2);
  });

  test("counts other failures and keeps going", async () => {
    const s = await runBulkReveal(["a", "b"], async (id) => {
      if (id === "a") throw new Error("network blip");
      return ok(1, 9);
    });
    expect(s.failedCount).toBe(1);
    expect(s.revealedIds).toEqual(["b"]);
    expect(s.stoppedForCredits).toBe(false);
  });

  test("empty selection → empty summary, no charge", async () => {
    const s = await runBulkReveal([], async () => ok(1, 1));
    expect(s.revealedIds).toEqual([]);
    expect(s.totalCharged).toBe(0);
    expect(s.balanceAfter).toBeNull();
  });

  test("reports progress from 0/total to total/total", async () => {
    const seen: Array<{ done: number; total: number }> = [];
    await runBulkReveal(["a", "b"], async () => ok(1, 1), "email", (p) => seen.push(p));
    expect(seen[0]).toEqual({ done: 0, total: 2 });
    expect(seen.at(-1)).toEqual({ done: 2, total: 2 });
  });

  test("still reports final progress done=total after an early 402 stop", async () => {
    const seen: Array<{ done: number; total: number }> = [];
    const reveal = async (id: string) => {
      if (id === "b") throw apiError("insufficient_credits", { balance: 0 });
      return ok(1, 4);
    };
    await runBulkReveal(["a", "b", "c"], reveal, "email", (p) => seen.push(p));
    expect(seen[0]).toEqual({ done: 0, total: 3 });
    expect(seen.at(-1)).toEqual({ done: 3, total: 3 });
  });
});
