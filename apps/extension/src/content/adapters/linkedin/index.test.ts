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
    expect(linkedinAdapter.pageType(new URL("https://www.linkedin.com/in/jane-doe/"))).toBe("profile");
    expect(linkedinAdapter.pageType(new URL("https://www.linkedin.com/company/acme/"))).toBe("company");
    expect(linkedinAdapter.pageType(new URL("https://www.linkedin.com/search/results/people/"))).toBe(
      "search",
    );
    expect(linkedinAdapter.pageType(new URL("https://www.linkedin.com/feed/"))).toBe("unsupported");
  });

  test("subjectKey is the decoded /in/<publicId> slug, and null off-profile", () => {
    expect(linkedinAdapter.subjectKey(new URL("https://www.linkedin.com/in/jane-doe-8a1b/"))).toBe(
      "jane-doe-8a1b",
    );
    expect(linkedinAdapter.subjectKey(new URL("https://www.linkedin.com/in/jos%C3%A9/"))).toBe("josé");
    expect(linkedinAdapter.subjectKey(new URL("https://www.linkedin.com/company/acme/"))).toBeNull();
    expect(linkedinAdapter.subjectKey(new URL("https://www.linkedin.com/feed/"))).toBeNull();
  });
});
