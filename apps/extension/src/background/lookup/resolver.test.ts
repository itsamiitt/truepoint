// resolver.test.ts — pins the PII-free payload → (subjectKey, url) reconstruction the SSE consumer relies on.
// The reconstruction must mirror the content-script adapter's subjectKey (a public slug is the key; a Sales-Nav
// lead is `sales-lead:<id>`) or a push would broadcast a status the hover card / panel can't match to its row.
import { describe, expect, test } from "bun:test";
import { subjectFromLookupEvent } from "./resolver.ts";

describe("subjectFromLookupEvent", () => {
  test("public slug → /in/ url + bare-slug subjectKey", () => {
    expect(subjectFromLookupEvent({ linkedinPublicId: "jane-doe", outcome: "landed" })).toEqual({
      subjectKey: "jane-doe",
      sourceUrl: "https://www.linkedin.com/in/jane-doe",
    });
  });

  test("sales-nav lead → /sales/lead/ url + sales-lead: subjectKey", () => {
    expect(subjectFromLookupEvent({ salesNavLeadId: "ACwAAB", outcome: "refreshed" })).toEqual({
      subjectKey: "sales-lead:ACwAAB",
      sourceUrl: "https://www.linkedin.com/sales/lead/ACwAAB",
    });
  });

  test("slug wins when both present (public id is the stronger key)", () => {
    expect(
      subjectFromLookupEvent({ linkedinPublicId: "jane", salesNavLeadId: "X", outcome: "landed" }),
    ).toEqual({ subjectKey: "jane", sourceUrl: "https://www.linkedin.com/in/jane" });
  });

  test("null when neither addressing key is a non-empty string", () => {
    expect(subjectFromLookupEvent({ outcome: "landed" })).toBeNull();
    expect(subjectFromLookupEvent({ linkedinPublicId: "" })).toBeNull();
    expect(subjectFromLookupEvent({ linkedinPublicId: 123 })).toBeNull();
  });
});
