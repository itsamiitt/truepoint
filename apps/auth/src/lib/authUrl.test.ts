// authUrl.test.ts — guards AUTH-062. Every link into the auth app (including one-click email links) MUST
// carry the "/auth" basePath or it 404s. This is the regression test for the forgot-password reset link and
// the magic link that dropped the prefix. If someone builds an auth URL without "/auth" again, this fails.
import { describe, expect, it } from "bun:test";
import { AUTH_BASE_PATH, authUrl } from "./authUrl.ts";

describe("authUrl", () => {
  it("prefixes the /auth basePath on an absolute origin (the reset-link shape)", () => {
    expect(authUrl("https://auth.truepoint.in", "/reset?email=a%40b.com&code=123456")).toBe(
      "https://auth.truepoint.in/auth/reset?email=a%40b.com&code=123456",
    );
  });

  it("prefixes the /auth basePath for the magic-confirm link", () => {
    expect(authUrl("https://auth.truepoint.in", "/magic/confirm?code=x")).toBe(
      "https://auth.truepoint.in/auth/magic/confirm?code=x",
    );
  });

  it("yields a root-relative /auth URL on a single-domain (empty-origin) deploy", () => {
    expect(authUrl("", "/reset")).toBe("/auth/reset");
  });

  it("tolerates a path missing its leading slash", () => {
    expect(authUrl("https://auth.truepoint.in", "reset")).toBe(
      "https://auth.truepoint.in/auth/reset",
    );
  });

  it("always contains the /auth basePath", () => {
    for (const path of ["/reset", "/magic/confirm", "/account/security", "/login"]) {
      expect(authUrl("https://auth.truepoint.in", path)).toContain(`${AUTH_BASE_PATH}/`);
    }
  });
});
