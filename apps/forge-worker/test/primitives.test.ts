import { describe, expect, test } from "bun:test";
import { buildDeadLetter } from "../src/deadLetter.ts";
import { type LockRedis, withLeaderLock } from "../src/leaderLock.ts";
import { retryFor } from "../src/retryPolicies.ts";
import { concurrencyFor, deadlineFor } from "../src/tuning.ts";
import { ProcessorDeadlineError, withDeadline } from "../src/withDeadline.ts";

describe("retry policies", () => {
  test("sync gets the largest budget; unknown queue throws", () => {
    expect(retryFor("sync").attempts).toBe(5);
    expect(retryFor("parse").backoff.type).toBe("exponential");
    expect(() => retryFor("nope")).toThrow();
  });
});

describe("tuning", () => {
  test("concurrency + deadline lookups", () => {
    expect(concurrencyFor("maintenance")).toBe(1);
    expect(concurrencyFor("unknown")).toBe(1);
    expect(deadlineFor("ai-extract")).toBe(60_000);
    expect(() => deadlineFor("nope")).toThrow();
  });
});

describe("withDeadline", () => {
  test("a fast processor resolves; a slow one rejects with ProcessorDeadlineError", async () => {
    const fast = withDeadline("parse", 100, async () => "ok");
    expect(await fast({})).toBe("ok");
    const slow = withDeadline("parse", 20, async () => {
      await new Promise((r) => setTimeout(r, 100));
      return "late";
    });
    await expect(slow({})).rejects.toThrow(ProcessorDeadlineError);
  });
});

describe("deadLetter (PII-free, exhaustion-only)", () => {
  test("null while retries remain; a record on exhaustion with no payload", () => {
    expect(
      buildDeadLetter({
        queue: "sync",
        jobId: "j1",
        error: "boom",
        attemptsMade: 2,
        maxAttempts: 5,
      }),
    ).toBeNull();
    const dead = buildDeadLetter({
      queue: "sync",
      jobId: "j1",
      error: "boom",
      attemptsMade: 5,
      maxAttempts: 5,
    });
    expect(dead).toMatchObject({ queue: "sync", jobId: "j1", attemptsMade: 5 });
    expect(dead && "payload" in dead).toBe(false);
  });
});

describe("withLeaderLock", () => {
  const okRedis: LockRedis = { set: async () => "OK", eval: async () => 1 };
  const busyRedis: LockRedis = { set: async () => null, eval: async () => 0 };

  test("runs the fn only when the lock is acquired", async () => {
    let ran = 0;
    const r1 = await withLeaderLock(okRedis, "k", 1000, "tok", async () => {
      ran += 1;
      return "did-work";
    });
    expect(r1).toBe("did-work");
    expect(ran).toBe(1);
    const r2 = await withLeaderLock(busyRedis, "k", 1000, "tok", async () => {
      ran += 1;
      return "did-work";
    });
    expect(r2).toBeNull();
    expect(ran).toBe(1);
  });
});
