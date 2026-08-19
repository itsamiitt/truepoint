// computeAccountScore.test.ts — the pure halves of the v1 account scorer (MI-S4). The IO composition is
// proven in the tenantSignals itest; here the RULES are pinned so a weight change is a deliberate diff.

import { describe, expect, test } from "bun:test";
import { accountIcpFit, accountMomentum } from "./computeAccountScore.ts";

describe("accountIcpFit", () => {
  test("a fully-known, reachable account scores 100; every part is explained", () => {
    const { score, parts } = accountIcpFit({
      hasIndustryNode: true,
      employeeCount: 500,
      fundingStage: "series_b",
      technologiesCount: 3,
      hasDomain: true,
      contactCount: 12,
    });
    expect(score).toBe(100);
    expect(parts).toEqual({
      industry: 20,
      size: 15,
      stage: 15,
      technology: 15,
      domain: 10,
      reachability: 25,
    });
  });

  test("an empty shell scores 0", () => {
    const { score } = accountIcpFit({
      hasIndustryNode: false,
      employeeCount: null,
      fundingStage: null,
      technologiesCount: 0,
      hasDomain: false,
      contactCount: 0,
    });
    expect(score).toBe(0);
  });

  test("employeeCount 0 still counts as KNOWN size — null is the unknown", () => {
    const known = accountIcpFit({
      hasIndustryNode: false,
      employeeCount: 0,
      fundingStage: null,
      technologiesCount: 0,
      hasDomain: false,
      contactCount: 0,
    });
    expect(known.parts.size).toBe(15);
  });
});

describe("accountMomentum", () => {
  test("a fresh funding signal is worth its full weight; one at a half-life is worth half", () => {
    expect(accountMomentum([{ family: "funding", ageDays: 0 }]).score).toBe(45);
    expect(accountMomentum([{ family: "funding", ageDays: 90 }]).score).toBe(23);
  });

  test("families sum and the total clamps at 100", () => {
    const { score } = accountMomentum([
      { family: "funding", ageDays: 0 },
      { family: "leadership", ageDays: 0 },
      { family: "hiring", ageDays: 0 },
    ]);
    expect(score).toBe(100); // 45+40+30 = 115 → clamped
  });

  test("an unknown family falls back to the 'other' weight, never zero and never a throw", () => {
    expect(accountMomentum([{ family: "someday_new", ageDays: 0 }]).score).toBe(10);
  });

  test("no signals = zero momentum", () => {
    expect(accountMomentum([]).score).toBe(0);
  });
});
