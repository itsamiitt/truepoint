// clientIp.test.ts — proves clientIpFromHeaders resolves the UNSPOOFABLE client IP behind the trusted edge
// proxy (W10/#14). Caddy APPENDS the real client IP to X-Forwarded-For, so the LAST entry is the trustworthy
// one; a client can forge earlier entries but never the final, proxy-added value. The IP gates code-binding
// + brute-force lockout, so reading the first (forgeable) entry would let an attacker evade per-IP throttling.

import { describe, expect, test } from "bun:test";
import { clientIpFromHeaders } from "./clientIp.ts";

const headers = (h: Record<string, string>) => ({
  get: (name: string): string | null => h[name.toLowerCase()] ?? null,
});

describe("clientIpFromHeaders", () => {
  test("a single X-Forwarded-For entry is the client IP", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  test("with several entries it takes the LAST (the trusted proxy appended it), not the first", () => {
    // Caddy turns a client-forged `1.2.3.4` into `1.2.3.4, <real>` — the real IP is last.
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe(
      "203.0.113.7",
    );
  });

  test("a forged leading entry cannot spoof the IP — the appended entry wins", () => {
    const forged = "9.9.9.9, 8.8.8.8, 203.0.113.7";
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": forged }))).toBe("203.0.113.7");
  });

  test("trims surrounding whitespace on the resolved entry", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "1.2.3.4 ,  203.0.113.7  " }))).toBe(
      "203.0.113.7",
    );
  });

  test("falls back to x-real-ip when there is no X-Forwarded-For", () => {
    expect(clientIpFromHeaders(headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  test("falls back to 0.0.0.0 when no proxy header is present", () => {
    expect(clientIpFromHeaders(headers({}))).toBe("0.0.0.0");
  });

  // AUTH-077 — env-driven trusted-hop count. With N trusted hops the client IP is the Nth-from-last entry.
  test("2 hops (CDN + Caddy): the client IP is the SECOND-from-last entry", () => {
    // forged, real-client (added by CDN), cdn-ip (added by Caddy) → real client is 2nd-from-last
    expect(
      clientIpFromHeaders(headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.7, 8.8.8.8" }), 2),
    ).toBe("203.0.113.7");
  });

  test("asking for more hops than there are entries falls back to x-real-ip, never a forgeable entry", () => {
    expect(
      clientIpFromHeaders(
        headers({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.2" }),
        2,
      ),
    ).toBe("198.51.100.2");
  });
});
