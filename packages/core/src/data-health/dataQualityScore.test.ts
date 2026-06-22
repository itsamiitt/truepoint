// dataQualityScore.test.ts — the data-quality keystone (22 §2–§3): freshness bands + decay, verification
// sub-score, weighted completeness, the composite with cold-start re-weighting, and the contact composer.
// Pure (no DB/env) — asserts the exact formulas in the plan.

import { describe, expect, test } from "bun:test";
import {
  COLD_START_FRESHNESS,
  type CompletenessField,
  completenessSubScore,
  computeContactDataQuality,
  dataQualityScore,
  freshnessStatusFor,
  freshnessSubScore,
  verificationMean,
  verificationSubScore,
} from "./dataQualityScore.ts";

describe("freshnessStatusFor (§3 bands: <0.5 fresh, <1.0 aging, <1.5 stale, else expired)", () => {
  test("bands by age/SLA ratio", () => {
    expect(freshnessStatusFor(0, 90)).toBe("fresh");
    expect(freshnessStatusFor(44, 90)).toBe("fresh"); // 0.49
    expect(freshnessStatusFor(45, 90)).toBe("aging"); // 0.50
    expect(freshnessStatusFor(89, 90)).toBe("aging"); // 0.99
    expect(freshnessStatusFor(90, 90)).toBe("stale"); // 1.00
    expect(freshnessStatusFor(134, 90)).toBe("stale"); // 1.49
    expect(freshnessStatusFor(135, 90)).toBe("expired"); // 1.50
    expect(freshnessStatusFor(365, 90)).toBe("expired");
  });
});

describe("freshnessSubScore (1 at age 0 → 0 by 1.5×SLA, clamped)", () => {
  test("decays linearly and clamps", () => {
    expect(freshnessSubScore(0, 90)).toBe(1);
    expect(freshnessSubScore(135, 90)).toBeCloseTo(0, 5); // 1.5×SLA → 0
    expect(freshnessSubScore(1000, 90)).toBe(0); // clamped
    expect(freshnessSubScore(67.5, 90)).toBeCloseTo(0.5, 5); // ratio 0.75 → 1 - 0.5
  });
});

describe("verificationSubScore (§2.3) + mean", () => {
  test("status → score; unverified/absent → null (excluded, §2.2)", () => {
    expect(verificationSubScore("valid")).toBe(1);
    expect(verificationSubScore("catch_all")).toBe(0.5);
    expect(verificationSubScore("unknown")).toBe(0.5);
    expect(verificationSubScore("invalid")).toBe(0);
    expect(verificationSubScore("unverified")).toBeNull();
    expect(verificationSubScore(null)).toBeNull();
  });
  test("mean excludes nulls; all-null → null", () => {
    expect(verificationMean(["valid", null])).toBe(1);
    expect(verificationMean(["valid", "invalid"])).toBe(0.5);
    expect(verificationMean([null, "unverified"])).toBeNull();
  });
});

describe("completenessSubScore (§2.3 weighted share)", () => {
  test("weighted present-share; empty → 0", () => {
    const fields: CompletenessField[] = [
      { weight: 0.3, present: true },
      { weight: 0.7, present: false },
    ];
    expect(completenessSubScore(fields)).toBeCloseTo(0.3, 5);
    expect(completenessSubScore([])).toBe(0);
  });
});

describe("dataQualityScore composite (§2 + cold-start §2.2)", () => {
  test("full marks → 100", () => {
    expect(dataQualityScore({ completeness: 1, verification: 1, freshness: 1 })).toBe(100);
  });
  test("cold start (verification null) re-weights out: round(100×(0.4c+0.3f)/0.7)", () => {
    expect(dataQualityScore({ completeness: 1, verification: null, freshness: 1 })).toBe(100);
    expect(dataQualityScore({ completeness: 1, verification: null, freshness: 0.5 })).toBe(79); // 0.55/0.7
  });
  test("clamps out-of-range inputs", () => {
    expect(dataQualityScore({ completeness: 2, verification: 2, freshness: 2 })).toBe(100);
    expect(dataQualityScore({ completeness: -1, verification: -1, freshness: -1 })).toBe(0);
  });
});

describe("computeContactDataQuality (composer)", () => {
  const FULL = {
    hasName: true,
    hasEmail: true,
    hasPhone: true,
    hasTitle: true,
    hasCompany: true,
    hasLocation: true,
    hasLinkedin: true,
  };

  test("complete + valid + freshly verified → 100 / fresh", () => {
    const r = computeContactDataQuality({ ...FULL, emailStatus: "valid", ageDaysSinceVerified: 0 });
    expect(r.score).toBe(100);
    expect(r.freshnessStatus).toBe("fresh");
  });

  test("cold-start sparse import (name+email only, unverified, never verified) → 44 / aging", () => {
    const r = computeContactDataQuality({
      hasName: true,
      hasEmail: true,
      hasPhone: false,
      hasTitle: false,
      hasCompany: false,
      hasLocation: false,
      hasLinkedin: false,
      emailStatus: "unverified",
      ageDaysSinceVerified: null,
    });
    // completeness=(0.1+0.3)=0.40; verification=null; freshness=COLD_START → round(100×(0.16+0.15)/0.7)=44
    expect(COLD_START_FRESHNESS).toBe(0.5);
    expect(r.score).toBe(44);
    expect(r.freshnessStatus).toBe("aging");
  });

  test("complete + valid but aging (60d / 90d SLA) → 87 / aging", () => {
    const r = computeContactDataQuality({
      ...FULL,
      emailStatus: "valid",
      ageDaysSinceVerified: 60,
    });
    expect(r.score).toBe(87);
    expect(r.freshnessStatus).toBe("aging");
  });
});
