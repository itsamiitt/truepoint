// captureQueue.test.ts — pins the DURABILITY semantics of the capture buffer. Both behaviours asserted here
// were real data-loss bugs: an item claimed by a service worker that then died was never retried again, and a
// 400 response deleted the user's capture outright.
//
// `shared/idb.ts` is mock.module'd with an in-memory store because bun's test runtime has no IndexedDB. The
// mock is registered before importing CaptureQueue so the module graph picks it up.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CapturedRecord } from "../../shared/types.ts";

interface FakeRow {
  idempotencyKey: string;
  [key: string]: unknown;
}

const store = new Map<string, FakeRow>();

mock.module("../../shared/idb.ts", () => ({
  db: async () => ({
    get: async (_table: string, key: string) => store.get(key),
    getAll: async () => [...store.values()],
    put: async (_table: string, value: FakeRow) => {
      store.set(value.idempotencyKey, value);
    },
    delete: async (_table: string, key: string) => {
      store.delete(key);
    },
    count: async () => store.size,
  }),
}));

const { CaptureQueue } = await import("./captureQueue.ts");

function record(subjectKey: string): CapturedRecord {
  return {
    adapter: "linkedin",
    pageType: "profile",
    subjectKey,
    sourceUrl: `https://www.linkedin.com/in/${subjectKey}/`,
    capturedAt: new Date(0).toISOString(),
    fields: { fullName: "Jane Doe" },
  } as unknown as CapturedRecord;
}

describe("CaptureQueue — inflight reaping", () => {
  beforeEach(() => store.clear());

  test("a fresh inflight claim is NOT re-drained (no duplicate send in the same drain)", async () => {
    const queue = new CaptureQueue();
    const item = await queue.enqueue(record("jane"));
    const claimedAt = 1_000_000;
    await queue.markInflight(item.idempotencyKey, claimedAt);

    // One second later the request is still plausibly in flight.
    expect(await queue.due(claimedAt + 1_000)).toHaveLength(0);
  });

  test("an inflight claim older than the reap window IS re-drained", async () => {
    const queue = new CaptureQueue();
    const item = await queue.enqueue(record("jane"));
    const claimedAt = 1_000_000;
    await queue.markInflight(item.idempotencyKey, claimedAt);

    // This is the MV3 case: the worker was killed after claiming the item. Before the reaper existed, `due()`
    // returned nothing here forever and the capture was permanently lost.
    const due = await queue.due(claimedAt + 5 * 60 * 1000);
    expect(due).toHaveLength(1);
    expect(due[0]?.idempotencyKey).toBe(item.idempotencyKey);
  });

  test("an inflight row with no timestamp (written by an older build) reaps immediately", async () => {
    const queue = new CaptureQueue();
    const item = await queue.enqueue(record("jane"));
    // Simulate a pre-upgrade row: claimed, but without inflightSince.
    store.set(item.idempotencyKey, { ...item, status: "inflight" });

    expect(await queue.due(Date.now())).toHaveLength(1);
  });

  test("`failed` items are parked and never auto-retried", async () => {
    const queue = new CaptureQueue();
    const item = await queue.enqueue(record("jane"));
    store.set(item.idempotencyKey, { ...item, status: "failed" });

    expect(await queue.due(Date.now() + 10 * 60 * 1000)).toHaveLength(0);
  });

  test("backoff parks as `failed` after the attempt ceiling instead of deleting", async () => {
    const queue = new CaptureQueue();
    const item = await queue.enqueue(record("jane"));

    let current = { ...item };
    for (let i = 0; i < 8; i++) {
      await queue.backoff(current);
      current = store.get(item.idempotencyKey) as unknown as typeof item;
    }

    // Retained, not removed — a failed capture must remain inspectable rather than vanishing.
    expect(store.has(item.idempotencyKey)).toBe(true);
    expect(current.status).toBe("failed");
    expect(await queue.depth()).toBe(1);
  });

  test("enqueue is idempotent on the same subject + URL", async () => {
    const queue = new CaptureQueue();
    const a = await queue.enqueue(record("jane"));
    const b = await queue.enqueue(record("jane"));
    expect(b.idempotencyKey).toBe(a.idempotencyKey);
    expect(await queue.depth()).toBe(1);
  });
});
