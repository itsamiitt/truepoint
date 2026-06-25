// fieldProvenance.test.ts — the PURE overlay pin-merge helpers (PLAN_03 §1.4 / §3.1). No DB: these are pure
// functions over a plain map. Covers the load-bearing invariants: a pinned (user_edit) field is never
// overwritten by a reveal/enrichment write, an unpinned/new field is written and recorded, and a user edit
// always wins (sets the pin, overriding any prior descriptor) while leaving untouched fields alone.

import { describe, expect, test } from "bun:test";
import type { FieldProvenanceMap } from "@leadwolf/types";
import { planFieldWrite, planUserEdit } from "./fieldProvenance.ts";

const SOURCE = {
  src: "provider:zoominfo",
  mth: "deterministic_email",
  conf: 0.91,
  ver: "2026-05-10T00:00:00Z",
};

describe("planFieldWrite", () => {
  test("a PINNED field is NOT writable and its descriptor is unchanged (human correction is sacrosanct)", () => {
    const pinned = {
      src: "user_edit",
      pin: true as const,
      by: "user-1",
      at: "2026-06-20T14:02:00Z",
    };
    const existing: FieldProvenanceMap = { jobTitle: pinned };

    const { writableFields, provenance } = planFieldWrite(existing, ["jobTitle"], SOURCE);

    expect(writableFields.has("jobTitle")).toBe(false);
    expect(writableFields.size).toBe(0);
    // Descriptor left exactly as it was.
    expect(provenance.jobTitle).toEqual(pinned);
  });

  test("an UNPINNED existing field IS writable and gets {src, pin:false}", () => {
    const existing: FieldProvenanceMap = {
      jobTitle: { src: "import:apollo", conf: 0.5, pin: false },
    };

    const { writableFields, provenance } = planFieldWrite(existing, ["jobTitle"], SOURCE);

    expect(writableFields.has("jobTitle")).toBe(true);
    expect(provenance.jobTitle).toEqual({ ...SOURCE, pin: false });
  });

  test("a brand-new field is writable and recorded", () => {
    const existing: FieldProvenanceMap = {};

    const { writableFields, provenance } = planFieldWrite(existing, ["department"], SOURCE);

    expect(writableFields.has("department")).toBe(true);
    expect(provenance.department).toEqual({ ...SOURCE, pin: false });
  });

  test("the source's src and ver land on the written descriptor", () => {
    const { provenance } = planFieldWrite({}, ["seniorityLevel"], SOURCE);

    expect(provenance.seniorityLevel?.src).toBe("provider:zoominfo");
    expect(provenance.seniorityLevel?.ver).toBe("2026-05-10T00:00:00Z");
  });

  test("does not mutate the existing map", () => {
    const existing: FieldProvenanceMap = { firstName: { src: "import:apollo", pin: false } };

    planFieldWrite(existing, ["firstName"], SOURCE);

    expect(existing.firstName).toEqual({ src: "import:apollo", pin: false });
  });
});

describe("planUserEdit", () => {
  test("sets {src:'user_edit', pin:true, by, at} for each edited field", () => {
    const merged = planUserEdit({}, ["jobTitle", "department"], "user-9", "2026-06-25T10:00:00Z");

    expect(merged.jobTitle).toEqual({
      src: "user_edit",
      pin: true,
      by: "user-9",
      at: "2026-06-25T10:00:00Z",
    });
    expect(merged.department).toEqual({
      src: "user_edit",
      pin: true,
      by: "user-9",
      at: "2026-06-25T10:00:00Z",
    });
  });

  test("OVERRIDES a prior non-user descriptor (user edit always wins)", () => {
    const existing: FieldProvenanceMap = {
      jobTitle: { src: "provider:zoominfo", conf: 0.91, pin: false },
    };

    const merged = planUserEdit(existing, ["jobTitle"], "user-9", "2026-06-25T10:00:00Z");

    expect(merged.jobTitle).toEqual({
      src: "user_edit",
      pin: true,
      by: "user-9",
      at: "2026-06-25T10:00:00Z",
    });
  });

  test("untouched fields keep their existing descriptors", () => {
    const existing: FieldProvenanceMap = {
      jobTitle: { src: "provider:zoominfo", conf: 0.91, pin: false },
      firstName: { src: "import:apollo", pin: false },
    };

    const merged = planUserEdit(existing, ["jobTitle"], "user-9", "2026-06-25T10:00:00Z");

    expect(merged.firstName).toEqual({ src: "import:apollo", pin: false });
  });

  test("does not mutate the existing map", () => {
    const existing: FieldProvenanceMap = { jobTitle: { src: "provider:zoominfo", pin: false } };

    planUserEdit(existing, ["jobTitle"], "user-9", "2026-06-25T10:00:00Z");

    expect(existing.jobTitle).toEqual({ src: "provider:zoominfo", pin: false });
  });
});
