// bulkEnrichment.test.ts — guards the bulk CSV enrichment contracts. These schemas are the single source of
// truth shared by apps/api (producer), apps/workers (consumer), and apps/web (polling UI), so they must
// (1) accept a well-formed job-status payload across the lifecycle, (2) round-trip the options + row-result
// DTOs, and (3) reject the two ways a caller most easily gets it wrong: a status outside the closed enum and
// a confidence/match-rate outside the 0–1 range. Pure unit test (no DB, no sibling units).

import { describe, expect, it } from "bun:test";
import {
  BULK_ENRICHMENT_DLQ,
  BULK_ENRICHMENT_QUEUE,
  bulkEnrichEstimateSchema,
  bulkEnrichJobRefSchema,
  bulkEnrichJobStatusResponseSchema,
  bulkEnrichProgressSchema,
  bulkEnrichRowResultSchema,
  bulkEnrichmentOptionsSchema,
  enrichmentJobStatus,
  matchMethod,
  matchOutcome,
} from "./bulkEnrichment.ts";

describe("bulk-enrichment queue constants", () => {
  it("pins the queue + DLQ names (shared producer/consumer)", () => {
    expect(BULK_ENRICHMENT_QUEUE).toBe("bulk-enrichment");
    expect(BULK_ENRICHMENT_DLQ).toBe("bulk-enrichment-dlq");
  });
});

describe("enrichmentJobStatus", () => {
  it("is the closed lifecycle vocabulary", () => {
    const members = new Set<string>(enrichmentJobStatus.options);
    const expected = [
      "queued",
      "estimating",
      "awaiting_confirmation",
      "running",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ];
    expect(members.size).toBe(expected.length);
    for (const v of expected) {
      expect(members.has(v)).toBe(true);
    }
  });
});

describe("bulkEnrichmentOptionsSchema", () => {
  it("round-trips well-formed options (incl. optional cost cap)", () => {
    const parsed = bulkEnrichmentOptionsSchema.parse({
      providersEnabled: true,
      parallelCheapMode: false,
      confidenceThreshold: 0.8,
      maxProviderCostMicros: 5_000_000,
    });
    expect(parsed.confidenceThreshold).toBe(0.8);
    expect(parsed.maxProviderCostMicros).toBe(5_000_000);
  });

  it("accepts options without the optional cost cap", () => {
    const parsed = bulkEnrichmentOptionsSchema.parse({
      providersEnabled: false,
      parallelCheapMode: true,
      confidenceThreshold: 0,
    });
    expect(parsed.maxProviderCostMicros).toBeUndefined();
  });

  it("rejects a confidenceThreshold outside the 0–1 range", () => {
    expect(
      bulkEnrichmentOptionsSchema.safeParse({
        providersEnabled: true,
        parallelCheapMode: true,
        confidenceThreshold: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe("bulkEnrichJobRefSchema", () => {
  it("accepts a 202 accept-response job ref", () => {
    const parsed = bulkEnrichJobRefSchema.parse({ jobId: "be_1", status: "queued" });
    expect(parsed.status).toBe("queued");
  });

  it("rejects a status outside the closed enum", () => {
    expect(bulkEnrichJobRefSchema.safeParse({ jobId: "be_1", status: "active" }).success).toBe(
      false,
    );
  });
});

describe("bulkEnrichEstimateSchema", () => {
  it("round-trips a pre-flight estimate", () => {
    const parsed = bulkEnrichEstimateSchema.parse({
      rowCount: 1000,
      estimatedMatchRate: 0.62,
      estimatedCreditMicros: 12_500_000,
    });
    expect(parsed.rowCount).toBe(1000);
  });

  it("rejects an estimatedMatchRate above 1", () => {
    expect(
      bulkEnrichEstimateSchema.safeParse({
        rowCount: 10,
        estimatedMatchRate: 1.2,
        estimatedCreditMicros: 0,
      }).success,
    ).toBe(false);
  });
});

describe("bulkEnrichProgressSchema", () => {
  it("round-trips a progress tick", () => {
    const parsed = bulkEnrichProgressSchema.parse({
      total: 100,
      processed: 40,
      matched: 30,
      enriched: 25,
      charged: 10,
      failed: 2,
    });
    expect(parsed.processed).toBe(40);
  });

  it("rejects a negative counter", () => {
    expect(
      bulkEnrichProgressSchema.safeParse({
        total: 100,
        processed: -1,
        matched: 0,
        enriched: 0,
        charged: 0,
        failed: 0,
      }).success,
    ).toBe(false);
  });
});

describe("bulkEnrichRowResultSchema", () => {
  it("round-trips a matched row carrying the optional facets", () => {
    const parsed = bulkEnrichRowResultSchema.parse({
      rowIndex: 0,
      matchMethod: "deterministic_email",
      matchOutcome: "matched_internal",
      matchConfidence: 0.99,
      enrichedFields: ["email", "phone"],
      providerSource: "apollo",
      emailStatus: "valid",
    });
    expect(parsed.matchMethod).toBe("deterministic_email");
    expect(parsed.emailStatus).toBe("valid");
  });

  it("accepts an unmatched row with only the required facets", () => {
    const parsed = bulkEnrichRowResultSchema.parse({
      rowIndex: 5,
      matchMethod: "none",
      matchOutcome: "unmatched",
    });
    expect(parsed.matchConfidence).toBeUndefined();
  });

  it("reuses the existing email_status value set", () => {
    expect(
      bulkEnrichRowResultSchema.safeParse({
        rowIndex: 0,
        matchMethod: "provider",
        matchOutcome: "matched_provider",
        emailStatus: "catch_all",
      }).success,
    ).toBe(true);
    // a value outside the email_status set is rejected
    expect(
      bulkEnrichRowResultSchema.safeParse({
        rowIndex: 0,
        matchMethod: "provider",
        matchOutcome: "matched_provider",
        emailStatus: "bounced",
      }).success,
    ).toBe(false);
  });

  it("exposes the closed matchMethod + matchOutcome vocabularies", () => {
    expect(matchMethod.options).toContain("fuzzy_name_company");
    expect(matchOutcome.options).toContain("suppressed");
  });
});

describe("bulkEnrichJobStatusResponseSchema", () => {
  it("accepts a settled job (progress + estimate + downloadUrl present)", () => {
    const parsed = bulkEnrichJobStatusResponseSchema.parse({
      jobId: "be_1",
      status: "completed",
      progress: {
        total: 100,
        processed: 100,
        matched: 80,
        enriched: 75,
        charged: 60,
        failed: 0,
      },
      estimate: { rowCount: 100, estimatedMatchRate: 0.8, estimatedCreditMicros: 1_000_000 },
      downloadUrl: "https://example.test/results.csv",
      failedReason: null,
    });
    expect(parsed.status).toBe("completed");
    expect(parsed.downloadUrl).toBe("https://example.test/results.csv");
  });

  it("accepts a freshly-queued job (nullable fields null)", () => {
    const parsed = bulkEnrichJobStatusResponseSchema.parse({
      jobId: "be_1",
      status: "queued",
      progress: null,
      estimate: null,
      downloadUrl: null,
      failedReason: null,
    });
    expect(parsed.progress).toBeNull();
  });

  it("rejects a status outside the closed enum", () => {
    const result = bulkEnrichJobStatusResponseSchema.safeParse({
      jobId: "be_1",
      status: "unknown",
      progress: null,
      estimate: null,
      downloadUrl: null,
      failedReason: null,
    });
    expect(result.success).toBe(false);
  });
});
