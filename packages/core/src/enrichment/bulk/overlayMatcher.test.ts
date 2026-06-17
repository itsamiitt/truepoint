// overlayMatcher.test.ts — the overlay MatchPort via a FAKE injected CandidateFinder (no @leadwolf/db, no
// mock.module — pure DI). Covers: deterministic ladder (strongest shared key wins), fuzzy auto-accept vs.
// below-threshold manual review, and the genuine-miss paths. The masterGraphMatcher stub is asserted to fall
// through (unmatched/none) per ADR-0037.

import { describe, expect, test } from "bun:test";
import { buildMatchKeys } from "../matchKeys.ts";
import { createMasterGraphMatcher } from "./masterGraphMatcher.ts";
import type { Candidate, CandidateFinder, MatchContext } from "./matchPort.ts";
import { createOverlayMatcher } from "./overlayMatcher.ts";

const CTX: MatchContext = { workspaceId: "ws-1" };

/** A finder that always returns the given candidates, ignoring the keys (the matcher does the logic). */
const fixedFinder =
  (candidates: Candidate[]): CandidateFinder =>
  () =>
    Promise.resolve(candidates);

describe("createOverlayMatcher — deterministic ladder", () => {
  test("an email-key candidate → deterministic_email / matched_internal / confidence 1.0", async () => {
    const matcher = createOverlayMatcher(
      fixedFinder([{ contactId: "c-1", matchedKeys: ["deterministic_email"], confidence: 1 }]),
      { confidenceThreshold: 0.8 },
    );
    const result = await matcher.matchRow(buildMatchKeys({ email: "a@acme.com" }), CTX);
    expect(result).toEqual({
      method: "deterministic_email",
      outcome: "matched_internal",
      contactId: "c-1",
      masterPersonId: undefined,
      confidence: 1.0,
    });
  });

  test("picks the STRONGEST shared key when several agree (email beats domain)", async () => {
    const matcher = createOverlayMatcher(
      fixedFinder([
        {
          contactId: "c-1",
          matchedKeys: ["deterministic_domain", "deterministic_email"],
          confidence: 1,
        },
      ]),
      { confidenceThreshold: 0.8 },
    );
    const result = await matcher.matchRow(
      buildMatchKeys({ email: "a@acme.com", companyDomain: "acme.com" }),
      CTX,
    );
    expect(result.method).toBe("deterministic_email");
    expect(result.outcome).toBe("matched_internal");
  });

  test("only matches on a key the ROW carries — a candidate's email key is ignored if the row has no email", async () => {
    // Row has only a domain; candidate claims email + domain. The email key cannot apply (row lacks it),
    // so the match falls to deterministic_domain.
    const matcher = createOverlayMatcher(
      fixedFinder([
        {
          contactId: "c-1",
          matchedKeys: ["deterministic_email", "deterministic_domain"],
          confidence: 1,
        },
      ]),
      { confidenceThreshold: 0.8 },
    );
    const result = await matcher.matchRow(buildMatchKeys({ companyDomain: "acme.com" }), CTX);
    expect(result.method).toBe("deterministic_domain");
    expect(result.outcome).toBe("matched_internal");
  });
});

describe("createOverlayMatcher — fuzzy name+company", () => {
  const fuzzyRow = { fullName: "Jane Doe", companyName: "Acme Inc" };

  test("at/above threshold → fuzzy_name_company matched_internal carrying the Splink score", async () => {
    const matcher = createOverlayMatcher(
      fixedFinder([{ contactId: "c-9", matchedKeys: ["fuzzy_name_company"], confidence: 0.92 }]),
      { confidenceThreshold: 0.85 },
    );
    const result = await matcher.matchRow(buildMatchKeys(fuzzyRow), CTX);
    expect(result.method).toBe("fuzzy_name_company");
    expect(result.outcome).toBe("matched_internal");
    expect(result.confidence).toBe(0.92);
    expect(result.needsReview).toBeUndefined();
  });

  test("below threshold → routed to manual review (unmatched + needsReview, NOT billed/merged)", async () => {
    const matcher = createOverlayMatcher(
      fixedFinder([{ contactId: "c-9", matchedKeys: ["fuzzy_name_company"], confidence: 0.6 }]),
      { confidenceThreshold: 0.85 },
    );
    const result = await matcher.matchRow(buildMatchKeys(fuzzyRow), CTX);
    expect(result.method).toBe("fuzzy_name_company");
    expect(result.outcome).toBe("unmatched");
    expect(result.needsReview).toBe(true);
    expect(result.confidence).toBe(0.6);
    expect(result.contactId).toBeUndefined();
  });

  test("a zero-confidence fuzzy is never auto-accepted, even when confidenceThreshold is 0", async () => {
    // confidenceThreshold:0 is valid per the options schema; a 0-confidence "match" is meaningless and must
    // still route to review (0 >= 0 would otherwise auto-merge a non-match). Guards against the boundary.
    const matcher = createOverlayMatcher(
      fixedFinder([{ contactId: "c-9", matchedKeys: ["fuzzy_name_company"], confidence: 0 }]),
      { confidenceThreshold: 0 },
    );
    const result = await matcher.matchRow(buildMatchKeys(fuzzyRow), CTX);
    expect(result.outcome).toBe("unmatched");
    expect(result.needsReview).toBe(true);
    expect(result.contactId).toBeUndefined();
  });

  test("a fuzzy candidate is ignored when the row lacks a name or company facet", async () => {
    const matcher = createOverlayMatcher(
      fixedFinder([{ contactId: "c-9", matchedKeys: ["fuzzy_name_company"], confidence: 0.99 }]),
      { confidenceThreshold: 0.85 },
    );
    // Row has a name but no company → fuzzy cannot apply → genuine miss.
    const result = await matcher.matchRow(buildMatchKeys({ fullName: "Jane Doe" }), CTX);
    expect(result.outcome).toBe("unmatched");
    expect(result.method).toBe("none");
  });
});

describe("createOverlayMatcher — misses", () => {
  test("no candidates → unmatched / none", async () => {
    const matcher = createOverlayMatcher(fixedFinder([]), { confidenceThreshold: 0.8 });
    const result = await matcher.matchRow(buildMatchKeys({ email: "a@acme.com" }), CTX);
    expect(result).toEqual({ method: "none", outcome: "unmatched" });
  });

  test("candidates that share no key the row carries → unmatched / none", async () => {
    // Row has only a phone; candidate only agreed on email → nothing the row holds matches.
    const matcher = createOverlayMatcher(
      fixedFinder([{ contactId: "c-1", matchedKeys: ["deterministic_email"], confidence: 1 }]),
      { confidenceThreshold: 0.8 },
    );
    const result = await matcher.matchRow(buildMatchKeys({ phone: "+14155552671" }), CTX);
    expect(result).toEqual({ method: "none", outcome: "unmatched" });
  });
});

describe("createMasterGraphMatcher (stub, ADR-0037 §5.3)", () => {
  test("always falls through to unmatched / none until the scale infra lands", async () => {
    const matcher = createMasterGraphMatcher();
    const result = await matcher.matchRow(buildMatchKeys({ email: "a@acme.com" }), CTX);
    expect(result).toEqual({ method: "none", outcome: "unmatched" });
  });
});
