import { describe, expect, test } from "bun:test";
import { linkedinUrlKey, salesNavProfileUrl } from "./linkedinUrlKey.ts";

describe("linkedinUrlKey — canonicalize all URL forms of one entity to one key", () => {
  test("public /in/<slug> is the canonical person key", () => {
    expect(linkedinUrlKey("https://www.linkedin.com/in/william-gates-cpa-770a1842")).toEqual({
      entityKind: "person",
      normalizedUrl: "https://www.linkedin.com/in/william-gates-cpa-770a1842",
      externalId: "william-gates-cpa-770a1842",
    });
  });

  test("trailing slash / query / locale host collapse to the same person key", () => {
    const a = linkedinUrlKey("https://www.linkedin.com/in/jane-doe/");
    const b = linkedinUrlKey("https://in.linkedin.com/in/jane-doe?trk=abc");
    expect(a?.normalizedUrl).toBe("https://www.linkedin.com/in/jane-doe");
    expect(a).toEqual(b);
  });

  test("a sales-nav lead URL with no embedded slug keys on the lead id", () => {
    const k = linkedinUrlKey("https://www.linkedin.com/sales/lead/ACwAAA0suOU,NAME_SEARCH,x325");
    expect(k).toEqual({
      entityKind: "person",
      normalizedUrl: salesNavProfileUrl("ACwAAA0suOU"),
      externalId: "ACwAAA0suOU",
    });
  });

  test("a numeric sales-nav company id → the sales-nav company URL", () => {
    expect(linkedinUrlKey("https://www.linkedin.com/sales/company/296229")).toEqual({
      entityKind: "company",
      normalizedUrl: "https://www.linkedin.com/sales/company/296229",
      externalId: "296229",
    });
  });

  test("a public /company/<slug> keys on the slug", () => {
    expect(linkedinUrlKey("https://www.linkedin.com/company/antheminc/")).toEqual({
      entityKind: "company",
      normalizedUrl: "https://www.linkedin.com/company/antheminc",
      externalId: "antheminc",
    });
  });

  test("search / list / messaging / non-LinkedIn URLs are not fetch targets", () => {
    expect(linkedinUrlKey("https://www.linkedin.com/sales/search/people?query=x")).toBeNull();
    expect(linkedinUrlKey("https://www.linkedin.com/sales/lists/people/123")).toBeNull();
    expect(linkedinUrlKey("https://www.linkedin.com/feed/")).toBeNull();
    expect(linkedinUrlKey("https://example.com/in/not-linkedin")).toBeNull();
    expect(linkedinUrlKey("not a url")).toBeNull();
  });
});
