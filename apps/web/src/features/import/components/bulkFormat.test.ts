// bulkFormat.test.ts — unit coverage for the bulk-import presentation helpers. The label/tone maps are
// trivial lookups, but bulkPercent CLAMPS a 0–1 fraction to a whole percent — a real guard so a malformed
// progress (>1 or <0 from the API) can never render a >100% or negative bar — so its edge cases are pinned
// here. The label/tone fallbacks (an out-of-contract status) are covered too, so a future enum addition
// surfaces in CI rather than silently rendering a raw key.

import { describe, expect, test } from "bun:test";
import { bulkPercent, bulkStatusLabel, bulkStatusTone } from "./bulkFormat.ts";

describe("bulkPercent", () => {
  test("rounds a mid-range fraction to a whole percent", () => {
    expect(bulkPercent(0.5)).toBe(50);
    expect(bulkPercent(0.337)).toBe(34);
  });

  test("clamps below 0 to 0 and above 1 to 100", () => {
    expect(bulkPercent(-0.2)).toBe(0);
    expect(bulkPercent(1.5)).toBe(100);
  });

  test("holds the exact bounds", () => {
    expect(bulkPercent(0)).toBe(0);
    expect(bulkPercent(1)).toBe(100);
  });
});

describe("bulkStatusLabel / bulkStatusTone", () => {
  test("map known statuses", () => {
    expect(bulkStatusLabel("partial")).toBe("Completed with errors");
    expect(bulkStatusTone("failed")).toBe("danger");
    expect(bulkStatusTone("running")).toBe("success");
  });

  test("fall back defensively for an out-of-contract status", () => {
    // @ts-expect-error — exercising the runtime ?? fallback with a value outside the status enum
    expect(bulkStatusLabel("bogus")).toBe("bogus");
    // @ts-expect-error — same, for the tone (defaults to the neutral "muted")
    expect(bulkStatusTone("bogus")).toBe("muted");
  });
});
