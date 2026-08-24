// enrichment.test.ts — the processor's deferral/park/jitter semantics, hermetic: enrichContact is
// injected (deps.enrichContactFn — no module mocks; bun's mock.module is process-global), the deferral
// sink is a spy, jitter is identity where determinism matters and range-asserted where it isn't.

import { describe, expect, test } from "bun:test";
import type { EnrichContactResult } from "@leadwolf/core";
import { type EnrichmentJobData, ValidationError } from "@leadwolf/types";
import { type Job, UnrecoverableError } from "bullmq";
import { makeProcessEnrichment } from "./enrichment.ts";

const DATA: EnrichmentJobData = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  contactId: "33333333-3333-3333-3333-333333333333",
  fields: ["email"],
};

function job(data: EnrichmentJobData): Job<EnrichmentJobData> {
  return { data } as Job<EnrichmentJobData>;
}

const THROTTLED: EnrichContactResult = {
  status: "unfilled",
  provider: null,
  filled: [],
  costMicros: 0,
  allThrottled: true,
  retryAfterMs: 40_000,
};

function harness(
  result: EnrichContactResult,
  opts: Parameters<typeof makeProcessEnrichment>[0] = {},
) {
  const deferred: Array<{ data: EnrichmentJobData; delayMs: number }> = [];
  const process = makeProcessEnrichment({
    enrichContactFn: () => Promise.resolve(result),
    defer: (data, delayMs) => {
      deferred.push({ data, delayMs });
      return Promise.resolve();
    },
    ...opts,
  });
  return { process, deferred };
}

describe("processEnrichment — throttle deferral", () => {
  test("all-throttled defers with the vendor delay (identity jitter) and bumps the counter", async () => {
    const { process, deferred } = harness(THROTTLED, { jitter: (ms) => ms });
    const result = await process(job(DATA));
    expect(result.status).toBe("unfilled");
    expect(deferred).toEqual([{ data: { ...DATA, deferrals: 1 }, delayMs: 40_000 }]);
  });

  test("the default jitter spreads UP: delay ∈ [base, 1.5×base] — never earlier than Retry-After", async () => {
    const { process, deferred } = harness(THROTTLED);
    await process(job(DATA));
    expect(deferred).toHaveLength(1);
    const delay = deferred[0]?.delayMs ?? 0;
    expect(delay).toBeGreaterThanOrEqual(40_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  test("PARKS above maxDeferDelayMs: a daily-budget horizon returns unfilled with NO re-enqueue", async () => {
    const dayLong: EnrichContactResult = { ...THROTTLED, retryAfterMs: 86_400_000 };
    const { process, deferred } = harness(dayLong, { maxDeferDelayMs: 1_800_000 });
    const result = await process(job(DATA));
    expect(result.status).toBe("unfilled");
    expect(deferred).toEqual([]);
  });

  test("stops at maxDeferrals — the final unfilled result stands", async () => {
    const { process, deferred } = harness(THROTTLED, { jitter: (ms) => ms, maxDeferrals: 3 });
    await process(job({ ...DATA, deferrals: 3 }));
    expect(deferred).toEqual([]);
  });

  test("no deferral when something was filled or nothing was throttled", async () => {
    const filled: EnrichContactResult = {
      status: "enriched",
      provider: "apollo",
      filled: ["email"],
      costMicros: 30_000,
    };
    const { process, deferred } = harness(filled);
    await process(job(DATA));
    expect(deferred).toEqual([]);
  });

  test("permanent failures still map to UnrecoverableError (straight to the DLQ)", async () => {
    const process = makeProcessEnrichment({
      enrichContactFn: () => Promise.reject(new ValidationError("bad fields")),
    });
    await expect(process(job(DATA))).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
