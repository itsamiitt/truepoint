// extensionScope.test.ts — guards AUTH-065. An extension-scoped token must be confined to the prospecting
// allow-list; a web/admin token (scope:[]) must NEVER be treated as extension-scoped (that would break every
// non-extension caller). Matching must be method-aware and exact (no prefix escalation).
import { describe, expect, it } from "bun:test";
import {
  EXTENSION_SCOPE,
  extensionRouteAllowed,
  extensionScopeViolationLog,
  isExtensionToken,
} from "./extensionScope.ts";

describe("isExtensionToken", () => {
  it("is true only when the scope claim carries 'extension'", () => {
    expect(isExtensionToken({ scope: [EXTENSION_SCOPE] })).toBe(true);
    expect(isExtensionToken({ scope: ["extension", "read"] })).toBe(true);
  });
  it("is false for a web/admin token (scope:[]) — never restricted", () => {
    expect(isExtensionToken({ scope: [] })).toBe(false);
    expect(isExtensionToken({ scope: ["billing"] })).toBe(false);
  });
});

describe("extensionRouteAllowed", () => {
  it("allows exactly the routes the extension calls", () => {
    expect(extensionRouteAllowed("POST", "/api/v1/ingest")).toBe(true);
    expect(extensionRouteAllowed("POST", "/api/v1/contacts/abc-123/reveal")).toBe(true);
    expect(extensionRouteAllowed("GET", "/api/v1/contacts/abc-123")).toBe(true);
    expect(extensionRouteAllowed("GET", "/api/v1/credits/balance")).toBe(true);
    expect(extensionRouteAllowed("GET", "/api/v1/credits/reveal-costs")).toBe(true);
    expect(extensionRouteAllowed("GET", "/api/v1/me")).toBe(true);
    expect(extensionRouteAllowed("GET", "/api/v1/orgs")).toBe(true);
  });

  it("is method-aware (an allowed path with the wrong verb is denied)", () => {
    expect(extensionRouteAllowed("DELETE", "/api/v1/contacts/abc-123")).toBe(false);
    expect(extensionRouteAllowed("POST", "/api/v1/me")).toBe(false);
    expect(extensionRouteAllowed("GET", "/api/v1/ingest")).toBe(false);
  });

  it("denies the rest of the tenant API (the AUTH-065 hole)", () => {
    for (const [m, p] of [
      ["POST", "/api/v1/imports"],
      ["GET", "/api/v1/admin/tenants"],
      ["POST", "/api/v1/billing/checkout"],
      ["GET", "/api/v1/contacts"], // list is NOT on the allow-list (only a single captured contact)
      ["POST", "/api/v1/contacts/abc/reveal/../../admin"], // no prefix/traversal escalation
    ] as const) {
      expect(extensionRouteAllowed(m, p)).toBe(false);
    }
  });

  it("ignores a query string and is case-insensitive on the verb", () => {
    expect(extensionRouteAllowed("get", "/api/v1/credits/balance?ts=1")).toBe(true);
  });
});

describe("extensionScopeViolationLog", () => {
  it("emits the alertable prefix + mode + method/path, and strips the query", () => {
    const line = extensionScopeViolationLog("post", "/api/v1/imports?x=1", "denied");
    expect(line).toStartWith("[authz] extension-scope denied");
    expect(line).toContain("method=POST");
    expect(line).toContain("path=/api/v1/imports");
    expect(line).not.toContain("x=1");
  });
});
