// deadLetter.test.ts — proves the generic dead-letter routing (worker-platform plan 15 §2.4): the exhaustion
// guard (retries remaining → no-op), scope extraction from BOTH payload shapes, the PII rule (the record never
// carries payload fields), the options-less default budget of 1, and that the handler never throws even when
// the DLQ enqueue itself fails. Pure — fake Job/Queue objects, no Redis.

import { expect, test } from "bun:test";
import type { Job, Queue } from "bullmq";
import {
  type WorkerDeadLetter,
  buildDeadLetter,
  extractScope,
  makeDeadLetterHandler,
} from "./deadLetter.ts";

type FakeJob = Pick<Job, "id" | "name" | "data" | "opts" | "attemptsMade">;

function fakeJob(overrides: Partial<FakeJob>): FakeJob {
  return {
    id: "job-1",
    name: "work",
    data: {},
    opts: { attempts: 3 },
    attemptsMade: 3,
    ...overrides,
  };
}

function fakeDlq(sink: WorkerDeadLetter[], failWith?: Error): Queue<WorkerDeadLetter> {
  return {
    add: (_name: string, record: WorkerDeadLetter) => {
      if (failWith) return Promise.reject(failWith);
      sink.push(record);
      return Promise.resolve({});
    },
  } as unknown as Queue<WorkerDeadLetter>;
}

test("retries remaining → null (BullMQ will retry; nothing dead-lettered)", () => {
  const job = fakeJob({ attemptsMade: 2, opts: { attempts: 3 } });
  expect(buildDeadLetter("enrichment", job, new Error("boom"))).toBeNull();
});

test("exhausted job → record with queue/provenance/reason and top-level scope", () => {
  const job = fakeJob({
    data: { tenantId: "t-1", workspaceId: "w-1", contactId: "c-1" },
    attemptsMade: 3,
  });
  const record = buildDeadLetter("enrichment", job, new Error("vendor 503"));
  expect(record).toEqual({
    queue: "enrichment",
    originalJobId: "job-1",
    jobName: "work",
    failedReason: "vendor 503",
    attemptsMade: 3,
    tenantId: "t-1",
    workspaceId: "w-1",
  });
});

test("nested { scope: {...} } payload shape (master-backfill/reverification) is extracted", () => {
  expect(extractScope({ scope: { tenantId: "t-2", workspaceId: "w-2" }, batchSize: 5 })).toEqual({
    tenantId: "t-2",
    workspaceId: "w-2",
  });
});

test("PII rule: the record never carries payload fields (dsar subjectEmail stays out)", () => {
  const job = fakeJob({
    name: "dsar",
    data: { requestId: "r-1", requestType: "delete", subjectEmail: "person@example.com" },
  });
  const record = buildDeadLetter("dsar", job, new Error("db down"));
  expect(record).not.toBeNull();
  // No scope in the dsar payload → nulls; the BullMQ failed set keeps the original job for lookup.
  expect(record?.tenantId).toBeNull();
  expect(record?.workspaceId).toBeNull();
  // The record's serialized form must not contain the payload's PII, and only the fixed field set.
  expect(JSON.stringify(record)).not.toContain("person@example.com");
  expect(JSON.stringify(record)).not.toContain("requestId");
  expect(Object.keys(record ?? {}).sort()).toEqual([
    "attemptsMade",
    "failedReason",
    "jobName",
    "originalJobId",
    "queue",
    "tenantId",
    "workspaceId",
  ]);
});

test("options-less job defaults to a budget of 1 → first failure dead-letters (pre-0.1 producers)", () => {
  const job = fakeJob({ opts: {}, attemptsMade: 1 });
  expect(buildDeadLetter("scoring", job, new Error("boom"))).not.toBeNull();
});

test("handler routes exhausted jobs and skips undefined jobs", async () => {
  const sink: WorkerDeadLetter[] = [];
  const handler = makeDeadLetterHandler("dedup", fakeDlq(sink));
  handler(undefined, new Error("no job"));
  handler(fakeJob({ attemptsMade: 3 }) as Job, new Error("boom"));
  await Bun.sleep(0); // let the fire-and-forget add settle
  expect(sink).toHaveLength(1);
  expect(sink[0]?.queue).toBe("dedup");
});

test("handler swallows a DLQ enqueue failure (never throws in the worker event loop)", async () => {
  const handler = makeDeadLetterHandler("dedup", fakeDlq([], new Error("redis down")));
  expect(() => handler(fakeJob({}) as Job, new Error("boom"))).not.toThrow();
  await Bun.sleep(0); // the rejection is caught + logged, not unhandled
});
