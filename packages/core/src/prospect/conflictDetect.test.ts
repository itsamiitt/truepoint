// conflictDetect.test.ts — the PURE cross-source conflict marker (data-management #8). No DB: same input → same
// output. Pins the load-bearing rules: a DIFFERENT source with a DIFFERENT normalized value conflicts; a
// formatting-only difference does not; the SAME source never conflicts; a missing value never conflicts; and cf
// is sticky. These are exactly the guarantees the Data-Health "conflict rate" tile depends on.

import { describe, expect, test } from "bun:test";
import type { FieldProvenanceMap } from "@leadwolf/types";
import { markConflicts, normalizeForConflict } from "./conflictDetect.ts";

const APOLLO = "import:apollo";
const ZOOM = "import:zoominfo";
/** The provenance planFieldWrite would produce for a write of `jobTitle` by `src`. */
const written = (src: string): FieldProvenanceMap => ({ jobTitle: { src, pin: false } });

describe("normalizeForConflict", () => {
  test("trims, lowercases, collapses whitespace; empty/null → null", () => {
    expect(normalizeForConflict("  VP  Sales ")).toBe("vp sales");
    expect(normalizeForConflict("VP Sales")).toBe("vp sales");
    expect(normalizeForConflict("")).toBeNull();
    expect(normalizeForConflict(null)).toBeNull();
    expect(normalizeForConflict(undefined)).toBeNull();
  });
});

describe("markConflicts", () => {
  test("a DIFFERENT source with a DIFFERENT value marks cf:true", () => {
    const out = markConflicts({
      provenance: written(ZOOM),
      existingProvenance: { jobTitle: { src: APOLLO } },
      existingValues: { jobTitle: "VP Sales" },
      incomingValues: { jobTitle: "Head of Sales" },
      writtenFields: ["jobTitle"],
      incomingSrc: ZOOM,
    });
    expect(out.jobTitle?.cf).toBe(true);
  });

  test("a formatting-only difference is NOT a conflict", () => {
    const out = markConflicts({
      provenance: written(ZOOM),
      existingProvenance: { jobTitle: { src: APOLLO } },
      existingValues: { jobTitle: "VP  Sales" },
      incomingValues: { jobTitle: "vp sales" },
      writtenFields: ["jobTitle"],
      incomingSrc: ZOOM,
    });
    expect(out.jobTitle?.cf).toBeUndefined();
  });

  test("the SAME source re-writing a different value is NOT a conflict (a correction, not disagreement)", () => {
    const out = markConflicts({
      provenance: written(APOLLO),
      existingProvenance: { jobTitle: { src: APOLLO } },
      existingValues: { jobTitle: "VP Sales" },
      incomingValues: { jobTitle: "SVP Sales" },
      writtenFields: ["jobTitle"],
      incomingSrc: APOLLO,
    });
    expect(out.jobTitle?.cf).toBeUndefined();
  });

  test("a missing value on either side is NOT a conflict", () => {
    const out = markConflicts({
      provenance: written(ZOOM),
      existingProvenance: { jobTitle: { src: APOLLO } },
      existingValues: {}, // the contact had no prior jobTitle
      incomingValues: { jobTitle: "Head of Sales" },
      writtenFields: ["jobTitle"],
      incomingSrc: ZOOM,
    });
    expect(out.jobTitle?.cf).toBeUndefined();
  });

  test("cf is sticky — a prior conflict survives a later agreeing write", () => {
    const out = markConflicts({
      provenance: written(ZOOM),
      existingProvenance: { jobTitle: { src: APOLLO, cf: true } },
      existingValues: { jobTitle: "VP Sales" },
      incomingValues: { jobTitle: "VP Sales" }, // agrees now, but the past conflict stays flagged
      writtenFields: ["jobTitle"],
      incomingSrc: ZOOM,
    });
    expect(out.jobTitle?.cf).toBe(true);
  });

  test("does not mutate the input provenance and ignores unwritten fields", () => {
    const provenance = written(ZOOM);
    const out = markConflicts({
      provenance,
      existingProvenance: { jobTitle: { src: APOLLO }, department: { src: APOLLO } },
      existingValues: { jobTitle: "VP Sales", department: "Sales" },
      incomingValues: { jobTitle: "Head of Sales", department: "Marketing" },
      writtenFields: ["jobTitle"], // department not written → never inspected
      incomingSrc: ZOOM,
    });
    expect(provenance.jobTitle?.cf).toBeUndefined(); // input untouched
    expect(out.department).toBeUndefined();
  });
});
