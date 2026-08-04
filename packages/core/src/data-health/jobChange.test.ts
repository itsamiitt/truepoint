import { describe, expect, test } from "bun:test";
import { type EmploymentClaim, detectJobChange, shouldAlert } from "./jobChange.ts";

const ACME = "11111111-1111-4111-8111-111111111111";
const GLOBEX = "22222222-2222-4222-8222-222222222222";

const claim = (over: Partial<EmploymentClaim> = {}): EmploymentClaim => ({
  companyId: ACME,
  title: "VP Sales",
  method: "provider",
  ageDays: 30,
  distinctSources: 1,
  ...over,
});

describe("detectJobChange", () => {
  test("the first employment we see is a baseline, not a change", () => {
    // Otherwise every newly imported contact fires a "they moved!" alert on day one.
    const v = detectJobChange(null, claim());
    expect(v.changed).toBe(false);
    expect(v.reason).toBe("no_prior");
  });

  test("same company and same title is not a change", () => {
    const v = detectJobChange(claim(), claim({ ageDays: 1 }));
    expect(v.changed).toBe(false);
    expect(v.reason).toBe("same_employment");
  });

  test("title differences that are only formatting are not a job change", () => {
    // "VP, Sales" vs "vp sales" is the same job. Treating it as a change would fire alerts on punctuation.
    const v = detectJobChange(
      claim({ title: "VP, Sales" }),
      claim({ title: "vp  sales", ageDays: 1 }),
    );
    expect(v.changed).toBe(false);
    expect(v.reason).toBe("same_employment");
  });

  test("a strong fresh claim of a new company is a move", () => {
    const v = detectJobChange(
      claim({ method: "crawl", ageDays: 400 }),
      claim({ companyId: GLOBEX, method: "user_confirm", ageDays: 1, distinctSources: 3 }),
    );
    expect(v.changed).toBe(true);
    expect(v.kind).toBe("moved");
    expect(shouldAlert(v)).toBe(true);
  });

  test("three corroborated confirmations beat a year-old crawl", () => {
    // 07 states this rule literally. It is a comparison of CONFIDENCES, not of timestamps — which is the
    // whole reason this composes the confidence model instead of sorting by observed_at.
    const v = detectJobChange(
      claim({ method: "crawl", ageDays: 365 }),
      claim({ companyId: null, method: "user_confirm", ageDays: 10, distinctSources: 3 }),
    );
    expect(v.changed).toBe(true);
    expect(v.kind).toBe("departed");
    expect(v.confidence).toBeGreaterThan(v.priorConfidence);
  });

  test("one weak fresh crawl does NOT overturn a strong recent record", () => {
    // The failure this prevents: the noisiest source winning simply by being last. A single stale scrape
    // marking a live contact as departed removes them from every list and sequence they belong to.
    const v = detectJobChange(
      claim({ method: "user_confirm", ageDays: 20, distinctSources: 3 }),
      claim({ companyId: null, method: "crawl", ageDays: 0 }),
    );
    expect(v.changed).toBe(false);
    expect(v.reason).toBe("prior_stronger");
  });

  test("a near-tie is held back rather than flapping", () => {
    // Two sources of equal strength disagreeing by a rounding error must not flip the record back and forth.
    // An alert that fires on noise is one users learn to ignore, which is worse than no alert.
    const v = detectJobChange(
      claim({ method: "provider", ageDays: 30 }),
      claim({ companyId: GLOBEX, method: "provider", ageDays: 25 }),
    );
    expect(v.changed).toBe(false);
    expect(v.reason).toBe("insufficient_margin");
  });

  test("departure is held to the SAME bar as a move, not a lower one", () => {
    // Marking someone gone is not the safe default — it is destructive to every list they are on.
    const weakDeparture = detectJobChange(
      claim({ method: "user_confirm", ageDays: 10, distinctSources: 3 }),
      claim({ companyId: null, method: "pattern_inferred", ageDays: 0 }),
    );
    expect(weakDeparture.changed).toBe(false);
  });

  test("same company, genuinely different title, strongly asserted → title_change", () => {
    const v = detectJobChange(
      claim({ title: "SDR", method: "crawl", ageDays: 400 }),
      claim({ title: "Account Executive", method: "user_confirm", ageDays: 1, distinctSources: 3 }),
    );
    expect(v.changed).toBe(true);
    expect(v.kind).toBe("title_change");
  });
});

describe("shouldAlert", () => {
  test("a title change does not alert", () => {
    // Still at the company, still reachable. Near-zero value to a seller, real notification cost — and every
    // ignorable alert makes the ones that matter less likely to be read.
    const v = detectJobChange(
      claim({ title: "SDR", method: "crawl", ageDays: 400 }),
      claim({ title: "Account Executive", method: "user_confirm", ageDays: 1, distinctSources: 3 }),
    );
    expect(v.kind).toBe("title_change");
    expect(shouldAlert(v)).toBe(false);
  });

  test("no change never alerts", () => {
    expect(shouldAlert(detectJobChange(null, claim()))).toBe(false);
    expect(shouldAlert(detectJobChange(claim(), claim()))).toBe(false);
  });
});
