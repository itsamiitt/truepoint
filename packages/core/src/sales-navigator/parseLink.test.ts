// parseLink.test.ts — unit tests for the pure Sales Navigator URL parser (05 §5, M7). IO-free; runs in the
// default `bun test`. Covers id extraction, type inference, the comma-suffix strip, non-Sales-Nav fallbacks,
// and graceful handling of unrecognized / invalid URLs.

import { describe, expect, test } from "bun:test";
import { parseSalesNavLink } from "./parseLink.ts";

describe("parseSalesNavLink", () => {
  test("extracts the lead id from /sales/lead/<id> and strips the comma suffix", () => {
    const r = parseSalesNavLink("https://www.linkedin.com/sales/lead/ACwAAABcDeF123,NAME_SEARCH");
    expect(r.salesNavLeadId).toBe("ACwAAABcDeF123");
    expect(r.inferredType).toBe("profile");
  });

  test("infers account for /sales/company/<id> and keeps the id", () => {
    const r = parseSalesNavLink("https://www.linkedin.com/sales/company/55555");
    expect(r.salesNavLeadId).toBe("55555");
    expect(r.inferredType).toBe("account");
  });

  test("infers saved_search / lead_list / inmail with no id", () => {
    expect(parseSalesNavLink("https://www.linkedin.com/sales/search/people?x=1").inferredType).toBe(
      "saved_search",
    );
    expect(parseSalesNavLink("https://www.linkedin.com/sales/lists/people/42").inferredType).toBe(
      "lead_list",
    );
    expect(
      parseSalesNavLink("https://www.linkedin.com/sales/messaging/thread/9").inferredType,
    ).toBe("inmail_thread");
    expect(
      parseSalesNavLink("https://www.linkedin.com/sales/search/people").salesNavLeadId,
    ).toBeNull();
  });

  test("falls back to a plain public profile slug as a weak id", () => {
    const r = parseSalesNavLink("https://www.linkedin.com/in/jane-doe-12345/");
    expect(r.inferredType).toBe("profile");
    expect(r.salesNavLeadId).toBe("jane-doe-12345");
  });

  test("a query string after the slug does not pollute the id", () => {
    const r = parseSalesNavLink("https://www.linkedin.com/sales/people/XYZ789?foo=bar#frag");
    expect(r.salesNavLeadId).toBe("XYZ789");
    expect(r.inferredType).toBe("profile");
  });

  test("an unrecognized but valid URL yields no id and no inferred type", () => {
    const r = parseSalesNavLink("https://example.com/whatever");
    expect(r.salesNavLeadId).toBeNull();
    expect(r.inferredType).toBeNull();
  });

  test("a non-LinkedIn host with a sales-nav-looking path is NOT parsed (no bogus dedup id)", () => {
    // Without host-restriction these would yield "123"/"abc" and falsely dedup unrelated links.
    expect(parseSalesNavLink("https://evil.example.com/sales/lead/123").salesNavLeadId).toBeNull();
    expect(parseSalesNavLink("https://example.com/linkedin.com/in/abc").salesNavLeadId).toBeNull();
    expect(parseSalesNavLink("https://example.com/sales/lead/123").inferredType).toBeNull();
  });

  test("a linkedin.com subdomain (www) is accepted", () => {
    expect(parseSalesNavLink("https://www.linkedin.com/sales/lead/Z9").salesNavLeadId).toBe("Z9");
    // A look-alike host that merely ends in the brand but isn't the real eTLD+1 is rejected.
    expect(
      parseSalesNavLink("https://linkedin.com.evil.com/sales/lead/Z9").salesNavLeadId,
    ).toBeNull();
  });

  test("an invalid URL is handled gracefully (nulls, no throw)", () => {
    const r = parseSalesNavLink("not a url");
    expect(r.salesNavLeadId).toBeNull();
    expect(r.inferredType).toBeNull();
  });
});
