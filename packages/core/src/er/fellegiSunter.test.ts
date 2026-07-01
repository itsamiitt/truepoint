// fellegiSunter.test.ts — the pure Fellegi-Sunter scorer (I5 probabilistic ER). Asserts the per-field weight
// math, the prior-only baseline, monotonicity (more agreement ⇒ more weight), the disposition thresholds, and
// overflow safety. Robust assertions (dispositions + ranges + relative order) over brittle exact floats where the
// arithmetic is not hand-obvious. Pure logic; no @leadwolf/db.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FELLEGI_SUNTER_CONFIG,
  type FieldObservation,
  scoreFellegiSunter,
} from "./fellegiSunter.ts";

// A very discriminating identity field (email): agreeing is strong evidence of a match.
const emailAgree: FieldObservation = {
  field: "email",
  comparison: "agree",
  weights: { m: 0.9, u: 0.001 },
};
const emailDisagree: FieldObservation = { ...emailAgree, comparison: "disagree" };
const phoneAgree: FieldObservation = {
  field: "phone",
  comparison: "agree",
  weights: { m: 0.9, u: 0.001 },
};

describe("scoreFellegiSunter", () => {
  test("all not_compared → weight is exactly the prior, and probability is low", () => {
    const obs: FieldObservation[] = [
      { field: "email", comparison: "not_compared", weights: { m: 0.9, u: 0.001 } },
      { field: "name", comparison: "not_compared", weights: { m: 0.8, u: 0.05 } },
    ];
    const r = scoreFellegiSunter(obs);
    expect(r.matchWeightBits).toBeCloseTo(DEFAULT_FELLEGI_SUNTER_CONFIG.priorLog2Odds, 10);
    expect(r.probability).toBeGreaterThanOrEqual(0);
    expect(r.probability).toBeLessThan(0.05);
    expect(r.disposition).toBe("no_match");
  });

  test("a single strong email agreement lands in the human-review band (0.8 ≤ p < 0.95)", () => {
    const r = scoreFellegiSunter([emailAgree]);
    expect(r.probability).toBeGreaterThanOrEqual(0.8);
    expect(r.probability).toBeLessThan(0.95);
    expect(r.disposition).toBe("pending_review");
  });

  test("two strong agreements push the pair to auto_match", () => {
    const r = scoreFellegiSunter([emailAgree, phoneAgree]);
    expect(r.probability).toBeGreaterThanOrEqual(0.95);
    expect(r.disposition).toBe("auto_match");
  });

  test("strong disagreement drives the pair to no_match", () => {
    const r = scoreFellegiSunter([emailDisagree]);
    expect(r.probability).toBeLessThan(0.8);
    expect(r.disposition).toBe("no_match");
  });

  test("monotonicity: adding an agreeing field never lowers the match weight", () => {
    const one = scoreFellegiSunter([emailAgree]);
    const two = scoreFellegiSunter([emailAgree, phoneAgree]);
    expect(two.matchWeightBits).toBeGreaterThan(one.matchWeightBits);
  });

  test("agree weight is positive and disagree weight is negative when m > u", () => {
    // Relative to the prior-only baseline: agreeing adds, disagreeing subtracts.
    const base = scoreFellegiSunter([]).matchWeightBits;
    expect(scoreFellegiSunter([emailAgree]).matchWeightBits).toBeGreaterThan(base);
    expect(scoreFellegiSunter([emailDisagree]).matchWeightBits).toBeLessThan(base);
  });

  test("probability is always a finite number in [0,1], even with extreme evidence", () => {
    const many = Array.from({ length: 50 }, () => emailAgree);
    const r = scoreFellegiSunter(many);
    expect(Number.isFinite(r.probability)).toBe(true);
    expect(r.probability).toBeGreaterThanOrEqual(0);
    expect(r.probability).toBeLessThanOrEqual(1);
    expect(r.disposition).toBe("auto_match");
  });
});
