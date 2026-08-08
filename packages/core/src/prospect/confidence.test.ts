// confidence.test.ts — the decay/confidence fold. Pure functions, so every case here is exact arithmetic
// rather than a tolerance dance, except where floating point genuinely requires one.
//
// The cases that matter are the DEFENSIVE ones: future timestamps, zero source counts, disabled policy rows,
// and the no-policy-at-all path. Those are what decide whether switching decay on silently mangles the graph.

import { describe, expect, test } from "bun:test";
import {
  type ConfidencePolicy,
  daysUntilStale,
  decayFactor,
  evidenceFactor,
  resolvePolicy,
  scoreConfidence,
} from "./confidence.ts";

const policy = (over: Partial<ConfidencePolicy> = {}): ConfidencePolicy => ({
  field: "*",
  sourceType: "*",
  halfLifeDays: 365,
  sourceWeight: 0.8,
  corroborationCeiling: 5,
  isEnabled: true,
  ...over,
});

const AT = new Date("2026-08-08T00:00:00Z");
const daysBefore = (n: number): Date => new Date(AT.getTime() - n * 86_400_000);

describe("resolvePolicy — precedence, most specific first", () => {
  const exact = policy({ field: "jobTitle", sourceType: "provider", sourceWeight: 0.11 });
  const anyField = policy({ field: "*", sourceType: "provider", sourceWeight: 0.22 });
  const anySource = policy({ field: "jobTitle", sourceType: "*", sourceWeight: 0.33 });
  const universal = policy({ field: "*", sourceType: "*", sourceWeight: 0.44 });
  const all = [universal, anySource, anyField, exact]; // deliberately not in precedence order

  test("exact (field, sourceType) wins", () => {
    expect(resolvePolicy(all, "jobTitle", "provider")?.sourceWeight).toBe(0.11);
  });

  test("falls to ('*', sourceType) when the field has no specific row", () => {
    expect(resolvePolicy(all, "department", "provider")?.sourceWeight).toBe(0.22);
  });

  test("falls to (field, '*') when the source type has no row", () => {
    expect(resolvePolicy(all, "jobTitle", "mailbox")?.sourceWeight).toBe(0.33);
  });

  test("falls to the universal row last", () => {
    expect(resolvePolicy(all, "department", "mailbox")?.sourceWeight).toBe(0.44);
  });

  test("returns null when nothing matches at all", () => {
    expect(resolvePolicy([], "jobTitle", "provider")).toBeNull();
  });

  // The rollout switch: disabling a row must fall THROUGH to the next tier, not drop the field out of
  // scoring. If this regressed, turning off one policy row would stop scoring that field entirely.
  test("a disabled row is skipped and precedence continues to the next tier", () => {
    const withDisabledExact = [universal, anySource, anyField, { ...exact, isEnabled: false }];
    expect(resolvePolicy(withDisabledExact, "jobTitle", "provider")?.sourceWeight).toBe(0.22);
  });

  test("all rows disabled resolves to null, not to a disabled row", () => {
    const allOff = all.map((p) => ({ ...p, isEnabled: false }));
    expect(resolvePolicy(allOff, "jobTitle", "provider")).toBeNull();
  });
});

describe("decayFactor", () => {
  test("exactly one half-life halves the score", () => {
    expect(decayFactor(365, 365)).toBeCloseTo(0.5, 12);
  });

  test("two half-lives quarter it", () => {
    expect(decayFactor(730, 365)).toBeCloseTo(0.25, 12);
  });

  test("age zero is no decay", () => {
    expect(decayFactor(0, 365)).toBe(1);
  });

  test("a null half-life means the fact does not decay", () => {
    expect(decayFactor(10_000, null)).toBe(1);
  });

  // Clock skew and bad sources produce observed_at in the future. Without the clamp, 2^(+x) > 1 would hand
  // out MORE confidence than any source justified — the one way this function could inflate a score.
  test("negative age is clamped, never amplifies", () => {
    expect(decayFactor(-500, 365)).toBe(1);
  });

  test("a non-positive half-life is treated as no decay rather than dividing by zero", () => {
    expect(decayFactor(100, 0)).toBe(1);
    expect(decayFactor(100, -5)).toBe(1);
  });
});

describe("evidenceFactor — noisy-OR over independent sources", () => {
  test("one source scores its own weight", () => {
    expect(evidenceFactor(0.8, 1, 5)).toBeCloseTo(0.8, 12);
  });

  test("two independent sources compound: 1-(1-w)^2", () => {
    expect(evidenceFactor(0.8, 2, 5)).toBeCloseTo(0.96, 12);
  });

  // The property the design asked for, asserted rather than assumed.
  test("the second source is worth far more than the fifth", () => {
    const gain2 = evidenceFactor(0.8, 2, 9) - evidenceFactor(0.8, 1, 9);
    const gain5 = evidenceFactor(0.8, 5, 9) - evidenceFactor(0.8, 4, 9);
    expect(gain2).toBeGreaterThan(gain5 * 10);
  });

  // The blunt defence against non-independent sources (two vendors reselling one upstream feed).
  test("source count is capped at the ceiling", () => {
    expect(evidenceFactor(0.8, 100, 3)).toBeCloseTo(evidenceFactor(0.8, 3, 3), 12);
  });

  // A stored row is at least one assertion. A zero/negative count from a bad backfill must not zero out a
  // real fact.
  test("zero or negative source count is treated as one", () => {
    expect(evidenceFactor(0.8, 0, 5)).toBeCloseTo(0.8, 12);
    expect(evidenceFactor(0.8, -3, 5)).toBeCloseTo(0.8, 12);
  });

  test("weight is clamped into [0,1]", () => {
    expect(evidenceFactor(5, 1, 5)).toBe(1);
    expect(evidenceFactor(-5, 1, 5)).toBe(0);
  });

  test("a ceiling below one still admits the single source", () => {
    expect(evidenceFactor(0.8, 4, 0)).toBeCloseTo(0.8, 12);
  });
});

describe("scoreConfidence", () => {
  const policies = [policy({ field: "jobTitle", sourceType: "provider" })];

  test("combines evidence and decay", () => {
    const r = scoreConfidence({
      policies,
      field: "jobTitle",
      sourceType: "provider",
      sourceCount: 1,
      observedAt: daysBefore(365),
      asOf: AT,
    });
    expect(r.evidence).toBeCloseTo(0.8, 12);
    expect(r.decay).toBeCloseTo(0.5, 12);
    expect(r.confidence).toBeCloseTo(0.4, 12);
    expect(r.ageDays).toBeCloseTo(365, 9);
  });

  // No policy → no opinion. Defaulting to a number here would silently rescore the whole graph off a
  // fallback nobody chose.
  test("no matching policy yields a null confidence, not a default", () => {
    const r = scoreConfidence({
      policies: [],
      field: "jobTitle",
      sourceType: "provider",
      sourceCount: 3,
      observedAt: daysBefore(10),
      asOf: AT,
    });
    expect(r.confidence).toBeNull();
    expect(r.policy).toBeNull();
  });

  // Unknown age ≠ fresh, but penalising it would punish sources that simply do not report a timestamp.
  // The caller can still tell the difference, because ageDays comes back null.
  test("unknown observedAt skips decay and reports ageDays null", () => {
    const r = scoreConfidence({
      policies,
      field: "jobTitle",
      sourceType: "provider",
      sourceCount: 1,
      observedAt: null,
      asOf: AT,
    });
    expect(r.decay).toBe(1);
    expect(r.ageDays).toBeNull();
    expect(r.confidence).toBeCloseTo(0.8, 12);
  });

  test("a non-decaying field keeps full evidence however old it is", () => {
    const r = scoreConfidence({
      policies: [policy({ field: "primaryDomain", sourceType: "*", halfLifeDays: null })],
      field: "primaryDomain",
      sourceType: "provider",
      sourceCount: 2,
      observedAt: daysBefore(5000),
      asOf: AT,
    });
    expect(r.decay).toBe(1);
    expect(r.confidence).toBeCloseTo(0.96, 12);
  });

  test("a future observedAt cannot score above the evidence term", () => {
    const r = scoreConfidence({
      policies,
      field: "jobTitle",
      sourceType: "provider",
      sourceCount: 1,
      observedAt: new Date(AT.getTime() + 90 * 86_400_000),
      asOf: AT,
    });
    expect(r.confidence).toBeCloseTo(0.8, 12);
    expect(r.confidence).toBeLessThanOrEqual(r.evidence);
  });

  test("the result is always within [0,1]", () => {
    for (const count of [0, 1, 3, 50]) {
      for (const age of [-100, 0, 30, 5000]) {
        const r = scoreConfidence({
          policies,
          field: "jobTitle",
          sourceType: "provider",
          sourceCount: count,
          observedAt: daysBefore(age),
          asOf: AT,
        });
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  test("is pure — it does not mutate the policies it is given", () => {
    const input = [policy({ field: "jobTitle", sourceType: "provider" })];
    const snapshot = JSON.stringify(input);
    scoreConfidence({
      policies: input,
      field: "jobTitle",
      sourceType: "provider",
      sourceCount: 4,
      observedAt: daysBefore(100),
      asOf: AT,
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("daysUntilStale — the reverification scheduler's input", () => {
  const policies = [policy({ field: "jobTitle", sourceType: "provider", sourceWeight: 0.8 })];

  const scoreAt = (ageDays: number) =>
    scoreConfidence({
      policies,
      field: "jobTitle",
      sourceType: "provider",
      sourceCount: 1,
      observedAt: daysBefore(ageDays),
      asOf: AT,
    });

  test("a fresh value with evidence 0.8 crosses 0.4 after one half-life", () => {
    expect(daysUntilStale(scoreAt(0), 0.4)).toBeCloseTo(365, 6);
  });

  test("elapsed age is subtracted — half a life gone means half a life left", () => {
    expect(daysUntilStale(scoreAt(182.5), 0.4)).toBeCloseTo(182.5, 6);
  });

  test("an already-stale value returns null rather than a negative wait", () => {
    expect(daysUntilStale(scoreAt(400), 0.4)).toBeNull();
  });

  test("a non-decaying value never goes stale", () => {
    const r = scoreConfidence({
      policies: [policy({ field: "primaryDomain", sourceType: "*", halfLifeDays: null })],
      field: "primaryDomain",
      sourceType: "provider",
      sourceCount: 1,
      observedAt: daysBefore(10),
      asOf: AT,
    });
    expect(daysUntilStale(r, 0.4)).toBeNull();
  });

  test("a value whose evidence already sits below the threshold returns null", () => {
    const weak = scoreConfidence({
      policies: [policy({ field: "jobTitle", sourceType: "crawl", sourceWeight: 0.3 })],
      field: "jobTitle",
      sourceType: "crawl",
      sourceCount: 1,
      observedAt: daysBefore(0),
      asOf: AT,
    });
    expect(daysUntilStale(weak, 0.4)).toBeNull();
  });

  test("a null-confidence score returns null", () => {
    const none = scoreConfidence({
      policies: [],
      field: "x",
      sourceType: "provider",
      sourceCount: 1,
      observedAt: daysBefore(1),
      asOf: AT,
    });
    expect(daysUntilStale(none, 0.4)).toBeNull();
  });
});
