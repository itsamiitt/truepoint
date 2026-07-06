// authLink.test.ts — guards AUTH-062 on the app side. The SecurityPanel deep links into the auth origin's
// /account/security screen, which serves under the "/auth" basePath. If a link drops "/auth" it 404s and the
// user has no working path to change their password / manage MFA / sessions / history. This locks the shape.
import { describe, expect, it } from "bun:test";
import { AUTH_BASE_PATH, authSecurityUrl } from "./authLink.ts";

describe("authSecurityUrl", () => {
  it("prefixes the /auth basePath and appends the section anchor", () => {
    expect(authSecurityUrl("https://auth.truepoint.in", "password")).toBe(
      "https://auth.truepoint.in/auth/account/security#password",
    );
  });

  it("omits the anchor when no section is given", () => {
    expect(authSecurityUrl("https://auth.truepoint.in")).toBe(
      "https://auth.truepoint.in/auth/account/security",
    );
  });

  it("yields a root-relative /auth URL on a single-domain (empty-origin) deploy", () => {
    expect(authSecurityUrl("", "mfa")).toBe("/auth/account/security#mfa");
  });

  it("always contains /auth/account/security for every section", () => {
    for (const section of ["password", "mfa", "sessions", "history"]) {
      expect(authSecurityUrl("https://auth.truepoint.in", section)).toContain(
        `${AUTH_BASE_PATH}/account/security`,
      );
    }
  });
});
