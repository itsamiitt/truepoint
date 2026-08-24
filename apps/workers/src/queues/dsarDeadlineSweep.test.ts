// dsarDeadlineSweep.test.ts — the DSAR breach probe's observable contract.
//
// The behaviour worth pinning is not "it finds overdue rows" but what it publishes when it finds NONE: a
// gauge written only on breach is indistinguishable from a sweep that died, because both look like a series
// that stopped. That case is asserted first and explicitly.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { complianceGaugesSnapshot, resetComplianceMetrics } from "../metrics.ts";
import { makeProcessDsarDeadlineSweep } from "./dsarDeadlineSweep.ts";

// The leader lock is Redis-backed; the sweep passes its connection straight through to withLeaderLock, so the
// test double only needs to satisfy the calls that helper makes. Mocking the module keeps this a unit test.
mock.module("../leaderLock.ts", () => ({
  withLeaderLock: async (
    _redis: unknown,
    _key: string,
    _ttl: number,
    fn: () => Promise<void>,
  ): Promise<void> => {
    await fn();
  },
}));

const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
mock.module("../logger.ts", () => ({
  log: {
    warn: (message: string, fields: Record<string, unknown>) => warnings.push({ message, fields }),
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

const redis = {} as never;
const job = {} as never;

// A FIXED clock, handed to the sweep. The first version of this file read the wall clock in BOTH the sweep
// and the fixture, and the fixture read it second — so an age built as "28 hours ago" was really 28 hours
// minus the microseconds between the two reads, which Math.floor turned into 27. It passed locally (same
// millisecond) and failed on the runner, while the sibling branch running the identical test passed. That is
// what makes this class expensive: intermittent, not wrong. Padding the fixture would have hidden it; taking
// the clock as a dependency removes wall-time from the assertions entirely.
const NOW = new Date("2026-08-22T12:00:00.000Z");
const clock = () => NOW;

function hoursAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 3_600_000);
}

describe("dsarDeadlineSweep", () => {
  beforeEach(() => {
    resetComplianceMetrics();
    warnings.length = 0;
  });

  test("publishes zeroes when nothing is overdue, rather than leaving the series absent", async () => {
    const process = makeProcessDsarDeadlineSweep(redis, {
      now: clock,
      findOverdue: async () => [],
    });
    await process(job);

    // Both gauges present and zero. If either were merely absent, a collector could not tell "no breaches"
    // from "the sweep stopped running", and the alert would go quiet in exactly the case it exists for.
    expect(complianceGaugesSnapshot().get("dsar_overdue")).toBe(0);
    expect(complianceGaugesSnapshot().get("dsar_oldest_overdue_seconds")).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  test("reports the count and the age of the WORST breach", async () => {
    const process = makeProcessDsarDeadlineSweep(redis, {
      now: clock,
      findOverdue: async () => [
        {
          id: "11111111-1111-4111-8111-111111111111",
          requestType: "access",
          status: "verifying",
          requestedAt: hoursAgo(80),
          dueAt: hoursAgo(8),
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          requestType: "delete",
          status: "processing",
          requestedAt: hoursAgo(120),
          dueAt: hoursAgo(48),
        },
      ],
    });
    await process(job);

    expect(complianceGaugesSnapshot().get("dsar_overdue")).toBe(2);
    // 48h, not the 8h of the first row: the age is recomputed across all rows rather than trusting the
    // query's ORDER BY, so an upstream sort change cannot silently under-report the worst breach.
    // Exact, not a tolerance window — with the clock injected there is no drift left to absorb, and a range
    // here would quietly re-admit the off-by-one-second class this file was just fixed for.
    expect(complianceGaugesSnapshot().get("dsar_oldest_overdue_seconds")).toBe(48 * 3600);
  });

  test("logs ids, types and statuses — never the data subject", async () => {
    const process = makeProcessDsarDeadlineSweep(redis, {
      now: clock,
      findOverdue: async () => [
        {
          id: "33333333-3333-4333-8333-333333333333",
          requestType: "delete",
          status: "verifying",
          requestedAt: hoursAgo(100),
          dueAt: hoursAgo(28),
        },
      ],
    });
    await process(job);

    expect(warnings).toHaveLength(1);
    const entry = warnings[0];
    expect(entry?.fields.count).toBe(1);
    expect(entry?.fields.oldestOverdueHours).toBe(28);

    // The whole log payload must not carry anything that identifies the person behind the request. This is
    // the assertion that keeps a future "add the email so support can chase it" from landing unnoticed —
    // findOverdue does not select the subject column, and this fails if that ever changes.
    const serialised = JSON.stringify(entry?.fields ?? {});
    expect(serialised).not.toContain("@");
    expect(serialised.toLowerCase()).not.toContain("email");
    expect(serialised.toLowerCase()).not.toContain("subject");
  });

  test("flags truncation so a capped reading is never read as the whole picture", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
      requestType: "access",
      status: "verifying",
      requestedAt: hoursAgo(100),
      dueAt: hoursAgo(10),
    }));
    const process = makeProcessDsarDeadlineSweep(redis, {
      now: clock,
      findOverdue: async () => rows,
    });
    await process(job);

    expect(complianceGaugesSnapshot().get("dsar_overdue")).toBe(500);
    expect(warnings[0]?.fields.truncated).toBe(true);
    // Ten ids at most: a log line, not a report.
    expect((warnings[0]?.fields.requests as unknown[]).length).toBe(10);
  });
});
