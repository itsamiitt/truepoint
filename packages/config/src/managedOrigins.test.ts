// managedOrigins.test.ts — guards AUTH-036. The effective callback allow-list must be env-floor ∪ managed with
// the floor immovable (fail-safe), exact-match membership (open-redirect guard), and a write-time validator that
// refuses anything but a bare https origin so a stored entry can never become an open-redirect target.
import { describe, expect, it } from "bun:test";
import { canonicalManagedOrigin, isOriginAllowed, resolveAllowedOrigins } from "./managedOrigins.ts";

const FLOOR = ["https://app.truepoint.in", "https://admin.truepoint.in"];

describe("resolveAllowedOrigins", () => {
  it("unions floor + managed, floor first, deduped", () => {
    expect(resolveAllowedOrigins(FLOOR, ["https://acme.com", "https://app.truepoint.in"])).toEqual([
      "https://app.truepoint.in",
      "https://admin.truepoint.in",
      "https://acme.com",
    ]);
  });
  it("floor is preserved even when managed is empty", () => {
    expect(resolveAllowedOrigins(FLOOR, [])).toEqual(FLOOR);
  });
});

describe("isOriginAllowed (exact match, floor immovable)", () => {
  it("allows a floor origin regardless of managed config", () => {
    expect(isOriginAllowed("https://app.truepoint.in", FLOOR, [])).toBe(true);
  });
  it("allows a managed origin", () => {
    expect(isOriginAllowed("https://acme.com", FLOOR, ["https://acme.com"])).toBe(true);
  });
  it("rejects an unknown origin, a substring/prefix, and null (open-redirect guard)", () => {
    expect(isOriginAllowed("https://evil.example", FLOOR, ["https://acme.com"])).toBe(false);
    expect(isOriginAllowed("https://app.truepoint.in.evil.com", FLOOR, [])).toBe(false);
    expect(isOriginAllowed("https://app.truepoint.in/callback", FLOOR, [])).toBe(false);
    expect(isOriginAllowed(null, FLOOR, [])).toBe(false);
  });
});

describe("canonicalManagedOrigin (write-time validator)", () => {
  it("accepts + canonicalises a bare https origin (drops a trailing slash)", () => {
    expect(canonicalManagedOrigin("https://acme.com")).toBe("https://acme.com");
    expect(canonicalManagedOrigin("https://acme.com/")).toBe("https://acme.com");
    expect(canonicalManagedOrigin("https://acme.com:8443")).toBe("https://acme.com:8443");
  });

  it("rejects anything that could become an open-redirect / exfil target", () => {
    for (const bad of [
      "http://acme.com", // not https
      "https://acme.com/callback", // has a path
      "https://acme.com?x=1", // query
      "https://acme.com#f", // fragment
      "https://user:pass@acme.com", // credentials
      "https://*.acme.com", // wildcard host
      "javascript:alert(1)", // non-http scheme
      "not a url",
      "",
    ]) {
      expect(canonicalManagedOrigin(bad)).toBeNull();
    }
  });
});
