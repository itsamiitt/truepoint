import { describe, expect, test } from "bun:test";
import {
  type FieldConfig,
  blockingKeys,
  candidatePairs,
  connectedComponents,
  fieldWeight,
  largestBlockSize,
  matchProbability,
  matchWeight,
  pickSurvivor,
  routeMatch,
} from "../src/index.ts";

const configs = new Map<string, FieldConfig>([
  ["last_name", { field: "last_name", m: 0.9, u: 0.01 }],
  ["email", { field: "email", m: 0.95, u: 0.001 }],
]);

describe("Fellegi-Sunter scoring", () => {
  test("agreement adds positive bits; probability is stable + monotonic", () => {
    const w = matchWeight(
      0.001,
      [
        { field: "last_name", agree: true },
        { field: "email", agree: true },
      ],
      configs,
    );
    expect(w).toBeGreaterThan(0);
    expect(matchProbability(w)).toBeGreaterThan(0.98); // strong agreement on rare fields → high probability
    expect(matchProbability(0)).toBeCloseTo(0.5, 5);
    expect(matchProbability(-100)).toBeCloseTo(0, 5);
    expect(matchProbability(100)).toBeCloseTo(1, 5);
  });

  test("disagreement subtracts bits", () => {
    const email = configs.get("email");
    expect(email).toBeDefined();
    if (email) {
      expect(fieldWeight(email, true)).toBeGreaterThan(0);
      expect(fieldWeight(email, false)).toBeLessThan(0);
    }
  });

  test("TF adjustment: a rare value scores higher than a common one [S36]", () => {
    const ln = configs.get("last_name");
    if (ln) {
      expect(fieldWeight(ln, true, 0.0001)).toBeGreaterThan(fieldWeight(ln, true, 0.2));
    }
  });
});

describe("two-threshold routing [S38]", () => {
  const t = { autoMergeAbove: 6, autoRejectBelow: -2 };
  test("routes by band (grey zone → human review)", () => {
    expect(routeMatch(8, t)).toBe("auto_merge");
    expect(routeMatch(2, t)).toBe("grey_zone");
    expect(routeMatch(-5, t)).toBe("auto_reject");
  });
});

describe("blocking — UNION keys [S39]", () => {
  const recs = [
    { id: "a", lastName: "Smith", emailDomain: "acme.com" },
    { id: "b", lastName: "Smithers", emailDomain: "acme.com" },
    { id: "c", lastName: "Jones", emailDomain: "other.com" },
  ];
  test("shares any key → candidate pair; disjoint → none", () => {
    const ids = candidatePairs(recs, blockingKeys)
      .map(([x, y]) => [x.id, y.id].sort().join(""))
      .sort();
    expect(ids).toEqual(["ab"]);
  });
  test("largestBlockSize surfaces an over-permissive key", () => {
    expect(largestBlockSize(recs, blockingKeys)).toBe(2);
  });
});

describe("connected-components clustering [S37]", () => {
  test("transitive matches form one cluster", () => {
    const sizes = connectedComponents(
      ["a", "b", "c", "d"],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    )
      .map((g) => g.length)
      .sort();
    expect(sizes).toEqual([1, 3]);
  });
});

describe("survivorship (BVT) [S28][S33]", () => {
  test("authority beats recency (not the Reltio recency footgun)", () => {
    const winner = pickSurvivor([
      {
        value: "stale-authoritative",
        authority: 0.9,
        validated: true,
        completeness: 1,
        observedAt: 1,
      },
      {
        value: "fresh-lowquality",
        authority: 0.2,
        validated: false,
        completeness: 0.5,
        observedAt: 100,
      },
    ]);
    expect(winner?.value).toBe("stale-authoritative");
  });
});
