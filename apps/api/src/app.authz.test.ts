// app.authz.test.ts — regression guards for the workspace-role authz fix (T-2cc02c62). For the features this
// fix touches (outreach, enrichment, activity, compliance, billing-credits) it proves: (1) PRIVILEGE
// ESCALATION — every protected write in these features rejects a VIEWER (previously any member, even a
// viewer, could write); (2) BILLING EXPOSURE — GET /credits/balance rejects a caller with NO active
// workspace. NOTE: reveal/import/scoring/sales-navigator writes are OUT of this fix's scope and are tracked
// separately (escalated to lead) — this suite does NOT claim to cover them.
//
// authn is mocked to inject claims (no real JWT) and @leadwolf/db is mocked so requireRole's role lookup is
// deterministic without a DB. The handlers never run — requireRole rejects first — so the repo stubs are
// only there to satisfy the route modules' imports. (Mirrors the existing requireRole.test.ts mock style.)

import { beforeEach, describe, expect, it, mock } from "bun:test";
// Real @leadwolf/db (lazy client — no connection at import). Spread into the mock so every export the route
// modules + @leadwolf/core pull in still resolves; only the two methods the guard/handler touch are stubbed.
import * as realDb from "@leadwolf/db";
import type { WorkspaceRole } from "@leadwolf/types";

// Mutable knobs the mocks read on each request.
const SUB = "00000000-0000-0000-0000-000000000001";
const TID = "11111111-1111-1111-1111-111111111111";
const WID = "22222222-2222-2222-2222-222222222222";
let nextClaims: { sub: string; tid: string; wid?: string } = { sub: SUB, tid: TID, wid: WID };
let nextRole: WorkspaceRole | null = "viewer";

// Stub authn: set the verified claims, then continue (the real tenancy middleware derives tenant/workspace).
mock.module("./middleware/authn.ts", () => ({
  authn: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("claims", nextClaims);
    await next();
  },
}));

// Stub @leadwolf/db: requireRole only needs workspaceRepository.getRoleForUser; the rest satisfy imports of
// the route modules (their handlers never execute because the guard rejects first).
mock.module("@leadwolf/db", () => ({
  ...realDb,
  workspaceRepository: { ...realDb.workspaceRepository, getRoleForUser: async () => nextRole },
  creditRepository: { ...realDb.creditRepository, getBalance: async () => 0 },
  revealRepository: { ...realDb.revealRepository, listByWorkspace: async () => [] },
}));

// Import AFTER the mocks are registered so the routers bind to the stubs.
const { Hono } = await import("hono");
const { onError } = await import("./middleware/error.ts");
const { outreachRoutes } = await import("./features/outreach/index.ts");
const { enrichmentRoutes } = await import("./features/enrichment/index.ts");
const { activityRoutes } = await import("./features/activity/index.ts");
const { complianceRoutes, dsarPublicRoutes } = await import("./features/compliance/index.ts");
const { creditsRoutes } = await import("./features/billing/index.ts");

function buildApp() {
  const app = new Hono();
  app.onError(onError);
  app.route("/api/v1/outreach", outreachRoutes);
  app.route("/api/v1/enrichment", enrichmentRoutes);
  app.route("/api/v1/contacts", activityRoutes);
  // DSAR public intake must mount BEFORE the authenticated compliance router (mirrors app.ts).
  app.route("/api/v1/compliance/dsar", dsarPublicRoutes);
  app.route("/api/v1/compliance", complianceRoutes);
  app.route("/api/v1/credits", creditsRoutes);
  return app;
}

const app = buildApp();
const UUID = "33333333-3333-3333-3333-333333333333";

function post(path: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
}

// Every privileged write a viewer must NOT be able to perform.
const PROTECTED_WRITES: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
  ["POST /outreach/sequences", () => post("/api/v1/outreach/sequences")],
  ["POST /outreach/sequences/:id/steps", () => post(`/api/v1/outreach/sequences/${UUID}/steps`)],
  ["POST /outreach/sequences/:id/enroll", () => post(`/api/v1/outreach/sequences/${UUID}/enroll`)],
  ["POST /outreach/log/:id/send", () => post(`/api/v1/outreach/log/${UUID}/send`)],
  ["POST /outreach/log/:id/bounce", () => post(`/api/v1/outreach/log/${UUID}/bounce`)],
  ["POST /enrichment/contact/:id", () => post(`/api/v1/enrichment/contact/${UUID}`)],
  ["POST /contacts/:id/activities", () => post(`/api/v1/contacts/${UUID}/activities`)],
  ["POST /compliance/suppression", () => post("/api/v1/compliance/suppression")],
  [
    "DELETE /compliance/suppression/:id",
    async () =>
      app.request(`/api/v1/compliance/suppression/${UUID}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      }),
  ],
  ["POST /compliance/consent", () => post("/api/v1/compliance/consent")],
  [
    "POST /compliance/consent/:id/withdraw",
    () => post(`/api/v1/compliance/consent/${UUID}/withdraw`),
  ],
];

beforeEach(() => {
  nextClaims = { sub: SUB, tid: TID, wid: WID };
  nextRole = "viewer";
});

describe("privilege escalation: a viewer is rejected on every protected write (T-2cc02c62)", () => {
  for (const [name, fire] of PROTECTED_WRITES) {
    it(`${name} → 403 insufficient_role for a viewer`, async () => {
      nextRole = "viewer";
      const res = await fire();
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toContain("insufficient_role");
    });
  }

  it("a non-member (no role) is also rejected on a write", async () => {
    nextRole = null;
    const res = await post("/api/v1/outreach/sequences");
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("insufficient_role");
  });
});

describe("billing exposure: /credits/balance requires an active workspace (T-2cc02c62)", () => {
  it("a caller with NO selected workspace cannot read the balance", async () => {
    nextClaims = { sub: SUB, tid: TID, wid: undefined };
    const res = await app.request("/api/v1/credits/balance");
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("no_workspace");
  });

  it("a workspace member CAN read the balance (guard allows, not over-restrictive)", async () => {
    nextClaims = { sub: SUB, tid: TID, wid: WID };
    nextRole = "viewer"; // even a viewer may VIEW the balance (read-only pill)
    const res = await app.request("/api/v1/credits/balance");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance: 0 });
  });
});

describe("role-matrix differentials + intentional exclusions (T-2cc02c62)", () => {
  it("a MEMBER is rejected on the admin-only suppression write", async () => {
    nextRole = "member";
    const res = await post("/api/v1/compliance/suppression");
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("insufficient_role");
  });

  it("a MEMBER is rejected on consent-withdraw (admin-only — it mints a global suppression)", async () => {
    nextRole = "member";
    const res = await post(`/api/v1/compliance/consent/${UUID}/withdraw`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("insufficient_role");
  });

  it("a VIEWER may read /credits/usage (read access — the guard allows all roles)", async () => {
    nextClaims = { sub: SUB, tid: TID, wid: WID };
    nextRole = "viewer";
    const res = await app.request("/api/v1/credits/usage");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reveals: [] });
  });

  it("the PUBLIC DSAR intake is NOT role-gated (reaches validation, not a guard rejection)", async () => {
    // Session-less form: no authn/tenancy/requireRole. An empty body fails schema validation (422), which
    // proves the request reached the handler rather than being rejected by an auth/role/workspace guard.
    const res = await post("/api/v1/compliance/dsar");
    expect(res.status).not.toBe(401); // not auth-gated
    expect(res.status).not.toBe(403); // not role/workspace-gated
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("insufficient_role");
    expect(body).not.toContain("no_workspace");
  });
});
