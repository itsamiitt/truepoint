// effectivePolicyRoutes.test.ts — drives the REAL /security/effective-policy routes through
// settingsRoutes.request() with authn/tenancy/requireOrgRole mocked to pass through and effectivePolicyRepository
// mocked to return a controlled platform floor. The RESOLVER + the write guard (resolvePolicyFromRows,
// validatePolicyWrite from @leadwolf/auth) run for REAL, so this proves the endpoint's security orchestration:
// the platform-default floor is computed from platform rows only, a loosening write is 403'd, a bad key/value is
// 422'd, and a valid tightening write reaches upsertTenantKey. No DB — @leadwolf/db is spread from the real
// (lazy) module and effectivePolicyRepository overridden (mirrors app.authz.test.ts).

import { describe, expect, it, mock } from "bun:test";
import * as realDb from "@leadwolf/db";

// authn / tenancy / requireOrgRole: pass through, stash the tenant + actor so the handlers proceed.
mock.module("../../middleware/authn.ts", () => ({
  authn: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("claims", { sub: "u1", tid: "t1" });
    await next();
  },
}));
mock.module("../../middleware/tenancy.ts", () => ({
  tenancy: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("tenantId", "t1");
    await next();
  },
}));
mock.module("../../middleware/requireOrgRole.ts", () => ({
  requireOrgRole: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

// The platform floor the repository returns: mfa_enforcement = "optional" (so "required" is a valid tighten and
// "off" is a below-floor loosen). upsertTenantKey is spied.
const upserts: Array<Record<string, unknown>> = [];
// Controls the no-lockout guard: what the org's SSO connection looks like for a require_sso write.
let ssoConfig: { enabled: boolean; protocol: "oidc" | "saml" } | null = null;

mock.module("@leadwolf/db", () => ({
  ...realDb,
  effectivePolicyRepository: {
    getScopeRows: async () => [
      { scope: "platform", workspaceId: null, key: "mfa_enforcement", value: "optional" },
    ],
    upsertTenantKey: async (args: Record<string, unknown>) => {
      upserts.push(args);
    },
  },
  ssoConfigRepository: {
    getForTenant: async () => ssoConfig,
  },
}));

const { Hono } = await import("hono");
const { onError } = await import("../../middleware/error.ts");
const { settingsRoutes } = await import("./routes.ts");

// Mount under an app carrying the RFC-9457 error handler (onError lives on the root app, not the sub-router), so
// a thrown ValidationError/ForbiddenError maps to 422/403 instead of a bare 500.
const app = new Hono();
app.onError(onError);
app.route("/", settingsRoutes);

const put = (body: unknown) =>
  app.request("/security/effective-policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /security/effective-policy", () => {
  it("returns the resolved effective policy (platform default composed over the code floor)", async () => {
    const res = await app.request("/security/effective-policy");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mfaEnforcement: string };
    expect(body.mfaEnforcement).toBe("optional");
  });
});

describe("PUT /security/effective-policy", () => {
  it("accepts a valid tightening write and calls upsertTenantKey (200)", async () => {
    upserts.length = 0;
    const res = await put({ key: "mfa_enforcement", value: "required" });
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      tenantId: "t1",
      scope: "org",
      key: "mfa_enforcement",
      value: "required",
      actorUserId: "u1",
    });
  });

  it("rejects a value that loosens below the platform floor (403), without writing", async () => {
    upserts.length = 0;
    const res = await put({ key: "mfa_enforcement", value: "off" }); // off < optional
    expect(res.status).toBe(403);
    expect(upserts).toHaveLength(0);
  });

  it("rejects an unknown key (422)", async () => {
    const res = await put({ key: "not_a_real_key", value: 1 });
    expect(res.status).toBe(422);
  });

  it("rejects a malformed value for a known key (422)", async () => {
    const res = await put({ key: "mfa_enforcement", value: "banana" });
    expect(res.status).toBe(422);
  });

  it("rejects a body missing the key (422)", async () => {
    const res = await put({ value: "required" });
    expect(res.status).toBe(422);
  });

  // No-lockout guard (AUTH-031): require_sso=true must not be enable-able without a working SSO connection.
  it("rejects require_sso=true when the org has NO SSO connection (403), without writing", async () => {
    ssoConfig = null;
    upserts.length = 0;
    const res = await put({ key: "require_sso", value: true });
    expect(res.status).toBe(403);
    expect(upserts).toHaveLength(0);
  });

  it("rejects require_sso=true when the SSO connection is DISABLED (403)", async () => {
    ssoConfig = { enabled: false, protocol: "saml" };
    upserts.length = 0;
    const res = await put({ key: "require_sso", value: true });
    expect(res.status).toBe(403);
    expect(upserts).toHaveLength(0);
  });

  it("allows require_sso=true when the connection is enabled + wired (200)", async () => {
    ssoConfig = { enabled: true, protocol: "saml" }; // test env → mock provider → wired
    upserts.length = 0;
    const res = await put({ key: "require_sso", value: true });
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(1);
  });

  it("allows DISABLING require_sso regardless of connection state (200)", async () => {
    ssoConfig = null;
    upserts.length = 0;
    const res = await put({ key: "require_sso", value: false });
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(1);
  });
});
