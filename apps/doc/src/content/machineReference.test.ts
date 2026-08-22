// machineReference.test.ts — the generated contract document, held to the same rules as every page.
//
// This file is served to machines and pasted into assistants, which makes it the highest-leverage place on
// the site for a wrong claim to travel: a scraped page misleads one reader, a bad line here gets quoted back
// with confidence for as long as it sits in someone's context window. So the rules the human pages carry —
// availability stated in words, no earned-credit currency, no claim that is not already published — are
// asserted over the generated text rather than trusted to the generator.

import { describe, expect, test } from "bun:test";
import { ENDPOINTS } from "./endpoints/index.ts";
import { buildMachineReference } from "./machineReference.ts";
import { PLANS } from "./pricing.ts";

const DOC = buildMachineReference();

describe("the document is complete", () => {
  test("every endpoint appears with its method, path and worked example", () => {
    for (const endpoint of ENDPOINTS) {
      expect(DOC).toContain(`### ${endpoint.method} ${endpoint.path}`);
      expect(DOC).toContain(endpoint.example.request);
      expect(DOC).toContain(endpoint.example.response);
    }
  });

  test("every parameter, return field and error code is named", () => {
    for (const endpoint of ENDPOINTS) {
      for (const param of endpoint.params) expect(DOC).toContain(param.name);
      for (const field of endpoint.returns) expect(DOC).toContain(field.name);
      for (const error of endpoint.errors) expect(DOC).toContain(error.code);
    }
  });

  test("the connection facts a first call needs are stated", () => {
    expect(DOC).toContain("https://api.truepoint.in/api/v1/public");
    expect(DOC).toContain("Authorization: Bearer");
    expect(DOC).toContain("search:read");
    expect(DOC).toContain("application/problem+json");
  });
});

describe("nothing claims to be live before it is", () => {
  test("every endpoint section states an availability in words, not just a label", () => {
    for (const endpoint of ENDPOINTS) {
      const section = DOC.slice(DOC.indexOf(`### ${endpoint.method} ${endpoint.path}`));
      expect(section).toContain(`availability: ${endpoint.availability}`);
    }
  });

  test("a planned endpoint is spelled out as not callable", () => {
    if (ENDPOINTS.some((endpoint) => endpoint.availability === "planned")) {
      expect(DOC).toContain("NOT callable yet");
    }
    // Plans are all planned today; if that ever changes, this assertion should be revisited rather than
    // deleted — the point is that the file never quotes a price as if it were purchasable.
    expect(PLANS.every((plan) => plan.availability === "planned")).toBe(true);
  });
});

describe("compliance rules the whole site carries (CLAUDE.md rule 7, ADR-0048)", () => {
  const FORBIDDEN: readonly { re: RegExp; why: string }[] = [
    { re: /earn\s+\w*\s*credits?/i, why: "contributor-earned credits" },
    { re: /credits?\s+for\s+(?:each\s+)?contribut/i, why: "credits for contributing" },
    { re: /bounty/i, why: "bounty currency" },
    { re: /reward\s+points?/i, why: "reward points" },
    { re: /sales\s*nav/i, why: "Sales Navigator supply path" },
  ];

  for (const { re, why } of FORBIDDEN) {
    test(`no ${why}`, () => {
      expect(re.test(DOC)).toBe(false);
    });
  }

  test("the erasure route is present — a machine reader must be able to find it too", () => {
    expect(DOC).toContain("privacy@truepoint.in");
  });

  test("it says plainly that keys do not belong in a browser", () => {
    expect(DOC).toContain("Never ship one to a browser");
  });
});

describe("it is safe to prerender", () => {
  test("generation is deterministic — two builds are byte-identical", () => {
    expect(buildMachineReference()).toBe(DOC);
  });

  test("no stray blank-line runs, and it ends with exactly one newline", () => {
    expect(DOC).not.toMatch(/\n{3,}/);
    expect(DOC.endsWith("\n")).toBe(true);
    expect(DOC.endsWith("\n\n")).toBe(false);
  });
});
