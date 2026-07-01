// stringSimilarity.test.ts — Jaro-Winkler (I5 ER name comparison). Textbook pairs (asserted as ranges, since the
// exact float depends on the prefix scaling), plus the edge cases (identical, empty, disjoint) and the bounds.

import { describe, expect, test } from "bun:test";
import { jaro, jaroWinkler } from "./stringSimilarity.ts";

describe("jaro / jaroWinkler", () => {
  test("identical strings score 1", () => {
    expect(jaro("acme", "acme")).toBe(1);
    expect(jaroWinkler("acme", "acme")).toBe(1);
  });

  test("an empty string scores 0", () => {
    expect(jaro("", "acme")).toBe(0);
    expect(jaroWinkler("acme", "")).toBe(0);
  });

  test("completely disjoint strings score 0", () => {
    expect(jaro("abc", "xyz")).toBe(0);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  test("classic near-match pairs land high (typo/transposition tolerant)", () => {
    // martha/marhta ≈ 0.961, dwayne/duane ≈ 0.84 (textbook Jaro-Winkler values).
    expect(jaroWinkler("martha", "marhta")).toBeGreaterThan(0.95);
    expect(jaroWinkler("martha", "marhta")).toBeLessThanOrEqual(1);
    expect(jaroWinkler("dwayne", "duane")).toBeGreaterThan(0.8);
    expect(jaroWinkler("dwayne", "duane")).toBeLessThan(0.9);
  });

  test("the prefix bonus makes Jaro-Winkler ≥ Jaro", () => {
    expect(jaroWinkler("jonathan", "jonathon")).toBeGreaterThanOrEqual(jaro("jonathan", "jonathon"));
  });

  test("output is always within [0,1]", () => {
    for (const [a, b] of [
      ["smith", "smyth"],
      ["a", "bbbbbbbb"],
      ["longname", "l"],
    ] as const) {
      const s = jaroWinkler(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
