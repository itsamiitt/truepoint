import { afterEach, describe, expect, test } from "bun:test";
import { invalidateCachedRole, setRoleCacheInvalidator } from "./roleCache.ts";

afterEach(() => setRoleCacheInvalidator(null));

describe("role cache seam", () => {
  test("is a no-op when nothing is registered", async () => {
    // The default matters: packages/db is imported by processes that do not cache at all (workers, the auth
    // app), and a membership mutation there must not need a Redis client to exist.
    await expect(invalidateCachedRole("t", "w", "u")).resolves.toBeUndefined();
  });

  test("passes the full triple through — a user holds different roles per workspace", async () => {
    const calls: string[][] = [];
    setRoleCacheInvalidator(async (t, w, u) => {
      calls.push([t, w, u]);
    });
    await invalidateCachedRole("tenant-1", "ws-1", "user-1");
    expect(calls).toEqual([["tenant-1", "ws-1", "user-1"]]);
  });

  test("a failing invalidator does not propagate — the mutation has already committed", async () => {
    // The row is authoritative and correct by this point; throwing here would fail a membership change that
    // actually succeeded. The implementation is the one responsible for logging loudly.
    setRoleCacheInvalidator(async () => {
      throw new Error("redis down");
    });
    await expect(invalidateCachedRole("t", "w", "u")).resolves.toBeUndefined();
  });

  test("registering null disables it again", async () => {
    let called = 0;
    setRoleCacheInvalidator(async () => {
      called += 1;
    });
    await invalidateCachedRole("t", "w", "u");
    setRoleCacheInvalidator(null);
    await invalidateCachedRole("t", "w", "u");
    expect(called).toBe(1);
  });
});
