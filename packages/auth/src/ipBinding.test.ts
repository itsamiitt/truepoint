// ipBinding.test.ts — proves the cross-domain code's IP-binding policy (ADR-0016 addendum): normalization
// folds the dual-stack representations that would otherwise false-mismatch, and the three modes behave as
// documented. This is the security knob that, set too strict, breaks legitimate dual-stack logins.
import { describe, expect, it } from "bun:test";
import { clientIpMatches, normalizeIp } from "./ipBinding.ts";

describe("normalizeIp", () => {
  it("folds an IPv4-mapped IPv6 address to its IPv4 form", () => {
    expect(normalizeIp("::ffff:203.0.113.5")).toBe("203.0.113.5");
  });
  it("strips IPv6 brackets and a :port", () => {
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
  });
  it("drops an IPv6 zone id and lower-cases", () => {
    expect(normalizeIp("FE80::1%eth0")).toBe("fe80::1");
  });
  it("trims surrounding whitespace", () => {
    expect(normalizeIp("  203.0.113.5 ")).toBe("203.0.113.5");
  });
});

describe("clientIpMatches", () => {
  it("off → always matches, even across networks", () => {
    expect(clientIpMatches("203.0.113.5", "198.51.100.9", "off")).toBe(true);
  });

  describe("strict (normalized exact)", () => {
    it("matches identical addresses", () => {
      expect(clientIpMatches("203.0.113.5", "203.0.113.5", "strict")).toBe(true);
    });
    it("matches an IPv4 against its IPv4-mapped IPv6 form (the common false negative)", () => {
      expect(clientIpMatches("203.0.113.5", "::ffff:203.0.113.5", "strict")).toBe(true);
    });
    it("rejects a different host in the same network", () => {
      expect(clientIpMatches("203.0.113.5", "203.0.113.6", "strict")).toBe(false);
    });
  });

  describe("prefix (same network)", () => {
    it("matches IPv4 hosts in the same /24", () => {
      expect(clientIpMatches("203.0.113.5", "203.0.113.250", "prefix")).toBe(true);
    });
    it("rejects IPv4 hosts in a different /24", () => {
      expect(clientIpMatches("203.0.113.5", "203.0.114.5", "prefix")).toBe(false);
    });
    it("matches IPv6 hosts in the same /64", () => {
      expect(clientIpMatches("2001:db8:abcd:1::1", "2001:db8:abcd:1::beef", "prefix")).toBe(true);
    });
    it("rejects IPv6 hosts in a different /64", () => {
      expect(clientIpMatches("2001:db8:abcd:1::1", "2001:db8:abcd:2::1", "prefix")).toBe(false);
    });
    it("rejects across address families (a true dual-stack flip — needs 'off')", () => {
      expect(clientIpMatches("203.0.113.5", "2001:db8::1", "prefix")).toBe(false);
    });
  });
});
