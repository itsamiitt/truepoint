// cache.test.ts — pins the two guarantees of the LOOKUP warm cache (single-flight + TTL) and the correctness
// rules that keep it from serving stale truth (successes-only, cleared on mutation). `now` is passed
// explicitly so the TTL is deterministic without fake timers, matching captureQueue.due(now).
import { describe, expect, test } from "bun:test";
import type { SubjectStatus } from "../../shared/types.ts";
import { LookupCache } from "./cache.ts";

function status(outcome: SubjectStatus["outcome"]): SubjectStatus {
  return { contactId: null, known: false, owned: false, outcome };
}

describe("LookupCache", () => {
  test("coalesces concurrent lookups for the same key into ONE fetch", async () => {
    const cache = new LookupCache();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve(status("found"));
    };

    // The nav and the DOM-settle that follows it both fire before the first resolves.
    const [a, b] = await Promise.all([
      cache.resolve("jane", fetcher),
      cache.resolve("jane", fetcher),
    ]);

    expect(calls).toBe(1);
    expect(a.outcome).toBe("found");
    expect(b.outcome).toBe("found");
  });

  test("serves a cached result inside the TTL, re-fetches after it", async () => {
    const cache = new LookupCache(60_000);
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve(status("in_database"));
    };

    await cache.resolve("jane", fetcher, 1_000_000);
    await cache.resolve("jane", fetcher, 1_000_000 + 30_000); // inside window → cached
    expect(calls).toBe(1);

    await cache.resolve("jane", fetcher, 1_000_000 + 61_000); // past window → re-fetch
    expect(calls).toBe(2);
  });

  test("keys are independent — one subject's cache never answers another", async () => {
    const cache = new LookupCache();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve(status("found"));
    };

    await cache.resolve("jane", fetcher);
    await cache.resolve("john", fetcher);
    expect(calls).toBe(2);
  });

  test("does NOT cache a failed resolution (a blip must not stick for the window)", async () => {
    const cache = new LookupCache();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(status("found"));
    };

    await expect(cache.resolve("jane", fetcher, 1000)).rejects.toThrow("offline");
    // Immediately after, the same key must re-attempt rather than serving the failure.
    const second = await cache.resolve("jane", fetcher, 1001);
    expect(second.outcome).toBe("found");
    expect(calls).toBe(2);
  });

  test("invalidate(key) forces a re-fetch of just that subject", async () => {
    const cache = new LookupCache();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve(status("in_database"));
    };

    await cache.resolve("jane", fetcher, 1000);
    cache.invalidate("jane");
    await cache.resolve("jane", fetcher, 1001); // within TTL, but invalidated → re-fetch
    expect(calls).toBe(2);
  });

  test("clear() drops every entry (scope change / reveal / add)", async () => {
    const cache = new LookupCache();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve(status("found"));
    };

    await cache.resolve("jane", fetcher, 1000);
    await cache.resolve("john", fetcher, 1000);
    cache.clear();
    await cache.resolve("jane", fetcher, 1001);
    await cache.resolve("john", fetcher, 1001);
    expect(calls).toBe(4);
  });
});
