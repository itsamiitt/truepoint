// estimate.test.ts — the sample-based forecast (31 §6). A FAKE MatchPort decides each sample row's outcome;
// we assert the measured internal match-rate, the residual×valid-rate charged-row extrapolation, and the
// credit forecast (only matched_provider residual spends — ADR-0038). Pure logic; no @leadwolf/db.

import { describe, expect, test } from "bun:test";
import type { MatchInputRow } from "../matchKeys.ts";
import { type ProviderHitStats, estimateBulkEnrich } from "./estimate.ts";
import type { MatchContext, MatchPort, MatchRowResult } from "./matchPort.ts";

const CTX: MatchContext = { workspaceId: "ws-1" };

/** A matcher that resolves rows internally iff the row carries an email (a deterministic, testable rule). */
const emailMatcher: MatchPort = {
  matchRow(keys): Promise<MatchRowResult> {
    return Promise.resolve(
      keys.emailIndex
        ? { method: "deterministic_email", outcome: "matched_internal", confidence: 1 }
        : { method: "none", outcome: "unmatched" },
    );
  },
};

const STATS: ProviderHitStats = { expectedValidRate: 0.5, creditMicrosPerMatch: 2_000 };

describe("estimateBulkEnrich", () => {
  test("measures the sample match-rate and prices only the provider-charged residual", async () => {
    // 2 of 4 sample rows carry an email → 50% internal match-rate.
    const sample: MatchInputRow[] = [
      { email: "a@acme.com" },
      { email: "b@acme.com" },
      { fullName: "No Email" },
      { phone: "+14155552671" },
    ];
    const estimate = await estimateBulkEnrich({
      ctx: CTX,
      totalRowCount: 1000,
      sample,
      matcher: emailMatcher,
      providerStats: STATS,
    });

    expect(estimate.rowCount).toBe(1000);
    expect(estimate.estimatedMatchRate).toBe(0.5);
    // matched = round(0.5 * 1000) = 500; residual = 500; charged = round(500 * 0.5) = 250;
    // credits = 250 * 2_000µ = 500_000µ.
    expect(estimate.estimatedCreditMicros).toBe(500_000);
  });

  test("a fully-internal sample forecasts zero provider spend", async () => {
    const estimate = await estimateBulkEnrich({
      ctx: CTX,
      totalRowCount: 200,
      sample: [{ email: "a@acme.com" }, { email: "b@acme.com" }],
      matcher: emailMatcher,
      providerStats: STATS,
    });
    expect(estimate.estimatedMatchRate).toBe(1);
    expect(estimate.estimatedCreditMicros).toBe(0);
  });

  test("an empty sample yields a 0 match-rate and 0 credits (nothing measured)", async () => {
    const estimate = await estimateBulkEnrich({
      ctx: CTX,
      totalRowCount: 5000,
      sample: [],
      matcher: emailMatcher,
      providerStats: STATS,
    });
    expect(estimate).toEqual({ rowCount: 5000, estimatedMatchRate: 0, estimatedCreditMicros: 0 });
  });

  test("a needs-review fuzzy row counts as residual, not as an internal match", async () => {
    const reviewMatcher: MatchPort = {
      matchRow(): Promise<MatchRowResult> {
        return Promise.resolve({
          method: "fuzzy_name_company",
          outcome: "unmatched",
          confidence: 0.4,
          needsReview: true,
        });
      },
    };
    const estimate = await estimateBulkEnrich({
      ctx: CTX,
      totalRowCount: 100,
      sample: [{ fullName: "X", companyName: "Y" }],
      matcher: reviewMatcher,
      providerStats: { expectedValidRate: 1, creditMicrosPerMatch: 1_000 },
    });
    expect(estimate.estimatedMatchRate).toBe(0); // unmatched, even though it's a fuzzy near-miss
    // residual = 100, valid-rate 1 → 100 charged → 100_000µ.
    expect(estimate.estimatedCreditMicros).toBe(100_000);
  });

  test("clamps a sample-vs-total rounding overshoot so the residual never goes negative", async () => {
    // 1/1 sample matched (rate 1) but total 0 → matched rounds to 0, residual 0, no negative spend.
    const estimate = await estimateBulkEnrich({
      ctx: CTX,
      totalRowCount: 0,
      sample: [{ email: "a@acme.com" }],
      matcher: emailMatcher,
      providerStats: STATS,
    });
    expect(estimate.rowCount).toBe(0);
    expect(estimate.estimatedCreditMicros).toBe(0);
  });
});
