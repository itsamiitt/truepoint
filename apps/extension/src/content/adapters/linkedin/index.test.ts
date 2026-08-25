// index.test.ts — unit coverage for the LinkedIn adapter's page detection (chrome-extension/14 site-adapters).
// Pure URL logic, so no chrome/DOM mocks are needed. Runs under `bun test` (the repo's runner).
import { describe, expect, test } from "bun:test";
import { linkedinAdapter } from "./index.ts";

describe("linkedinAdapter — page detection", () => {
  test("matches only linkedin hosts", () => {
    expect(linkedinAdapter.matches(new URL("https://www.linkedin.com/in/jane"))).toBe(true);
    expect(linkedinAdapter.matches(new URL("https://linkedin.com/feed"))).toBe(true);
    expect(linkedinAdapter.matches(new URL("https://example.com/in/jane"))).toBe(false);
    // Guards against a naive `includes("linkedin.com")` (a look-alike host must not match).
    expect(linkedinAdapter.matches(new URL("https://linkedin.com.evil.test/in/jane"))).toBe(false);
  });

  test("classifies profile / company / search / unsupported", () => {
    expect(linkedinAdapter.pageType(new URL("https://www.linkedin.com/in/jane-doe/"))).toBe(
      "profile",
    );
    expect(linkedinAdapter.pageType(new URL("https://www.linkedin.com/company/acme/"))).toBe(
      "company",
    );
    expect(
      linkedinAdapter.pageType(new URL("https://www.linkedin.com/search/results/people/")),
    ).toBe("search");
    expect(linkedinAdapter.pageType(new URL("https://www.linkedin.com/feed/"))).toBe("unsupported");
  });

  // CLAUDE.md rule 4, third clause: no "capture of email/message body content". The content script is
  // injected across ALL of linkedin.com/*, so messaging pages sit inside its reach, and the only thing
  // keeping it out of them is that `pageType` classifies them `unsupported` and every reader early-returns on
  // that. Correct design, pinned by nothing: the existing coverage names /feed/, which is not where message
  // bodies live.
  //
  // The Document handed in below THROWS on any property access, which makes these assertions stronger than
  // "returned nothing" — they prove the adapter never LOOKS at the page. A future `extract` that read the
  // conversation thread before deciding it was out of scope would fail here even if it discarded what it read.
  const explodingDoc = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`the adapter touched document.${String(prop)} on an out-of-scope page`);
      },
    },
  ) as unknown as Document;

  const OUT_OF_SCOPE = [
    "https://www.linkedin.com/messaging/thread/2-abc123==/",
    "https://www.linkedin.com/messaging/",
    "https://www.linkedin.com/mynetwork/invitation-manager/",
    "https://www.linkedin.com/notifications/",
    "https://www.linkedin.com/feed/update/urn:li:activity:7/",
  ];

  test("messaging and other private surfaces are unsupported, and the DOM is never read there", () => {
    for (const href of OUT_OF_SCOPE) {
      const url = new URL(href);
      expect(linkedinAdapter.pageType(url)).toBe("unsupported");
      expect(linkedinAdapter.extract(url, explodingDoc)).toBeNull();
      expect(linkedinAdapter.harvestLinks?.(url, explodingDoc) ?? []).toEqual([]);
    }
  });

  test("the URL harvest is confined to Sales-Nav list pages", () => {
    // harvest() is the one automatic (non-gesture) collection path in the extension — decisions.md #11 — so
    // which pages can trigger it IS its blast radius. A profile page must not harvest even though it is a
    // supported page, and the exploding Document proves it does not scan for anchors before deciding.
    for (const href of [
      "https://www.linkedin.com/in/jane-doe/",
      "https://www.linkedin.com/company/acme/",
      "https://www.linkedin.com/search/results/people/",
    ]) {
      const url = new URL(href);
      expect(linkedinAdapter.harvestLinks?.(url, explodingDoc) ?? []).toEqual([]);
    }
  });

  test("subjectKey is the decoded /in/<publicId> slug, and null off-profile", () => {
    expect(linkedinAdapter.subjectKey(new URL("https://www.linkedin.com/in/jane-doe-8a1b/"))).toBe(
      "jane-doe-8a1b",
    );
    expect(linkedinAdapter.subjectKey(new URL("https://www.linkedin.com/in/jos%C3%A9/"))).toBe(
      "josé",
    );
    expect(
      linkedinAdapter.subjectKey(new URL("https://www.linkedin.com/company/acme/")),
    ).toBeNull();
    expect(linkedinAdapter.subjectKey(new URL("https://www.linkedin.com/feed/"))).toBeNull();
  });
});
