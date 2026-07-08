// cookies.test.ts — the refresh-cookie DUAL-READ (AUTH-074, readers-first migration to the __Host- prefix).
// Proves both readers prefer the __Host- cookie and fall back to the legacy name during the window, so a session
// set under either name keeps working. Pure string/jar helpers — no next/headers request context needed.

import { describe, expect, it } from "bun:test";
import {
  buildClearRefreshCookies,
  buildRefreshSetCookie,
  readRefreshToken,
  readRefreshTokenFromHeader,
} from "./cookies";

describe("readRefreshTokenFromHeader (Cookie-header form)", () => {
  it("prefers the __Host- cookie over the legacy name, in either order", () => {
    expect(readRefreshTokenFromHeader("__Host-lw_refresh=NEW; lw_refresh=OLD")).toBe("NEW");
    expect(readRefreshTokenFromHeader("lw_refresh=OLD; __Host-lw_refresh=NEW")).toBe("NEW");
  });

  it("falls back to the legacy cookie during the migration window", () => {
    expect(readRefreshTokenFromHeader("lw_refresh=OLD")).toBe("OLD");
  });

  it("returns null when neither cookie is present or there is no header", () => {
    expect(readRefreshTokenFromHeader("other=x; foo=y")).toBeNull();
    expect(readRefreshTokenFromHeader(null)).toBeNull();
  });

  it("preserves a token value that itself contains '='", () => {
    expect(readRefreshTokenFromHeader("lw_refresh=a=b=c")).toBe("a=b=c");
  });
});

describe("readRefreshToken (cookies() jar form)", () => {
  const jar = (m: Record<string, string>) => ({
    get: (n: string) => (n in m ? { value: m[n] as string } : undefined),
  });

  it("prefers __Host-, falls back to legacy, undefined when neither", () => {
    expect(readRefreshToken(jar({ "__Host-lw_refresh": "NEW", lw_refresh: "OLD" }))).toBe("NEW");
    expect(readRefreshToken(jar({ lw_refresh: "OLD" }))).toBe("OLD");
    expect(readRefreshToken(jar({}))).toBeUndefined();
  });
});

describe("buildRefreshSetCookie (write flip, AUTH-074)", () => {
  it("legacy write keeps the host-scoped Domain", () => {
    const c = buildRefreshSetCookie(false, "TOK", 100, "auth.truepoint.in");
    expect(c).toContain("lw_refresh=TOK");
    expect(c).toContain("Domain=auth.truepoint.in");
    expect(c).toContain("Secure");
    expect(c).toContain("Path=/");
  });

  it("__Host- write uses the prefix name and OMITS Domain (browser-enforced host-only)", () => {
    const c = buildRefreshSetCookie(true, "TOK", 100, "auth.truepoint.in");
    expect(c).toContain("__Host-lw_refresh=TOK");
    expect(c).not.toContain("Domain=");
    expect(c).toContain("Secure");
    expect(c).toContain("Path=/");
  });
});

describe("buildClearRefreshCookies", () => {
  it("clears BOTH names — __Host- clear has no Domain, legacy clear does", () => {
    const [host, legacy] = buildClearRefreshCookies("auth.truepoint.in");
    expect(host).toContain("__Host-lw_refresh=;");
    expect(host).not.toContain("Domain=");
    expect(legacy).toContain("Domain=auth.truepoint.in");
    expect(host).toContain("Max-Age=0");
    expect(legacy).toContain("Max-Age=0");
  });
});
