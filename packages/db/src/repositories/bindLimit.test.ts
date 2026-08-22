// bindLimit.test.ts — the arithmetic behind the multi-row INSERT ceiling.
//
// Worth unit-testing rather than leaving to the soak: the soak proves the importer survives, this proves WHY,
// and it runs in milliseconds instead of two minutes against a real database. The bug it guards against was
// live in two repositories — a chunk of 10,000 contacts binds ~190,000 parameters against a 65,534 limit — and
// it went unnoticed because bulk import is dark and the soak suite that would have caught it had never run.

import { describe, expect, test } from "bun:test";
import { sliceForBindLimit } from "./bindLimit.ts";

/** A row with `n` keys, standing in for a value object of that width. */
function row(n: number, seed = 0): Record<string, number> {
  const o: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) o[`k${i}`] = seed;
  return o;
}

describe("sliceForBindLimit", () => {
  test("an empty batch produces no statements", () => {
    expect(sliceForBindLimit([])).toEqual([]);
  });

  test("a batch that already fits stays ONE statement", () => {
    // The common case. Splitting it would trade a real cost (n round trips) for no benefit.
    const rows = Array.from({ length: 100 }, () => row(19));
    const slices = sliceForBindLimit(rows);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toBe(rows as never); // same array, not a copy
  });

  test("the contact chunk that was throwing now fits inside the ceiling", () => {
    // 10_000 rows × 19 keys = 190_000 parameters — ~3x the limit, which is the production bug.
    const rows = Array.from({ length: 10_000 }, () => row(19));
    const slices = sliceForBindLimit(rows);
    expect(slices.length).toBeGreaterThan(1);
    for (const s of slices) expect(s.length * 19).toBeLessThan(65_534);
  });

  test("the source_imports chunk likewise", () => {
    // 10_000 × 8 = 80_000. Smaller overrun, same failure.
    const rows = Array.from({ length: 10_000 }, () => row(8));
    for (const s of sliceForBindLimit(rows)) expect(s.length * 8).toBeLessThan(65_534);
  });

  test("every row is present exactly once, in order", () => {
    // The callers rely on result[i] matching rows[i]; a slice that reorders or drops would corrupt the id
    // alignment silently — the ids would be valid, just attached to the wrong contacts.
    const rows = Array.from({ length: 25_000 }, (_, i) => row(19, i));
    const flat = sliceForBindLimit(rows).flat();
    expect(flat).toHaveLength(rows.length);
    expect(flat.map((r) => r.k0)).toEqual(rows.map((r) => r.k0));
  });

  test("the WIDEST row sets the width, not the average", () => {
    // A batch of mostly-narrow rows with a few wide ones must be sliced for the wide ones. Averaging would
    // under-count and let a statement past the ceiling — the failure this whole file exists to prevent.
    const rows = [...Array.from({ length: 9_999 }, () => row(2)), row(40)];
    for (const s of sliceForBindLimit(rows)) expect(s.length * 40).toBeLessThanOrEqual(65_534);
  });

  test("an absurdly wide row still yields at least one row per statement", () => {
    // Math.floor could reach 0 and produce empty slices forever; the floor of 1 is what stops that.
    const slices = sliceForBindLimit([row(100_000), row(100_000)]);
    expect(slices).toHaveLength(2);
    expect(slices.every((s) => s.length === 1)).toBe(true);
  });
});
