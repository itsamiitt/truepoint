// cookies.test.ts — the refresh-cookie DUAL-READ (AUTH-074, readers-first migration to the __Host- prefix).
// Proves both readers prefer the __Host- cookie and fall back to the legacy name during the window, so a session
// set under either name keeps working. Pure string/jar helpers — no next/headers request context needed.

import { describe, expect, it } from "bun:test";
import {
  AppError,
  ConcurrentRotationError,
  ForbiddenError,
  InvalidTokenError,
} from "@leadwolf/types";
import {
  buildClearRefreshCookies,
  buildRefreshSetCookie,
  readRefreshToken,
  readRefreshTokenFromHeader,
  shouldClearRefreshCookie,
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

// ── shouldClearRefreshCookie ──────────────────────────────────────────────────────────────────────────────
// The regression guard for the browser-wide sign-out. ONE host-scoped refresh cookie serves app./admin./forge,
// but the client's anti-stampede rotation election is localStorage-backed and therefore per-origin — so two of
// those apps open at once routinely rotate the same cookie simultaneously. The loser presented a token the
// winner had replaced milliseconds earlier, /token/refresh mapped that to a plain InvalidTokenError, and its
// handler CLEARED the cookie: when that 401 landed after the winner's 200, the browser dropped the one cookie
// all three apps share and the user was signed out everywhere. If someone collapses ConcurrentRotationError
// back into InvalidTokenError, or re-broadens the predicate, these fail.
describe("shouldClearRefreshCookie", () => {
  it("does NOT clear on a concurrent rotation — the session is alive and the cookie already holds the winner", () => {
    expect(shouldClearRefreshCookie(new ConcurrentRotationError())).toBe(false);
  });

  it("clears on a genuinely invalid/expired/replayed token", () => {
    expect(shouldClearRefreshCookie(new InvalidTokenError())).toBe(true);
  });

  it("does NOT clear on a 403 — the user simply may not enter that workspace/org; the session stands", () => {
    expect(shouldClearRefreshCookie(new ForbiddenError("workspace_forbidden"))).toBe(false);
  });

  it("does NOT clear on an unrelated AppError or a non-error value", () => {
    expect(
      shouldClearRefreshCookie(new AppError({ status: 500, code: "boom", title: "Boom" })),
    ).toBe(false);
    expect(shouldClearRefreshCookie(new Error("network"))).toBe(false);
    expect(shouldClearRefreshCookie(null)).toBe(false);
    expect(shouldClearRefreshCookie(undefined)).toBe(false);
  });

  it("keeps ConcurrentRotationError wire-compatible: still an InvalidTokenError, still 401 invalid_token", () => {
    // Subclassing is load-bearing. Every existing `instanceof InvalidTokenError` branch (the switch routes, the
    // extension refresh route) must keep treating this as a token rejection, and the RESPONSE the client sees
    // must be byte-identical — clients' silent-refresh recovery keys on that shape. Only the cookie differs.
    const err = new ConcurrentRotationError();
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_token");
  });
});
