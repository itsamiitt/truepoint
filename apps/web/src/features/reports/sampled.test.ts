import { describe, expect, test } from "bun:test";
import { REPORT_SAMPLE_LIMIT } from "./api.ts";

/**
 * The `sampled` flag decides whether the Reports page admits its numbers describe a sample. Getting it wrong
 * in the false direction re-hides exactly the defect it exists to surface (C-3.10: partial rollups presented
 * as totals), so the derivation is pinned here rather than left to a one-line expression nobody re-reads.
 */
function isSampled(revealCount: number, contactCount: number): boolean {
  return revealCount >= REPORT_SAMPLE_LIMIT || contactCount >= REPORT_SAMPLE_LIMIT;
}

describe("reports sample disclosure", () => {
  test("a workspace under the limit is NOT flagged — those totals really are totals", () => {
    expect(isSampled(0, 0)).toBe(false);
    expect(isSampled(REPORT_SAMPLE_LIMIT - 1, REPORT_SAMPLE_LIMIT - 1)).toBe(false);
  });

  test("hitting the limit EXACTLY counts as sampled", () => {
    // The boundary is the whole point: a full page back means there is very likely more behind it, and `>`
    // instead of `>=` would stay silent for precisely the workspace that first crosses into being wrong.
    expect(isSampled(REPORT_SAMPLE_LIMIT, 0)).toBe(true);
    expect(isSampled(0, REPORT_SAMPLE_LIMIT)).toBe(true);
  });

  test("EITHER source hitting the limit is enough", () => {
    // The rollups span both: funnel and data-health read contacts, credit and team read reveals. A truncated
    // contacts page makes the funnel a sample even when usage history is complete.
    expect(isSampled(REPORT_SAMPLE_LIMIT, 5)).toBe(true);
    expect(isSampled(5, REPORT_SAMPLE_LIMIT)).toBe(true);
  });
});
