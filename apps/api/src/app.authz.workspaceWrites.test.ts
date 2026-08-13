// app.authz.workspaceWrites.test.ts — proves a VIEWER cannot write on the routers that audit 32 · C2 found
// completely ungated.
//
// The bug this guards: those routers ran authn + tenancy and then nothing. Any authenticated member of the
// workspace — including a viewer, the read-only role — could create and DELETE lists, tags, saved searches,
// pipeline stages and webhook subscriptions, edit custom-field definitions, and author email templates. The
// webhook case was the sharpest: creating a subscription points workspace data at an arbitrary URL, so a
// read-only role could arrange for data to leave continuously.
//
// The sibling suite (app.authz.test.ts) covers the T-2cc02c62 fix for outreach/enrichment/activity/
// compliance/billing. This one covers the routers that fix explicitly did NOT claim.
//
// Same harness as the sibling: authn is stubbed to inject claims and @leadwolf/db is stubbed so the role
// lookup is deterministic. Handlers never execute — the guard rejects first — so the repo stubs exist only
// to satisfy the route modules' imports.

import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as realDb from "@leadwolf/db";
import type { WorkspaceRole } from "@leadwolf/types";

const SUB = "00000000-0000-0000-0000-000000000001";
const TID = "11111111-1111-1111-1111-111111111111";
const WID = "22222222-2222-2222-2222-222222222222";
const UUID = "33333333-3333-3333-3333-333333333333";

let nextRole: WorkspaceRole | null = "viewer";

mock.module("./middleware/authn.ts", () => ({
  authn: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("claims", { sub: SUB, tid: TID, wid: WID });
    await next();
  },
}));

mock.module("@leadwolf/db", () => ({
  ...realDb,
  workspaceRepository: { ...realDb.workspaceRepository, getRoleForUser: async () => nextRole },
}));

const { Hono } = await import("hono");
const { onError } = await import("./middleware/error.ts");
const { listsRoutes } = await import("./features/lists/index.ts");
const { tagsRoutes } = await import("./features/tags/index.ts");
const { savedSearchesRoutes } = await import("./features/saved-searches/index.ts");
const { pipelineStagesRoutes } = await import("./features/pipeline-stages/index.ts");
const { webhooksRoutes } = await import("./features/webhooks/index.ts");
const { customFieldsRoutes } = await import("./features/custom-fields/index.ts");
const { salesNavRoutes } = await import("./features/sales-navigator/index.ts");

const app = new Hono();
app.onError(onError);
app.route("/api/v1/lists", listsRoutes);
app.route("/api/v1/tags", tagsRoutes);
app.route("/api/v1/saved-searches", savedSearchesRoutes);
app.route("/api/v1/pipeline-stages", pipelineStagesRoutes);
app.route("/api/v1/webhooks", webhooksRoutes);
app.route("/api/v1/custom-fields", customFieldsRoutes);
app.route("/api/v1/sales-navigator", salesNavRoutes);

const json = (method: string, body: unknown = {}) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Every write that was reachable by a viewer before the fix. */
const VIEWER_MUST_NOT: ReadonlyArray<readonly [string, string]> = [
  ["POST", "/api/v1/lists"],
  ["POST", "/api/v1/lists/dynamic"],
  ["PATCH", `/api/v1/lists/${UUID}`],
  ["DELETE", `/api/v1/lists/${UUID}`],
  ["POST", `/api/v1/lists/${UUID}/members`],
  ["DELETE", `/api/v1/lists/${UUID}/members`],
  ["POST", "/api/v1/tags"],
  ["PATCH", `/api/v1/tags/${UUID}`],
  ["DELETE", `/api/v1/tags/${UUID}`],
  ["POST", `/api/v1/tags/${UUID}/assign`],
  ["POST", `/api/v1/tags/${UUID}/unassign`],
  ["POST", "/api/v1/saved-searches"],
  ["PATCH", `/api/v1/saved-searches/${UUID}`],
  ["DELETE", `/api/v1/saved-searches/${UUID}`],
  ["POST", "/api/v1/pipeline-stages"],
  ["PATCH", `/api/v1/pipeline-stages/${UUID}`],
  ["POST", `/api/v1/pipeline-stages/contacts/${UUID}/stage`],
  ["POST", "/api/v1/webhooks"],
  ["POST", `/api/v1/webhooks/${UUID}/test`],
  ["DELETE", `/api/v1/webhooks/${UUID}`],
  ["POST", `/api/v1/webhooks/deliveries/${UUID}/replay`],
  ["POST", "/api/v1/custom-fields"],
  ["PATCH", `/api/v1/custom-fields/${UUID}`],
  ["PATCH", `/api/v1/custom-fields/values/contact/${UUID}`],
  ["POST", "/api/v1/sales-navigator/links"],
  ["DELETE", `/api/v1/sales-navigator/links/${UUID}`],
];

describe("a viewer is rejected on every previously-ungated workspace write (audit 32 · C2)", () => {
  beforeEach(() => {
    nextRole = "viewer";
  });

  for (const [method, path] of VIEWER_MUST_NOT) {
    it(`${method} ${path} → 403`, async () => {
      const res = await app.request(path, json(method));
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("insufficient_role");
    });
  }
});

describe("the guards admit the roles that legitimately need them", () => {
  it("a MEMBER may manage lists — ordinary prospecting work, not administration", async () => {
    nextRole = "member";
    const res = await app.request("/api/v1/lists", json("POST", { name: "x" }));
    // Past the guard: whatever the handler then does, it is not a 403.
    expect(res.status).not.toBe(403);
  });

  it("a MEMBER is still refused a webhook subscription — that is data egress, not prospecting", async () => {
    nextRole = "member";
    const res = await app.request("/api/v1/webhooks", json("POST", { url: "https://x.test" }));
    expect(res.status).toBe(403);
  });

  it("an ADMIN may create a webhook subscription", async () => {
    nextRole = "admin";
    const res = await app.request("/api/v1/webhooks", json("POST", { url: "https://x.test" }));
    expect(res.status).not.toBe(403);
  });

  it("a MEMBER is refused a custom-field DEFINITION but allowed to set a VALUE", async () => {
    nextRole = "member";
    expect((await app.request("/api/v1/custom-fields", json("POST"))).status).toBe(403);
    expect(
      (await app.request(`/api/v1/custom-fields/values/contact/${UUID}`, json("PATCH"))).status,
    ).not.toBe(403);
  });
});
