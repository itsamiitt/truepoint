// revealOutcomes.test.ts — the reveal-outcomes contract, and the one distinction the panel exists to keep.
//
// `hitRate` is nullable all the way from SQL to the browser because "nothing attempted yet" and "every
// attempt missed" are opposite conclusions. 06-roadmap Phase 1 puts a KILL criterion on this number
// ("reveal-hit rate <40% in the beachhead after seed load → stop"), so collapsing null to 0 would report a 0%
// hit rate on an empty workspace — a stop signal manufactured from no data at all.

import { describe, expect, test } from "bun:test";
import { revealOutcomesSchema } from "@leadwolf/types";

describe("revealOutcomes contract", () => {
  test("accepts a null hit rate and null latency — the empty workspace", () => {
    const parsed = revealOutcomesSchema.parse({
      hits: 0,
      misses: 0,
      hitRate: null,
      p95ServerMs: null,
    });
    // Null SURVIVES parsing. If the schema defaulted these to 0 the panel could not tell an untouched
    // workspace from one where every lookup failed.
    expect(parsed.hitRate).toBeNull();
    expect(parsed.p95ServerMs).toBeNull();
  });

  test("a real hit rate round-trips", () => {
    const parsed = revealOutcomesSchema.parse({
      hits: 37,
      misses: 63,
      hitRate: 0.37,
      p95ServerMs: 812,
    });
    expect(parsed.hitRate).toBe(0.37);
    expect(parsed.hits + parsed.misses).toBe(100);
  });

  test("rejects a hit rate outside 0..1 — a fraction, never a percentage", () => {
    // The guard against a server that starts sending 37 for "37%". Silent acceptance would render 3700% and,
    // worse, sail past the 0.4 kill threshold for ever.
    const bad = revealOutcomesSchema.safeParse({
      hits: 37,
      misses: 63,
      hitRate: 37,
      p95ServerMs: 10,
    });
    expect(bad.success).toBe(false);
  });

  test("rejects negative counts", () => {
    const bad = revealOutcomesSchema.safeParse({
      hits: -1,
      misses: 0,
      hitRate: null,
      p95ServerMs: null,
    });
    expect(bad.success).toBe(false);
  });

  test("the kill threshold sits inside the representable range", () => {
    // 0.4 is the roadmap's Phase 1 number. If the contract could not express it, the panel could not warn on
    // it — this is a cheap guard that the units on both sides agree.
    expect(
      revealOutcomesSchema.safeParse({
        hits: 4,
        misses: 6,
        hitRate: 0.4,
        p95ServerMs: null,
      }).success,
    ).toBe(true);
  });
});
