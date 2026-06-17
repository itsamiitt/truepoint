// jobStatus.test.ts — guards the pure control-row → EnrichmentJobSummary mapping (G-ENR-4). No DB: it builds a
// JobRecord fixture and asserts the derived progress fraction, the derived failed count, the ISO timestamps,
// and that the output validates against the shared @leadwolf/types schema (so the surface never drifts from the
// contract). The repository-backed list/get functions are exercised by the workspace-scoped itest.

import { describe, expect, it } from "bun:test";
import type { JobRecord } from "@leadwolf/db";
import { enrichmentJobSummarySchema } from "@leadwolf/types";
import { toEnrichmentJobSummary } from "./jobStatus.ts";

function record(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "ej_1",
    sourceName: "leads.csv",
    status: "running",
    totalRows: 100,
    processedRows: 40,
    matchedRows: 30,
    enrichedRows: 25,
    chargedRows: 10,
    creditEstimateMicros: 1_000_000,
    creditSpentMicros: 250_000,
    columnMapping: {},
    options: {},
    idempotencyKey: null,
    createdAt: new Date("2026-06-17T10:00:00.000Z"),
    startedAt: new Date("2026-06-17T10:01:00.000Z"),
    completedAt: null,
    failedReason: null,
    ...over,
  };
}

describe("toEnrichmentJobSummary", () => {
  it("derives the progress fraction (processed ÷ total) and validates against the contract", () => {
    const summary = toEnrichmentJobSummary(record());
    expect(summary.progress).toBeCloseTo(0.4, 5);
    expect(enrichmentJobSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("reports failed = 0 for an in-flight job (processed leads matched while rows are still pending)", () => {
    // A running job with 40 processed / 30 matched has 10 rows still in the waterfall, NOT 10 failures.
    expect(toEnrichmentJobSummary(record()).counts.failed).toBe(0);
  });

  it("derives failed = processed − matched (floored at 0) once the job is settled", () => {
    // Settled: 50 processed − 30 matched = 20 genuinely unresolved rows.
    expect(
      toEnrichmentJobSummary(record({ status: "completed", processedRows: 50, matchedRows: 30 }))
        .counts.failed,
    ).toBe(20);
    // matched can't exceed processed in practice, but the floor guards a stray over-count from going negative.
    expect(
      toEnrichmentJobSummary(record({ status: "completed", processedRows: 5, matchedRows: 8 }))
        .counts.failed,
    ).toBe(0);
    // Cancelled is terminal too.
    expect(
      toEnrichmentJobSummary(record({ status: "cancelled", processedRows: 10, matchedRows: 4 }))
        .counts.failed,
    ).toBe(6);
  });

  it("reports 0 progress for a job with no rows yet (no divide-by-zero)", () => {
    const summary = toEnrichmentJobSummary(record({ totalRows: 0, processedRows: 0 }));
    expect(summary.progress).toBe(0);
  });

  it("clamps progress to 1 even if processed over-counts total", () => {
    expect(toEnrichmentJobSummary(record({ totalRows: 10, processedRows: 12 })).progress).toBe(1);
  });

  it("ISO-formats the lifecycle timestamps and passes nulls through", () => {
    const summary = toEnrichmentJobSummary(record());
    expect(summary.createdAt).toBe("2026-06-17T10:00:00.000Z");
    expect(summary.startedAt).toBe("2026-06-17T10:01:00.000Z");
    expect(summary.completedAt).toBeNull();
  });

  it("carries the failure reason on a failed job", () => {
    const summary = toEnrichmentJobSummary(
      record({
        status: "failed",
        processedRows: 100,
        completedAt: new Date("2026-06-17T10:05:00.000Z"),
        failedReason: "provider budget exhausted",
      }),
    );
    expect(summary.status).toBe("failed");
    expect(summary.failedReason).toBe("provider budget exhausted");
    expect(enrichmentJobSummarySchema.safeParse(summary).success).toBe(true);
  });
});
