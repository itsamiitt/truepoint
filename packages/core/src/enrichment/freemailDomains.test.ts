// freemailDomains.test.ts — companyDomainKey is the COMPANY-side ER key: the pure PSL eTLD+1 reduction UNLESS the
// result is a freemail/role domain, in which case undefined (the free-mail veto that stops gmail.com minting a
// "Gmail Inc." company — PLAN_02_affiliation_edge §1.4, F4). Fast, pure, no DB. Covers the veto, the real-company
// pass-through across email/URL/multi-part-eTLD inputs, the empty/undefined guards, and a few more freemail hosts.

import { describe, expect, test } from "bun:test";
import { companyDomainKey } from "./freemailDomains.ts";

describe("companyDomainKey", () => {
  test("vetoes a freemail mailbox — no company key", () => {
    expect(companyDomainKey("jane@gmail.com")).toBeUndefined();
  });

  test("passes a real company domain through, from a URL or an email", () => {
    expect(companyDomainKey("https://acme.com")).toBe("acme.com");
    expect(companyDomainKey("jane@acme.com")).toBe("acme.com");
  });

  test("reduces a multi-part eTLD to the registrable domain", () => {
    expect(companyDomainKey("jane@mail.corp.co.uk")).toBe("corp.co.uk");
  });

  test("undefined / empty input → undefined", () => {
    expect(companyDomainKey(undefined)).toBeUndefined();
    expect(companyDomainKey("")).toBeUndefined();
  });

  test("vetoes other common freemail hosts too", () => {
    expect(companyDomainKey("jane@outlook.com")).toBeUndefined();
    expect(companyDomainKey("jane@yahoo.com")).toBeUndefined();
  });
});
