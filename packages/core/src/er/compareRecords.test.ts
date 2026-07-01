// compareRecords.test.ts — the pure comparison layer (I5 ER). Asserts per-field agree/disagree/not_compared for
// clear cases, the observation vector shape, and end-to-end into scoreFellegiSunter (strong agreement → auto_match;
// a strong-key disagreement → no_match). Robust cases only; the borderline name band is exercised via disposition.

import { describe, expect, test } from "bun:test";
import { type ComparablePerson, compareRecords } from "./compareRecords.ts";
import { scoreFellegiSunter } from "./fellegiSunter.ts";

const byField = (obs: ReturnType<typeof compareRecords>, field: string) =>
  obs.find((o) => o.field === field)!;

describe("compareRecords", () => {
  test("returns the 7-field observation vector in strongest→weakest order", () => {
    const obs = compareRecords({}, {});
    expect(obs.map((o) => o.field)).toEqual([
      "linkedin",
      "email",
      "phone",
      "name",
      "company",
      "title",
      "seniority",
    ]);
    // Two empty records compare nothing.
    expect(obs.every((o) => o.comparison === "not_compared")).toBe(true);
  });

  test("LinkedIn id: same → agree, different → disagree, missing → not_compared", () => {
    expect(byField(compareRecords({ linkedinPublicId: "li-1" }, { linkedinPublicId: "li-1" }), "linkedin").comparison).toBe("agree");
    expect(byField(compareRecords({ linkedinPublicId: "li-1" }, { linkedinPublicId: "li-2" }), "linkedin").comparison).toBe("disagree");
    expect(byField(compareRecords({ linkedinPublicId: "li-1" }, {}), "linkedin").comparison).toBe("not_compared");
  });

  test("email blind-index hex compares exactly (opaque; no plaintext)", () => {
    expect(byField(compareRecords({ emailBlindIndexHex: "ab12" }, { emailBlindIndexHex: "ab12" }), "email").comparison).toBe("agree");
    expect(byField(compareRecords({ emailBlindIndexHex: "ab12" }, { emailBlindIndexHex: "cd34" }), "email").comparison).toBe("disagree");
  });

  test("name: identical (case/punct-insensitive) → agree", () => {
    const obs = compareRecords({ fullName: "John Q. Smith" }, { firstName: "john", lastName: "smith" });
    // "john q smith" vs "john smith" — close prefix + tokens ⇒ high Jaro-Winkler ⇒ agree.
    expect(byField(obs, "name").comparison).toBe("agree");
  });

  test("company falls back from id to registrable domain", () => {
    expect(byField(compareRecords({ companyId: "c1" }, { companyId: "c1" }), "company").comparison).toBe("agree");
    expect(byField(compareRecords({ companyDomain: "Acme.com" }, { companyDomain: "acme.com" }), "company").comparison).toBe("agree");
    expect(byField(compareRecords({ companyDomain: "acme.com" }, { companyDomain: "globex.com" }), "company").comparison).toBe("disagree");
  });

  test("end-to-end: strong agreement scores auto_match", () => {
    const a: ComparablePerson = { linkedinPublicId: "li-9", emailBlindIndexHex: "ff00", fullName: "Dana Reed" };
    const b: ComparablePerson = { linkedinPublicId: "li-9", emailBlindIndexHex: "ff00", fullName: "Dana Reed" };
    const r = scoreFellegiSunter(compareRecords(a, b));
    expect(r.disposition).toBe("auto_match");
  });

  test("end-to-end: a strong-key disagreement scores no_match", () => {
    const a: ComparablePerson = { linkedinPublicId: "li-1", emailBlindIndexHex: "aaaa", fullName: "John Smith", companyDomain: "acme.com" };
    const b: ComparablePerson = { linkedinPublicId: "li-2", emailBlindIndexHex: "bbbb", fullName: "Xavier Okonkwo", companyDomain: "globex.com" };
    const r = scoreFellegiSunter(compareRecords(a, b));
    expect(r.disposition).toBe("no_match");
  });
});
