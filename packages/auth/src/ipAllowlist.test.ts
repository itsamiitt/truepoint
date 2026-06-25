// ipAllowlist.test.ts — proves the P1-01 Gate C CIDR matcher (ADR-0018). The security ACs this guards
// (../../Authentication plan/09-threat-model.md): match by CIDR NETWORK never string equality, a malformed
// entry fails CLOSED for that entry only (never opens the gate), dual-stack folding (IPv4-mapped IPv6), and an
// empty allowlist imposes no restriction. These run with no DB and no env.
import { describe, expect, it } from "bun:test";
import { ipInCidr, isIpAllowed } from "./ipAllowlist.ts";

describe("ipInCidr — IPv4", () => {
  it("admits a host inside a /24 (network match, not string equality)", () => {
    expect(ipInCidr("203.0.113.250", "203.0.113.0/24")).toBe(true);
  });
  it("rejects a host outside the /24", () => {
    expect(ipInCidr("203.0.114.1", "203.0.113.0/24")).toBe(false);
  });
  it("treats a bare address as a /32 (exact host)", () => {
    expect(ipInCidr("203.0.113.5", "203.0.113.5")).toBe(true);
    expect(ipInCidr("203.0.113.6", "203.0.113.5")).toBe(false);
  });
  it("admits everything under /0", () => {
    expect(ipInCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
  });
  it("matches a /16 boundary correctly", () => {
    expect(ipInCidr("10.5.9.9", "10.5.0.0/16")).toBe(true);
    expect(ipInCidr("10.6.0.1", "10.5.0.0/16")).toBe(false);
  });
});

describe("ipInCidr — IPv4-mapped IPv6 folding (the common false negative)", () => {
  it("folds a candidate ::ffff:a.b.c.d to IPv4 and matches an IPv4 CIDR", () => {
    expect(ipInCidr("::ffff:203.0.113.250", "203.0.113.0/24")).toBe(true);
  });
  it("folds a bracketed/zoned candidate before matching", () => {
    expect(ipInCidr("[::ffff:203.0.113.5]:443", "203.0.113.0/24")).toBe(true);
    expect(ipInCidr("203.0.113.5%eth0", "203.0.113.0/24")).toBe(true);
  });
});

describe("ipInCidr — IPv6", () => {
  it("admits a host inside a /64", () => {
    expect(ipInCidr("2001:db8:abcd:1::beef", "2001:db8:abcd:1::/64")).toBe(true);
  });
  it("rejects a host in a different /64", () => {
    expect(ipInCidr("2001:db8:abcd:2::1", "2001:db8:abcd:1::/64")).toBe(false);
  });
  it("admits a host inside a wide /32", () => {
    expect(ipInCidr("2001:db8:ffff:ffff::1", "2001:db8::/32")).toBe(true);
  });
  it("treats a bare IPv6 address as /128", () => {
    expect(ipInCidr("2001:db8::1", "2001:db8::1")).toBe(true);
    expect(ipInCidr("2001:db8::2", "2001:db8::1")).toBe(false);
  });
});

describe("ipInCidr — family mismatch never matches", () => {
  it("an IPv4 candidate never matches an IPv6 CIDR", () => {
    expect(ipInCidr("203.0.113.5", "2001:db8::/32")).toBe(false);
  });
  it("a real IPv6 candidate never matches an IPv4 CIDR", () => {
    expect(ipInCidr("2001:db8::1", "203.0.113.0/24")).toBe(false);
  });
});

describe("ipInCidr — malformed entries fail CLOSED (never open the gate)", () => {
  for (const bad of [
    "",
    "   ",
    "not-an-ip",
    "203.0.113.0/33", // prefix out of range
    "203.0.113.0/abc", // non-numeric prefix
    "999.0.0.1/24", // octet out of range
    "203.0.113.0/", // empty prefix
    "2001:db8::/129", // v6 prefix out of range
    "2001:db8:::1/64", // malformed v6
  ]) {
    it(`returns false for ${JSON.stringify(bad)}`, () => {
      expect(ipInCidr("203.0.113.5", bad)).toBe(false);
      expect(ipInCidr("2001:db8::1", bad)).toBe(false);
    });
  }
});

describe("isIpAllowed", () => {
  it("empty allowlist imposes no restriction (returns true)", () => {
    expect(isIpAllowed("203.0.113.5", [])).toBe(true);
  });
  it("admits when ANY entry matches", () => {
    expect(isIpAllowed("203.0.113.5", ["198.51.100.0/24", "203.0.113.0/24"])).toBe(true);
  });
  it("rejects when NO entry matches", () => {
    expect(isIpAllowed("8.8.8.8", ["198.51.100.0/24", "203.0.113.0/24"])).toBe(false);
  });
  it("a malformed entry alongside a good one does not open the gate", () => {
    // The malformed entry is skipped; only the real CIDR decides — an out-of-range IP stays rejected.
    expect(isIpAllowed("8.8.8.8", ["garbage", "203.0.113.0/24"])).toBe(false);
    // …and a matching IP is still admitted by the good entry.
    expect(isIpAllowed("203.0.113.9", ["garbage", "203.0.113.0/24"])).toBe(true);
  });
});
