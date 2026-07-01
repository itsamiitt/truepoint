// estimate.ts — the pre-flight cost forecast (31 §6, ADR-0038). On upload the job runs a bounded random
// sample of rows through the full match-first path (but STOPS before any paid reveal), measures the internal
// match-rate, then extrapolates to the whole file: expected charged rows = residual × the provider's
// expected valid-hit rate; the credit forecast prices only those charged rows. Internal matches and unmatched
// rows contribute 0 (only matched_provider spends — ADR-0038). The matcher is INJECTED; this is pure logic.
//
// The forecast is a RANGE estimate, never a guarantee (it depends on live provider hit/verify rates — 31 §6);
// pricing-per-charged-match follows the placeholder credit model (07 §1), passed in — never hardcoded here.

import type { BulkEnrichEstimate, MatchOutcome } from "@leadwolf/types";
import { type MatchInputRow, buildMatchKeys } from "../matchKeys.ts";
import type { MatchContext, MatchPort } from "./matchPort.ts";

/** Provider-side stats used to forecast the paid residual. All learned from provider_calls telemetry. */
export interface ProviderHitStats {
  /** Expected fraction of residual (internally-unmatched) rows a provider will fill + verify (∈ [0,1]). */
  expectedValidRate: number;
  /** Credits charged per provider-matched row, in micros — the placeholder credit model (07 §1). */
  creditMicrosPerMatch: number;
}

export interface EstimateInput {
  /** Workspace scope the sample rows are matched in. */
  ctx: MatchContext;
  /** Total rows in the full upload — the count we extrapolate the sample's match-rate onto. */
  totalRowCount: number;
  /** The bounded random sample of rows (target ~1,000 rows or 1%, whichever larger — 31 §6). */
  sample: MatchInputRow[];
  /** The match-first port (overlay → master-graph), run WITHOUT any paid reveal — internal stages only. */
  matcher: MatchPort;
  /** Provider hit/verify stats + per-match price for the residual forecast. */
  providerStats: ProviderHitStats;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** A row counts as an internal match only when the matcher actually resolved it internally (free). */
function isInternalMatch(outcome: MatchOutcome): boolean {
  return outcome === "matched_internal";
}

/**
 * Forecast a bulk run from a sample: measure the sample's internal match-rate, extrapolate to totalRowCount,
 * then price the expected provider-charged residual. Returns rowCount/estimatedMatchRate/estimatedCreditMicros
 * (the BulkEnrichEstimate DTO). An empty sample yields a 0 match-rate and 0 credits (nothing measured).
 */
export async function estimateBulkEnrich(input: EstimateInput): Promise<BulkEnrichEstimate> {
  const sampleSize = input.sample.length;
  const rowCount = Math.max(0, Math.trunc(input.totalRowCount));

  if (sampleSize === 0) {
    return { rowCount, estimatedMatchRate: 0, estimatedCreditMicros: 0 };
  }

  let internalMatches = 0;
  for (const row of input.sample) {
    const result = await input.matcher.matchRow(buildMatchKeys(row), input.ctx);
    if (isInternalMatch(result.outcome)) internalMatches += 1;
  }

  // Sample-measured internal match-rate, extrapolated to the whole file.
  const estimatedMatchRate = clamp01(internalMatches / sampleSize);
  const matchedRows = Math.round(estimatedMatchRate * rowCount);
  const residualRows = Math.max(0, rowCount - matchedRows);

  // Only the residual reaches providers; only the provider-valid fraction is CHARGED (ADR-0038).
  const expectedValidRate = clamp01(input.providerStats.expectedValidRate);
  const chargedRows = Math.round(residualRows * expectedValidRate);
  const estimatedCreditMicros = Math.max(
    0,
    Math.round(chargedRows * input.providerStats.creditMicrosPerMatch),
  );

  return { rowCount, estimatedMatchRate, estimatedCreditMicros };
}

/**
 * The WORST-CASE credit CEILING for a bulk run (prospect-database-platform I3 / audit A3/P08). Unlike
 * estimateBulkEnrich (EXPECTED value = residual × the provider's expected valid rate), this assumes EVERY
 * internally-unmatched row reaches a provider AND charges — the absolute upper bound the confirm gate + the
 * per-run cap enforce, so a bulk run can NEVER exceed the confirmed budget. Reuses the sample-measured internal
 * match-rate to size the residual; with no sample it assumes every row could charge (the true, conservative
 * ceiling). Pure logic; the matcher is injected; pricing-per-match is passed in (07 §1), never hardcoded.
 */
export async function worstCaseBulkEnrichMicros(input: EstimateInput): Promise<BulkEnrichEstimate> {
  const sampleSize = input.sample.length;
  const rowCount = Math.max(0, Math.trunc(input.totalRowCount));

  if (sampleSize === 0) {
    // No sample measured → the ceiling is EVERY row charging (conservative — the gate must never under-estimate).
    const worst = Math.max(0, Math.round(rowCount * input.providerStats.creditMicrosPerMatch));
    return { rowCount, estimatedMatchRate: 0, estimatedCreditMicros: worst };
  }

  let internalMatches = 0;
  for (const row of input.sample) {
    const result = await input.matcher.matchRow(buildMatchKeys(row), input.ctx);
    if (isInternalMatch(result.outcome)) internalMatches += 1;
  }

  const estimatedMatchRate = clamp01(internalMatches / sampleSize);
  const matchedRows = Math.round(estimatedMatchRate * rowCount);
  const residualRows = Math.max(0, rowCount - matchedRows);
  // WORST case: the whole residual charges (expectedValidRate pinned to 1) — the ceiling, not the mean.
  const estimatedCreditMicros = Math.max(
    0,
    Math.round(residualRows * input.providerStats.creditMicrosPerMatch),
  );

  return { rowCount, estimatedMatchRate, estimatedCreditMicros };
}
