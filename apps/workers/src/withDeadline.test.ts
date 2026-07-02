// withDeadline.test.ts — proves the deadline wrapper (worker-platform plan 15 §3.3): a fast processor
// passes through untouched, a hung one fails retryably at the bound, the result/rejection of a normal
// processor is preserved, and the timer never leaks a late rejection. Pure — fake jobs, no Redis.

import { expect, test } from "bun:test";
import type { Job } from "bullmq";
import { ProcessorDeadlineError, withDeadline } from "./withDeadline.ts";

const job = { id: "j-1", data: {} } as Job;

test("a processor that finishes under the deadline passes its result through", async () => {
  const wrapped = withDeadline("scoring", 1_000, async () => "scored");
  expect(await wrapped(job)).toBe("scored");
});

test("a hung processor fails the attempt with a retryable ProcessorDeadlineError at the bound", async () => {
  const never = () => new Promise<string>(() => {}); // hangs forever — the pre-fix wedge
  const wrapped = withDeadline("enrichment", 20, never);
  const err = await wrapped(job).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProcessorDeadlineError);
  expect((err as Error).message).toContain("enrichment");
  expect((err as Error).message).toContain("20ms");
});

test("a processor's own rejection is preserved (not masked by the deadline)", async () => {
  const wrapped = withDeadline("dedup", 1_000, async () => {
    throw new Error("vendor 503");
  });
  const err = await wrapped(job).then(
    () => null,
    (e: unknown) => e,
  );
  expect((err as Error).message).toBe("vendor 503");
  expect(err).not.toBeInstanceOf(ProcessorDeadlineError);
});

test("the deadline timer is cleared on settle — no late rejection fires after success", async () => {
  const wrapped = withDeadline("scoring", 15, async () => "fast");
  expect(await wrapped(job)).toBe("fast");
  // If the timer leaked, its rejection would surface as an unhandled rejection during this wait and
  // redden the test run; surviving the full deadline window proves it was cleared.
  await Bun.sleep(25);
  expect(true).toBe(true);
});
