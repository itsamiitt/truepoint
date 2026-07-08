// cookies.test.ts — the refresh-cookie DUAL-READ (AUTH-074, readers-first migration to the __Host- prefix).
// Proves both readers prefer the __Host- cookie and fall back to the legacy name during the window, so a session
// set under either name keeps working. Pure string/jar helpers — no next/headers request context needed.

import { describe, expect, it } from "bun:test";
import { readRefreshToken, readRefreshTokenFromHeader } from "./cookies";

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
