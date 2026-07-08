// providers.test.ts — the SSO no-lockout predicate (AUTH-031). require_sso must not be enable-able unless a
// tenant's SSO connection is enabled AND its provider is wired — else forcing SSO with a throwing-stub adapter
// locks everyone out. Pure logic; the production "unwired stub" branch is env-gated (WIRED_PROD_PROTOCOLS) and
// exercised in CI/prod config, not here (the test env is non-production → the mock IdP, always wired).
import { describe, expect, it } from "bun:test";
import { isSsoProviderWired, ssoReadyForEnforcement } from "./providers.ts";

describe("isSsoProviderWired (non-production → mock IdP)", () => {
  it("reports both protocols wired under the mock", () => {
    expect(isSsoProviderWired("oidc")).toBe(true);
    expect(isSsoProviderWired("saml")).toBe(true);
  });
});

describe("ssoReadyForEnforcement — no-lockout predicate", () => {
  it("is false when the org has NO SSO config", () => {
    expect(ssoReadyForEnforcement(null)).toBe(false);
  });

  it("is false when the SSO config exists but is DISABLED", () => {
    expect(ssoReadyForEnforcement({ enabled: false, protocol: "saml" })).toBe(false);
    expect(ssoReadyForEnforcement({ enabled: false, protocol: "oidc" })).toBe(false);
  });

  it("is true when enabled AND the provider is wired (non-prod mock)", () => {
    expect(ssoReadyForEnforcement({ enabled: true, protocol: "saml" })).toBe(true);
    expect(ssoReadyForEnforcement({ enabled: true, protocol: "oidc" })).toBe(true);
  });
});
