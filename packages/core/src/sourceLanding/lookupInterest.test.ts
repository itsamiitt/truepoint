// lookupInterest.test.ts — pins the pure encoding + payload mapping the sweep and /lookup share. The URL
// parsing itself is linkedinUrlKey's contract (tested there); here we only assert the person→field mapping,
// the company/unrecognized → null drop, and the member round-trip.
import { describe, expect, test } from "bun:test";
import {
  lookupInterestKey,
  lookupInterestMember,
  lookupUpdatedPayload,
  parseLookupInterestMember,
} from "./lookupInterest.ts";

describe("lookupInterest", () => {
  test("member round-trips tenant + workspace", () => {
    const m = lookupInterestMember("t-1", "w-2");
    expect(m).toBe("t-1:w-2");
    expect(parseLookupInterestMember(m)).toEqual({ tenantId: "t-1", workspaceId: "w-2" });
  });

  test("parse rejects malformed members (empty half / wrong arity)", () => {
    expect(parseLookupInterestMember("nope")).toBeNull();
    expect(parseLookupInterestMember(":w")).toBeNull();
    expect(parseLookupInterestMember("t:")).toBeNull();
    expect(parseLookupInterestMember("a:b:c")).toBeNull();
  });

  test("key is namespaced by the canonical url", () => {
    expect(lookupInterestKey("https://www.linkedin.com/in/jane")).toBe(
      "lookup:interested:https://www.linkedin.com/in/jane",
    );
  });

  test("payload carries the public slug for an /in/ url", () => {
    expect(lookupUpdatedPayload("https://www.linkedin.com/in/jane-doe", "landed")).toEqual({
      linkedinPublicId: "jane-doe",
      outcome: "landed",
    });
  });

  test("payload carries the lead id (not a slug) for a sales-nav person url", () => {
    const p = lookupUpdatedPayload(
      "https://www.linkedin.com/sales/lead/ACwAABUtWTAB8fphT-VDuOX6vRdiejVCxdAU4tk,NAME_SEARCH,fnHM",
      "refreshed",
    );
    expect(p?.salesNavLeadId).toBeTruthy();
    expect(p?.linkedinPublicId).toBeUndefined();
    expect(p?.outcome).toBe("refreshed");
  });

  test("payload is null for a company url (person-only card today)", () => {
    expect(
      lookupUpdatedPayload("https://www.linkedin.com/sales/company/12345", "landed"),
    ).toBeNull();
  });

  test("payload is null for an unrecognized url", () => {
    expect(lookupUpdatedPayload("https://example.com/foo", "landed")).toBeNull();
  });
});
