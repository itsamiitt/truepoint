// linkedinUrl.test.ts — the panel's "what am I looking at" parser. Pure, no chrome, no DOM.
//
// Two things here are worth more than the happy path:
//   • the person keys MUST equal the site adapter's `subjectKey()`, because the panel, the hover card and the
//     service worker's caches are all keyed by that string — a mismatch means the panel silently never sees
//     the status broadcast for the profile it is showing (test 4);
//   • `/sales/company/<id>` also contains "/company/", so a naive substring match classifies a Sales-Nav
//     company as a public one and looks up a slug that does not exist (test 3). The same trap bit the
//     server-side composer.

import { describe, expect, it } from "bun:test";
import { linkedinAdapter } from "../content/adapters/linkedin/index.ts";
import { subjectFromUrl } from "./linkedinUrl.ts";

describe("subjectFromUrl", () => {
  it("1. reads a public profile, ignoring tracking params and trailing segments", () => {
    expect(subjectFromUrl("https://www.linkedin.com/in/jane-doe")).toEqual({
      kind: "person",
      subjectKey: "jane-doe",
      sourceUrl: "https://www.linkedin.com/in/jane-doe",
    });
    // The address bar carries far more than the identity; the canonical URL must not.
    expect(
      subjectFromUrl("https://www.linkedin.com/in/jane-doe/recent-activity/all/?trk=nav"),
    ).toEqual({
      kind: "person",
      subjectKey: "jane-doe",
      sourceUrl: "https://www.linkedin.com/in/jane-doe",
    });
  });

  it("2. reads a Sales-Navigator lead (no public slug exists on those pages)", () => {
    expect(subjectFromUrl("https://www.linkedin.com/sales/lead/ACwAAB3u3xU,NAME_SEARCH,fnHM")).toEqual({
      kind: "person",
      subjectKey: "sales-lead:ACwAAB3u3xU",
      sourceUrl: "https://www.linkedin.com/sales/lead/ACwAAB3u3xU",
    });
    expect(subjectFromUrl("https://www.linkedin.com/sales/people/ACwAAB3u3xU")?.subjectKey).toBe(
      "sales-lead:ACwAAB3u3xU",
    );
  });

  it("3. tells a Sales-Nav company from a public one (the /company/ substring trap)", () => {
    // A numeric Sales-Nav id classified as a public slug resolves against the slug identifier table, misses,
    // and the whole Company tab renders empty with nothing thrown.
    expect(subjectFromUrl("https://www.linkedin.com/sales/company/79568557")).toEqual({
      kind: "company",
      subjectKey: "company:79568557",
      sourceUrl: "https://www.linkedin.com/sales/company/79568557",
    });
    expect(subjectFromUrl("https://www.linkedin.com/company/rillet/about/")).toEqual({
      kind: "company",
      subjectKey: "company:rillet",
      sourceUrl: "https://www.linkedin.com/company/rillet",
    });
  });

  it("4. agrees with the content-script adapter on every person key", () => {
    // The panel and the hover card share the SUBJECT_STATUS broadcast and the SW caches, both keyed by this
    // string. If these two ever disagree the panel stops updating for the profile it is displaying — a bug
    // that looks like "the panel is stale", not like a parsing error.
    for (const url of [
      "https://www.linkedin.com/in/jane-doe",
      "https://www.linkedin.com/in/jane-doe/",
      "https://www.linkedin.com/sales/lead/ACwAAB3u3xU,NAME_SEARCH,fnHM",
      "https://www.linkedin.com/sales/people/ACwAAB3u3xU",
    ]) {
      expect(subjectFromUrl(url)?.subjectKey).toBe(linkedinAdapter.subjectKey(new URL(url)) as string);
    }
  });

  it("5. returns null for every page that is not a prospect (the common case)", () => {
    for (const url of [
      "https://www.linkedin.com/feed/",
      "https://www.linkedin.com/search/results/people/?keywords=cfo",
      "https://www.linkedin.com/sales/search/people",
      "https://www.linkedin.com/messaging/thread/123",
      "https://example.com/in/jane-doe", // the path shape alone must never be enough
      "not a url",
      undefined,
      null,
      "",
    ]) {
      expect(subjectFromUrl(url)).toBeNull();
    }
  });

  it("6. accepts LinkedIn subdomains and rejects lookalike hosts", () => {
    expect(subjectFromUrl("https://uk.linkedin.com/in/jane-doe")?.subjectKey).toBe("jane-doe");
    // `notlinkedin.com` must not pass a naive endsWith("linkedin.com") check.
    expect(subjectFromUrl("https://notlinkedin.com/in/jane-doe")).toBeNull();
    expect(subjectFromUrl("https://linkedin.com.evil.test/in/jane-doe")).toBeNull();
  });
});
