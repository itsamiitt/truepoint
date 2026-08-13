import { describe, expect, test } from "bun:test";
import { isNotableOrgKind, orgKindCopy } from "./orgKindCopy";

describe("orgKindCopy", () => {
  test("a school is an institution, not a company", () => {
    expect(orgKindCopy("school")).toEqual({ attributesTitle: "Institution", noun: "school" });
  });

  test("government reads as an agency", () => {
    expect(orgKindCopy("government").noun).toBe("agency");
  });

  test("an UNRESOLVED account falls back to company, not to a hedge", () => {
    // Deliberate: most accounts are companies, and hedging every label to stay correct for the rare
    // school would make the common case read like a machine wrote it.
    expect(orgKindCopy(null)).toEqual(orgKindCopy("company"));
  });

  test("an unknown token cannot crash the drawer", () => {
    expect(orgKindCopy("startup" as never).attributesTitle).toBe("Firmographics");
  });

  test("only a non-company kind is worth calling out", () => {
    expect(isNotableOrgKind("company")).toBe(false);
    expect(isNotableOrgKind(null)).toBe(false);
    expect(isNotableOrgKind("school")).toBe(true);
  });
});
