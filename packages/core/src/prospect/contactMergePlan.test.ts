// contactMergePlan.test.ts — the PURE field-union planner of the contact TRUE-MERGE engine (04 §3.2; S-C4).
// No DB: pure over plain maps. Covers the load-bearing merge invariants: default = survivor-wins / loser
// fills blanks; a PINNED survivor scalar is structurally immune to a merge blank-fill (T3); an explicit loser
// pick overrides even a survivor pin (human assertion re-pins); an explicit survivor pick suppresses the
// blank-fill; custom_fields union is survivor-wins-per-key; and the before/after audit payload is exact.

import { describe, expect, test } from "bun:test";
import type { FieldProvenanceMap, MergeFieldDecision } from "@leadwolf/types";
import { type MergeScalars, planContactMerge } from "./contactMergePlan.ts";

const AT = "2026-07-07T00:00:00.000Z";
const blankScalars = (): MergeScalars => ({
  firstName: null,
  lastName: null,
  jobTitle: null,
  seniorityLevel: null,
  department: null,
  locationCountry: null,
  locationCity: null,
});

const run = (
  survivor: Partial<MergeScalars>,
  loser: Partial<MergeScalars>,
  opts: {
    provenance?: FieldProvenanceMap;
    decisions?: MergeFieldDecision[];
    survivorCustom?: Record<string, unknown>;
    loserCustom?: Record<string, unknown>;
  } = {},
) =>
  planContactMerge({
    survivor: {
      scalars: { ...blankScalars(), ...survivor },
      provenance: opts.provenance ?? {},
      customFields: opts.survivorCustom ?? {},
    },
    loser: { scalars: { ...blankScalars(), ...loser }, customFields: opts.loserCustom ?? {} },
    decisions: opts.decisions ?? [],
    userId: "user-1",
    mergedAtIso: AT,
  });

describe("planContactMerge — default rule (survivor wins, loser fills blanks)", () => {
  test("loser fills a blank survivor field; provenance stamped src:merge, pin:false", () => {
    const r = run({ firstName: "Ann" }, { firstName: "SHOULD-NOT-WIN", jobTitle: "VP Sales" });
    expect(r.scalarWrites.jobTitle).toBe("VP Sales"); // survivor blank → filled
    expect("firstName" in r.scalarWrites).toBe(false); // survivor populated → untouched
    expect(r.provenance.jobTitle).toEqual({ src: "merge", obs: AT, pin: false });
    expect(r.fieldChanges).toEqual({ jobTitle: { b: null, a: "VP Sales" } });
  });

  test("survivor populated wins across the board — no writes when loser only conflicts", () => {
    const r = run({ firstName: "Ann", jobTitle: "CEO" }, { firstName: "Bob", jobTitle: "Analyst" });
    expect(r.scalarWrites).toEqual({});
    expect(r.fieldChanges).toEqual({});
  });
});

describe("planContactMerge — pin immunity (T3)", () => {
  test("a pinned blank survivor field is NOT filled from the loser (structurally unoverwritable)", () => {
    const r = run(
      { jobTitle: null },
      { jobTitle: "VP Sales" },
      { provenance: { jobTitle: { src: "user_edit", pin: true, by: "u", at: AT } } },
    );
    expect("jobTitle" in r.scalarWrites).toBe(false);
    // descriptor unchanged
    expect(r.provenance.jobTitle).toEqual({ src: "user_edit", pin: true, by: "u", at: AT });
  });
});

describe("planContactMerge — explicit decisions", () => {
  test("explicit loser pick overrides even a survivor pin (human assertion re-pins)", () => {
    const r = run(
      { department: "Eng" },
      { department: "Marketing" },
      {
        provenance: { department: { src: "user_edit", pin: true, by: "u", at: AT } },
        decisions: [{ field: "department", winner: "loser" }],
      },
    );
    expect(r.scalarWrites.department).toBe("Marketing");
    expect(r.provenance.department).toEqual({ src: "user_edit", pin: true, by: "user-1", at: AT });
    expect(r.fieldChanges).toEqual({ department: { b: "Eng", a: "Marketing" } });
  });

  test("explicit survivor pick suppresses the blank-fill even when survivor is blank", () => {
    const r = run(
      { jobTitle: null },
      { jobTitle: "VP Sales" },
      { decisions: [{ field: "jobTitle", winner: "survivor" }] },
    );
    expect("jobTitle" in r.scalarWrites).toBe(false);
  });

  test("explicit loser pick may clear a field (loser blank asserted over survivor value)", () => {
    const r = run(
      { locationCity: "NYC" },
      { locationCity: null },
      { decisions: [{ field: "locationCity", winner: "loser" }] },
    );
    expect(r.scalarWrites.locationCity).toBeNull();
    expect(r.fieldChanges).toEqual({ locationCity: { b: "NYC", a: null } });
  });
});

describe("planContactMerge — custom_fields union", () => {
  test("survivor keys win; loser fills absent keys", () => {
    const r = run(
      {},
      {},
      { survivorCustom: { a: 1, shared: "survivor" }, loserCustom: { b: 2, shared: "loser" } },
    );
    expect(r.customFields).toEqual({ a: 1, b: 2, shared: "survivor" });
  });
});

describe("planContactMerge — purity / replay", () => {
  test("does not mutate the survivor provenance input", () => {
    const prov: FieldProvenanceMap = { firstName: { src: "reveal", pin: false } };
    run({ jobTitle: null }, { jobTitle: "VP" }, { provenance: prov });
    expect(prov).toEqual({ firstName: { src: "reveal", pin: false } });
  });
});
