// answer.test.ts — the assistant may only say what the content modules say.
//
// This is the guard that makes a chat surface safe to ship on a compliance-sensitive site. The failure mode
// is not a wrong sentence; it is a sentence nobody reviewed, sitting in a panel that reads as authoritative.
// So: every intent points at a page that exists, no intent publishes a figure the site does not publish
// elsewhere, and the four openers the panel offers all reach a real answer rather than the fallback.

import { describe, expect, test } from "bun:test";
import { ENDPOINTS } from "../../content/endpoints/index.ts";
import { GUIDES } from "../../content/guides/index.ts";
import { SUGGESTIONS, answerFor } from "./answer.ts";
import { INTENTS } from "./intents.ts";

/** Every href the site actually serves that an intent is allowed to cite. */
const ROUTES = new Set<string>([
  "/docs",
  "/docs/playground",
  "/docs/machine-reference",
  "/pricing",
  ...GUIDES.map((guide) => `/docs/${guide.slug}`),
  ...ENDPOINTS.map((endpoint) => `/docs/api/${endpoint.slug}`),
]);

describe("every answer is attributable", () => {
  for (const intent of INTENTS) {
    test(`${intent.id} cites a route that exists`, () => {
      expect(ROUTES.has(intent.href)).toBe(true);
    });

    test(`${intent.id} says something`, () => {
      // Composed answers interpolate content constants; an empty one means a lookup returned undefined and
      // the template collapsed to whitespace, which would ship as a blank bubble rather than as an error.
      expect(intent.answer.trim().length).toBeGreaterThan(40);
    });
  }
});

describe("the assistant publishes no figure the site does not", () => {
  // The design prototype this feature came from answered "600 requests per minute per key" and stamped a
  // frozen contract date. Neither is published anywhere in the content modules — they were environment
  // defaults read out of the service's config. A number that appears ONLY in the assistant is a number no
  // content test covers and no reviewer sees, which is exactly how a docs site starts making commitments.
  const RATE = /\b\d{2,}\s*(?:requests?|reqs?|calls?)\s*(?:per|\/)\s*(?:min|minute|second|hour)/i;
  const NOTICE = /\b\d+\s*(?:days?|weeks?|months?)['’]?\s*(?:of\s+)?(?:advance\s+)?notice/i;
  const UPTIME = /\b9\d\.\d+\s*%/;

  for (const intent of INTENTS) {
    test(`${intent.id} quotes no rate limit, notice period or uptime figure`, () => {
      expect(intent.answer).not.toMatch(RATE);
      expect(intent.answer).not.toMatch(NOTICE);
      expect(intent.answer).not.toMatch(UPTIME);
    });
  }
});

describe("routing", () => {
  test("every suggested opener reaches a written answer, not the fallback", () => {
    for (const suggestion of SUGGESTIONS) {
      expect(answerFor(suggestion).grounded).toBe(true);
    }
  });

  test("a question about people is answered as planned, not as callable", () => {
    const answer = answerFor("can I enrich a contact?");
    expect(answer.grounded).toBe(true);
    expect(answer.text).toContain("planned");
  });

  test("an unrecognised question points at pages instead of inventing one", () => {
    const answer = answerFor("what is your position on webhooks");
    expect(answer.grounded).toBe(false);
  });

  test("a question matching nothing at all still gets the coverage list", () => {
    const answer = answerFor("zzzzqqq");
    expect(answer.grounded).toBe(false);
    expect(answer.links).toEqual([]);
    expect(answer.text).toContain("I answer from this documentation");
  });

  test("an empty question does not crash the panel", () => {
    expect(answerFor("").text.length).toBeGreaterThan(0);
  });
});
